"""Small JSON-RPC client for the local Codex App Server process."""

import hashlib
import json
import queue
import subprocess
import threading
from pathlib import Path


class CodexAppServer:
    def __init__(self, on_notification, on_approval, on_error):
        self.on_notification = on_notification
        self.on_approval = on_approval
        self.on_error = on_error
        self.process = None
        self.thread_id = None
        self.cwd = None
        self.active_turn_id = None
        self.next_id = 0
        self.pending = {}
        self.pending_server_requests = {}
        self.state_lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.start_lock = threading.Lock()
        self.initialized = False
        self.reader = None

    def start(self):
        with self.start_lock:
            if self.initialized and self.process and self.process.poll() is None:
                return
            self.process = subprocess.Popen(
                ["codex", "app-server", "--stdio"],
                cwd=Path(__file__).resolve().parent.parent,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
            self.initialized = False
            self.reader = threading.Thread(target=self._read_stdout, daemon=True)
            self.reader.start()
            threading.Thread(target=self._read_stderr, daemon=True).start()
            try:
                self.request("initialize", {
                    "clientInfo": {
                        "name": "agent_bridge",
                        "title": "Agent Bridge",
                        "version": "0.1.0",
                    }
                }, timeout=30)
                self.notify("initialized", {})
                self.initialized = True
            except Exception:
                self.stop()
                raise

    def start_thread(self, cwd):
        was_running = self.initialized and self.process and self.process.poll() is None
        self.start()
        self.cwd = str(cwd)
        if self.thread_id and was_running:
            return {"threadId": self.thread_id, "cwd": self.cwd}
        saved_thread_id = self.thread_id or self._load_saved_thread_id(self.cwd)
        if saved_thread_id:
            try:
                result = self.request("thread/resume", {"threadId": saved_thread_id}, timeout=60)
                thread = result.get("thread") or {}
                self.thread_id = thread.get("id") or saved_thread_id
                return {"threadId": self.thread_id, "cwd": self.cwd}
            except Exception as error:
                self.on_error(f"Could not resume saved Codex thread; starting a new thread: {error}")

        result = self.request("thread/start", {"cwd": self.cwd}, timeout=60)
        thread = result.get("thread") or {}
        self.thread_id = thread.get("id")
        if not self.thread_id:
            raise RuntimeError("Codex started without returning a thread ID")
        self._save_thread_id(self.cwd, self.thread_id)
        return {"threadId": self.thread_id, "cwd": self.cwd}

    def read_history(self):
        if not self.thread_id:
            return []
        self.active_turn_id = None
        try:
            latest_turns = self.request("thread/turns/list", {
                "threadId": self.thread_id,
                "sortDirection": "desc",
                "limit": 1,
                "itemsView": "notLoaded",
            }, timeout=60).get("data", [])
            self.active_turn_id = next(
                (turn.get("id") for turn in latest_turns if turn.get("status") == "inProgress"),
                None,
            )
            entries = []
            cursor = None
            while True:
                params = {"threadId": self.thread_id, "sortDirection": "asc", "limit": 100}
                if cursor:
                    params["cursor"] = cursor
                page = self.request("thread/items/list", params, timeout=60)
                entries.extend(page.get("data", []))
                next_cursor = page.get("nextCursor")
                if not next_cursor or next_cursor == cursor:
                    break
                cursor = next_cursor
        except Exception:
            # Older App Server builds may not expose paginated history yet.
            result = self.request("thread/read", {"threadId": self.thread_id, "includeTurns": True}, timeout=60)
            thread = result.get("thread") or {}
            entries = []
            for turn in thread.get("turns") or []:
                if turn.get("status") == "inProgress":
                    self.active_turn_id = turn.get("id")
                entries.extend({"item": item, "turnId": turn.get("id")} for item in turn.get("items") or [])

        history = []
        for entry in entries:
            item = entry.get("item") or {}
            item_type = item.get("type")
            item_id = str(item.get("id") or f"{entry.get('turnId', 'turn')}-{len(history)}")
            if item_type == "userMessage":
                text = "\n".join(
                    part.get("text", "") for part in item.get("content", [])
                    if part.get("type") in {"text", "input_text"} and isinstance(part.get("text"), str)
                ).strip()
                if text:
                    history.append({"id": f"user-{item_id}", "role": "user", "text": text})
            elif item_type == "agentMessage" and isinstance(item.get("text"), str) and item["text"].strip():
                history.append({"id": f"assistant-{item_id}", "role": "assistant", "text": item["text"]})
            elif item_type == "commandExecution":
                command = item.get("command", "")
                output = item.get("aggregatedOutput") or ""
                detail = f"$ {command}" if command else "Command"
                if output:
                    detail = f"{detail}\n{output}"
                history.append({"id": f"tool-{item_id}", "role": "tool", "text": detail})
        return history

    def pending_approvals(self):
        with self.state_lock:
            return list(self.pending_server_requests.values())

    def send_message(self, text):
        if not self.thread_id:
            raise RuntimeError("Start a Codex thread before sending a message")
        if self.active_turn_id:
            return self.request("turn/steer", {
                "threadId": self.thread_id,
                "expectedTurnId": self.active_turn_id,
                "input": [{"type": "text", "text": text}],
            }, timeout=60)
        return self.request("turn/start", {
            "threadId": self.thread_id,
            "input": [{"type": "text", "text": text}],
        }, timeout=60)

    def respond_to_approval(self, request_id, method, decision):
        allowed = {"accept", "acceptForSession", "decline", "cancel"}
        if method not in {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
        } or decision not in allowed:
            raise ValueError("Unsupported Codex approval response")
        with self.state_lock:
            pending = self.pending_server_requests.pop(str(request_id), None)
        if not pending or pending.get("method") != method:
            raise ValueError("That approval is no longer pending")
        self._send({"id": request_id, "result": {"decision": decision}})

    def request(self, method, params, timeout=30):
        with self.state_lock:
            self.next_id += 1
            request_id = self.next_id
            response_queue = queue.Queue(maxsize=1)
            self.pending[request_id] = response_queue
        self._send({"id": request_id, "method": method, "params": params})
        try:
            response = response_queue.get(timeout=timeout)
        except queue.Empty as error:
            with self.state_lock:
                self.pending.pop(request_id, None)
            raise TimeoutError(f"Codex App Server timed out during {method}") from error
        if "error" in response:
            message = response["error"].get("message", "Codex App Server request failed")
            raise RuntimeError(message)
        return response.get("result", {})

    def notify(self, method, params):
        self._send({"method": method, "params": params})

    def _send(self, message):
        process = self.process
        if not process or process.poll() is not None or not process.stdin:
            raise RuntimeError("Codex App Server is not running")
        encoded = json.dumps(message, separators=(",", ":"))
        with self.write_lock:
            process.stdin.write(encoded + "\n")
            process.stdin.flush()

    def _read_stdout(self):
        process = self.process
        try:
            for line in process.stdout:
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "id" in message and ("result" in message or "error" in message):
                    with self.state_lock:
                        response_queue = self.pending.pop(message["id"], None)
                    if response_queue:
                        response_queue.put(message)
                elif "id" in message and "method" in message:
                    self._handle_server_request(message)
                elif message.get("method"):
                    self._track_turn(message)
                    self.on_notification(message)
        except Exception as error:
            self.on_error(f"Codex App Server reader failed: {error}")
        finally:
            with self.state_lock:
                pending = list(self.pending.values())
                self.pending.clear()
            for response_queue in pending:
                response_queue.put({"error": {"message": "Codex App Server stopped"}})
            if process.poll() is not None:
                self.on_error(f"Codex App Server exited with code {process.returncode}")

    def _track_turn(self, message):
        method = message.get("method")
        params = message.get("params") or {}
        if method == "turn/started":
            turn = params.get("turn") or {}
            self.active_turn_id = turn.get("id")
        elif method == "turn/completed":
            turn = params.get("turn") or {}
            if not self.active_turn_id or turn.get("id") == self.active_turn_id:
                self.active_turn_id = None

    @staticmethod
    def _thread_metadata_path(cwd):
        key = hashlib.sha256(cwd.encode("utf-8")).hexdigest()
        return Path.home() / ".agentbridge" / "codex-threads" / f"{key}.json"

    @classmethod
    def _load_saved_thread_id(cls, cwd):
        try:
            metadata = json.loads(cls._thread_metadata_path(cwd).read_text(encoding="utf-8"))
            return metadata.get("threadId")
        except (OSError, json.JSONDecodeError, AttributeError):
            return None

    @classmethod
    def _save_thread_id(cls, cwd, thread_id):
        path = cls._thread_metadata_path(cwd)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = path.with_suffix(".tmp")
        temporary_path.write_text(json.dumps({"cwd": cwd, "threadId": thread_id}), encoding="utf-8")
        temporary_path.replace(path)

    def _read_stderr(self):
        process = self.process
        if not process or not process.stderr:
            return
        for line in process.stderr:
            if line.strip():
                print("Codex App Server:", line.strip())

    def _handle_server_request(self, message):
        method = message["method"]
        request_id = message["id"]
        if method not in {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
        }:
            self._send({
                "id": request_id,
                "error": {"code": -32601, "message": f"Unsupported App Server request: {method}"},
            })
            return
        payload = {
            "requestId": request_id,
            "method": method,
            "params": message.get("params", {}),
        }
        with self.state_lock:
            self.pending_server_requests[str(request_id)] = payload
        self.on_approval(payload)

    def stop(self):
        process = self.process
        self.process = None
        if not process or process.poll() is not None:
            return
        try:
            process.stdin.close()
            process.terminate()
            process.wait(timeout=5)
        except Exception:
            process.kill()

