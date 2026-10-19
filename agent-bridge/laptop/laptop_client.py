import os
import shutil
import sys
import threading
import time
from pathlib import Path

import pyautogui
import socketio
from codex_app_server import CodexAppServer

SERVER_URL = "https://agentbridge-server.onrender.com"

sio = socketio.Client(
    reconnection=True,
    reconnection_attempts=0,
    reconnection_delay=1,
    reconnection_delay_max=60,
    randomization_factor=0.5,
    logger=False,
    engineio_logger=False,
)

session_id = None
project_root = Path(__file__).resolve().parent.parent
codex_app = None
codex_lock = threading.Lock()
codex_thread_starting = False
pyautogui_lock = threading.Lock()
PROMPT_PIPE_FILE = Path("/tmp/agentbridge_prompt")

ALLOWED_COMMANDS = {
    "ENTER": "enter",
    "SPACE": "space",
    "ESC": "esc",
    "BACKSPACE": "backspace",
}
ALLOWED_KEYS = {
    "enter": "enter", "space": "space", "esc": "esc", "backspace": "backspace",
    "tab": "tab", "delete": "delete", "insert": "insert", "up": "up", "down": "down",
    "left": "left", "right": "right", "home": "home", "end": "end",
    "pageup": "pageup", "pagedown": "pagedown", "shift": "shift", "ctrl": "ctrl",
    "alt": "alt", "win": "win", "capslock": "capslock", "numlock": "numlock",
    "pause": "pause", "printscreen": "printscreen",
    **{f"f{i}": f"f{i}" for i in range(1, 13)},
}
held_modifiers = set()
held_mouse_buttons = set()


# ── Safe emit: never crashes if socket is disconnected ───────────────────────

def safe_emit(event, data):
    """Emit only when the socket is actually connected. Prints a warning otherwise."""
    try:
        if sio.connected:
            sio.emit(event, data)
        else:
            pass
    except Exception as err:
        print(f"[emit error] {event}: {err}")


# ── Socket events ────────────────────────────────────────────────────────────

@sio.event
def connect():
    print("Connected to AgentBridge server.")
    sio.emit("create-session", {"sessionId": session_id})


@sio.event
def connect_error(data):
    if isinstance(data, Exception):
        message = repr(data)
    elif isinstance(data, dict):
        message = data.get("message") or str(data)
    else:
        message = str(data)
    print("Connection failed:", message)


@sio.event
def disconnect(reason=None):
    print("Disconnected from server:", reason)
    release_modifiers()


@sio.on("session-created")
def session_created(data):
    global session_id
    session_id = data["sessionId"]
    print("\n" + "=" * 58)
    print("  ✅ Session created!")
    print(f"  🔑 Session ID: {session_id}  (enter this on your phone)")
    print("  ⚡ Bi-directional Codex is active")
    print("=" * 58 + "\n")
    # Auto-initialize Codex so it is immediately ready
    threading.Thread(target=start_codex_thread, daemon=True).start()


@sio.on("phone-connected")
def phone_connected():
    print("\n📱 Phone connected! Bi-way synchronization is active.\n")
    if codex_app and codex_app.thread_id:
        safe_emit("codex-thread-ready", {"sessionId": session_id, "threadId": codex_app.thread_id, "cwd": codex_app.cwd})
        messages = codex_app.read_history()
        safe_emit("codex-history", {
            "sessionId": session_id,
            "messages": messages,
            "busy": bool(codex_app.active_turn_id),
        })


@sio.on("execute-command")
def execute_command(data):
    command = data.get("command")
    if command not in ALLOWED_COMMANDS:
        return
    try:
        with pyautogui_lock:
            pyautogui.press(ALLOWED_COMMANDS[command])
    except Exception as error:
        print("Could not execute command:", repr(error))


