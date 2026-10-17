
import shutil
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
            print(f"[offline] could not emit '{event}' – socket not connected")
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
    print("\nSession created!")
    print("Session ID:", session_id)
    print("Waiting for phone commands...")


@sio.on("phone-connected")
def phone_connected():
    print("Phone connected!")
    if codex_app:
        threading.Thread(target=start_codex_thread, daemon=True).start()
        for approval in codex_app.pending_approvals():
            emit_codex_approval(approval)


@sio.on("execute-command")
def execute_command(data):
    command = data.get("command", "").upper()
    if command not in ALLOWED_COMMANDS:
        print("Blocked unknown command:", command)
        return
    try:
        with pyautogui_lock:
            pyautogui.press(ALLOWED_COMMANDS[command])
        print("Executed command:", command)
    except Exception as error:
        print("Could not execute command:", repr(error))


@sio.on("execute-pointer")
def execute_pointer(data):
    action = data.get("action")
    if action == "scroll":
        amount = data.get("amount")
        if isinstance(amount, int) and -10 <= amount <= 10:
            try:
                with pyautogui_lock:
                    pyautogui.scroll(amount)
            except Exception as error:
                print("Could not execute scroll:", repr(error))
        return
    x, y = data.get("x"), data.get("y")
    if action not in {"move", "down", "up", "click", "right-click", "double-click"} \
            or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return
    try:
        with pyautogui_lock:
            width, height = pyautogui.size()
            point = (
                round(max(0, min(1, x)) * (width - 1)),
                round(max(0, min(1, y)) * (height - 1)),
            )
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


# ── Codex helpers ────────────────────────────────────────────────────────────

def emit_codex_event(payload):
    if session_id:
        safe_emit("codex-event", {"sessionId": session_id, "event": payload})


def emit_codex_approval(payload):
    if session_id:
        safe_emit("codex-approval", {"sessionId": session_id, **payload})


def emit_codex_error(message):
    msg = str(message)[:1000]
    print("[Codex error]", msg)
    if session_id:
        safe_emit("codex-error", {"sessionId": session_id, "message": msg})


def start_codex_thread():
    global codex_app, codex_thread_starting
    with codex_lock:
        if codex_thread_starting:
            return
        codex_thread_starting = True
    try:
        # Check that the codex binary actually exists before attempting to start
        codex_bin = shutil.which("codex")
        if not codex_bin:
            emit_codex_error(
                "codex binary not found. Install it with: npm install -g @openai/codex"
            )
            return

        print("Starting Codex App Server...")
        with codex_lock:
            if codex_app is None:
                codex_app = CodexAppServer(
                    emit_codex_event, emit_codex_approval, emit_codex_error
                )
            adapter = codex_app

        result = adapter.start_thread(project_root)
        print("Codex thread ready:", result.get("threadId"))

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
    print("Phone requested Codex start.")
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
    except Exception as error:
        emit_codex_error(error)


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
