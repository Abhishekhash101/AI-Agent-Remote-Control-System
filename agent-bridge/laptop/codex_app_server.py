"""Small JSON-RPC client for the local Codex App Server process."""

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
        self.start()
        result = self.request("thread/start", {"cwd": str(cwd)}, timeout=60)
        thread = result.get("thread") or {}
        self.thread_id = thread.get("id")
        if not self.thread_id:
            raise RuntimeError("Codex started without returning a thread ID")
        return {"threadId": self.thread_id, "cwd": str(cwd)}

    def pending_approvals(self):
        with self.state_lock:
            return list(self.pending_server_requests.values())

    def send_message(self, text):
        if not self.thread_id:
            raise RuntimeError("Start a Codex thread before sending a message")
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