@sio.on("execute-pointer")
def execute_pointer(data):
    action = data.get("action")
    screen_width, screen_height = pyautogui.size()
    if action == "scroll":
        amount = data.get("amount", 0)
        if isinstance(amount, (int, float)):
            with pyautogui_lock:
                pyautogui.scroll(-int(amount) * 60)
        return

    x = data.get("x")
    y = data.get("y")
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return

    point = (int(x * screen_width), int(y * screen_height))
    try:
        with pyautogui_lock:
            if action == "click":
                pyautogui.click(*point)
            elif action == "down":
                pyautogui.moveTo(*point, _pause=False)
                pyautogui.mouseDown(*point)
                held_mouse_buttons.add("left")
            elif action == "up":
                pyautogui.moveTo(*point, _pause=False)
                pyautogui.mouseUp(*point)
                held_mouse_buttons.discard("left")
            elif action == "right-click":
                pyautogui.click(*point, button="right")
            elif action == "double-click":
                pyautogui.doubleClick(*point)
            else:
                pyautogui.moveTo(*point, _pause=False)
    except Exception as error:
        print("Could not execute pointer input:", repr(error))


@sio.on("execute-key")
def execute_key(data):
    key = data.get("key")
    action = data.get("action", "press")
    if key not in ALLOWED_KEYS or action not in {"press", "down", "up"}:
        return
    if action != "press" and key not in {"shift", "ctrl", "alt", "win"}:
        return
    try:
        with pyautogui_lock:
            if action == "down":
                pyautogui.keyDown(ALLOWED_KEYS[key])
                held_modifiers.add(key)
            elif action == "up":
                pyautogui.keyUp(ALLOWED_KEYS[key])
                held_modifiers.discard(key)
            else:
                pyautogui.press(ALLOWED_KEYS[key])
    except Exception as error:
        print("Could not execute key:", repr(error))


@sio.on("execute-text")
def execute_text(data):
    text = data.get("text", "")
    if not isinstance(text, str) or len(text) > 500:
        return
    try:
        with pyautogui_lock:
            pyautogui.write(text, interval=0)
    except Exception as error:
        print("Could not type text:", repr(error))


@sio.on("phone-disconnected")
def phone_disconnected():
    print("\n📱 Phone disconnected.")
    release_modifiers()


def release_modifiers():
    with pyautogui_lock:
        for key in tuple(held_modifiers):
            try:
                pyautogui.keyUp(ALLOWED_KEYS[key])
            except Exception:
                pass
            held_modifiers.discard(key)
        for button in tuple(held_mouse_buttons):
            try:
                pyautogui.mouseUp(button=button)
            except Exception:
                pass
            held_mouse_buttons.discard(button)


# ── Codex Handlers ───────────────────────────────────────────────────────────

def emit_codex_event(payload):
    if session_id:
        safe_emit("codex-event", {"sessionId": session_id, "event": payload})


def emit_codex_approval(payload):
    if session_id:
        safe_emit("codex-approval", {"sessionId": session_id, **payload})


def emit_codex_error(message):
    msg = str(message)[:1000]
    print("\n[Codex error]", msg)
    if session_id:
        safe_emit("codex-error", {"sessionId": session_id, "message": msg})


def handle_codex_notification(payload):
    """Forward event to phone AND print live status on laptop terminal."""
    emit_codex_event(payload)

    method = payload.get("method")
    params = payload.get("params") or {}

    if method == "item/started":
        item = params.get("item") or {}
        itype = item.get("type")
        if itype == "commandExecution":
            cmd = item.get("command", "")
            print(f"\n⚙️  [Process Running]: $ {cmd}")
        elif itype == "fileChange":
            desc = item.get("description") or (
                f"Modifying {list(item.get('files', {}).keys())}" if item.get("files") else "Modifying files..."
            )
            print(f"\n📄 [File Change]: {desc}")
        elif itype == "webSearch":
            print(f"\n🌐 [Web Search]: {item.get('query', '')}")
        elif itype == "agentMessage":
            print("\n🤖 [Codex]: ", end="", flush=True)

    elif method == "item/agentMessage/delta":
        delta = params.get("delta", "")
        sys.stdout.write(delta)
        sys.stdout.flush()

    elif method == "item/commandExecution/outputDelta":
        delta = params.get("delta", "")
        sys.stdout.write(delta)
        sys.stdout.flush()

    elif method == "item/completed":
        item = params.get("item") or {}
        if item.get("type") == "commandExecution":
            code = item.get("exitCode", 0)
            print(f"\n✓ Process finished (exit {code})")

    elif method == "turn/completed":
        print("\n\n✓ Turn complete.")
        print("[Laptop Codex] > ", end="", flush=True)


def handle_codex_approval(payload):
    """Forward approval request to phone AND show on laptop terminal."""
    emit_codex_approval(payload)
    params = payload.get("params") or {}
    detail = params.get("command") or params.get("reason") or payload.get("method")
    print(f"\n⚠️  [Approval Required]: {detail}")
    print("   👉 Approve or Decline on phone, or type 'approve' / 'decline' here.")
    print("[Laptop Codex] > ", end="", flush=True)


def start_codex_thread():
    global codex_app, codex_thread_starting
    with codex_lock:
        if codex_thread_starting:
            return
        codex_thread_starting = True
    try:
        codex_bin = shutil.which("codex")
        if not codex_bin:
            emit_codex_error("codex binary not found in PATH.")
            return

        with codex_lock:
            if codex_app is None:
                codex_app = CodexAppServer(
                    on_notification=handle_codex_notification,
                    on_approval=handle_codex_approval,
                    on_error=emit_codex_error,
                )
            adapter = codex_app

        result = adapter.start_thread(project_root)
        print("⚡ Codex thread ready:", result.get("threadId"))

        safe_emit("codex-thread-ready", {"sessionId": session_id, **result})

        messages = adapter.read_history()
        safe_emit("codex-history", {
            "sessionId": session_id,
            "messages": messages,
            "busy": bool(adapter.active_turn_id),
        })
    except Exception as error:
        emit_codex_error(error)
    finally:
        with codex_lock:
            codex_thread_starting = False


@sio.on("codex-start")
def codex_start(data):
    if not session_id or data.get("sessionId") != session_id:
        return
    print("📱 Phone requested Codex start.")
    threading.Thread(target=start_codex_thread, daemon=True).start()


@sio.on("codex-send")
def codex_send(data):
    text = data.get("text")
    if (not session_id or data.get("sessionId") != session_id
            or not isinstance(text, str) or not text.strip() or len(text) > 12000):
        return
    adapter = codex_app
    if not adapter or not adapter.thread_id:
        emit_codex_error("Start a Codex thread before sending a message.")
        return
    print(f"\n📱 [Phone sent prompt]: {text.strip()}")
    threading.Thread(target=_send_codex_message, args=(adapter, text.strip()), daemon=True).start()


def _send_codex_message(adapter, text):
    try:
        adapter.send_message(text)
        safe_emit("codex-turn-accepted", {"sessionId": session_id})
    except Exception as error:
        emit_codex_error(error)


@sio.on("codex-approval-decision")
def codex_approval_decision(data):
    if not session_id or data.get("sessionId") != session_id:
        return
    adapter = codex_app
    if not adapter:
        return
    try:
        adapter.respond_to_approval(
            data.get("requestId"), data.get("method"), data.get("decision")
        )
        print(f"\n📱 Phone responded to approval: {data.get('decision')}")
    except Exception as error:
        emit_codex_error(error)


# ── Interactive Terminal Input (Laptop -> Codex & Phone) ────────────────────

def send_laptop_prompt(text):
    """Send a prompt typed directly on this laptop to Codex & broadcast to phone."""
    global codex_app
    with codex_lock:
        adapter = codex_app

    if not adapter or not adapter.thread_id:
        print("[Initializing Codex thread... please wait a few seconds]")
        start_codex_thread()
        with codex_lock:
            adapter = codex_app

    if not adapter or not adapter.thread_id:
        print("[Error: Codex is not ready yet. Please try again in 5 seconds.]")
        return

    # 1. Inform phone of this laptop prompt so it renders in chat immediately
    safe_emit("codex-event", {
        "sessionId": session_id,
        "event": {
            "method": "codex/user-prompt",
            "params": {"text": text, "source": "laptop"},
        },
    })

    # 2. Dispatch to Codex process
    threading.Thread(target=_send_codex_message, args=(adapter, text), daemon=True).start()


def terminal_input_loop():
    """CLI loop enabling the laptop user to type prompts directly in this terminal."""
    time.sleep(2)
    print("\n" + "-" * 58)
    print("  💬 BI-DIRECTIONAL CODEX TERMINAL READY")
    print("  Type prompts here on laptop OR send from your phone.")
    print("  All running processes and output sync live in both places!")
    print("  (Type 'approve'/'decline' if approval is requested)")
    print("-" * 58)

    while True:
        try:
            line = input("[Laptop Codex] > ").strip()
            if not line:
                continue

            # Check if user typed quick approval
            if line.lower() in {"y", "yes", "approve"} and codex_app:
                pending = codex_app.pending_approvals()
                if pending:
                    req = pending[0]
                    codex_app.respond_to_approval(req["requestId"], req["method"], "accept")
                    print("✓ Approved from laptop terminal.")
                    continue

            if line.lower() in {"n", "no", "decline"} and codex_app:
                pending = codex_app.pending_approvals()
                if pending:
                    req = pending[0]
                    codex_app.respond_to_approval(req["requestId"], req["method"], "decline")
                    print("❌ Declined from laptop terminal.")
                    continue

            if line.lower() in {"exit", "quit"}:
                print("To stop the client, press Ctrl+C.")
                continue

            send_laptop_prompt(line)

        except (EOFError, KeyboardInterrupt):
            break
        except Exception as error:
            print("Terminal input error:", repr(error))


def file_pipe_watcher_loop():
    """Allows sending prompts from ANY other terminal by writing to /tmp/agentbridge_prompt."""
    try:
        PROMPT_PIPE_FILE.unlink(missing_ok=True)
    except Exception:
        pass

    while True:
        try:
            if PROMPT_PIPE_FILE.exists():
                text = PROMPT_PIPE_FILE.read_text(encoding="utf-8").strip()
                PROMPT_PIPE_FILE.unlink(missing_ok=True)
                if text:
                    print(f"\n💻 [Prompt from external terminal]: {text}")
                    send_laptop_prompt(text)
        except Exception:
            pass
        time.sleep(0.5)


# ── Connection with retry ────────────────────────────────────────────────────

def _connect_with_retry():
    INITIAL_WAIT = 5
    MAX_WAIT     = 60
    MAX_ATTEMPTS = 10
    wait    = INITIAL_WAIT
    attempt = 0
    while True:
        try:
            sio.connect(SERVER_URL, transports=["websocket"], wait_timeout=30)
            return
        except Exception as error:
            attempt += 1
            error_text = repr(error)
            if "RemoteDisconnected" in error_text or "transport error" in error_text:
                print(f"Server waking up (attempt {attempt}/{MAX_ATTEMPTS}). Retrying in {wait}s...")
            else:
                print(f"Connection attempt {attempt}/{MAX_ATTEMPTS} failed: {error_text}")
            if attempt >= MAX_ATTEMPTS:
                raise RuntimeError(
                    f"Could not connect after {MAX_ATTEMPTS} attempts."
                ) from error
            time.sleep(wait)
            wait = min(wait * 2, MAX_WAIT)


if __name__ == "__main__":
    try:
        # Start background threads for local CLI prompt and external pipe listener
        threading.Thread(target=terminal_input_loop, daemon=True).start()
        threading.Thread(target=file_pipe_watcher_loop, daemon=True).start()

        _connect_with_retry()
        sio.wait()
    except KeyboardInterrupt:
        print("\nStopping client...")
        sio.disconnect()
    except Exception as error:
        print("Error:", repr(error))
    finally:
        if codex_app:
            codex_app.stop()
        try:
            PROMPT_PIPE_FILE.unlink(missing_ok=True)
        except Exception:
            pass
