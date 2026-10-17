
import json
import threading
import time
from pathlib import Path

import pyautogui
import socketio

SERVER_URL = "https://agentbridge-server.onrender.com"
GEMINI_LOG = Path.home() / ".gemini" / "agentbridge-hook.log"

sio = socketio.Client(reconnection=True)
session_id = None
log_position = 0
watcher_started = False

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

@sio.event
def connect():
    print("Connected to AgentBridge server.")
    sio.emit("create-session")

@sio.event
def connect_error(data):
    print("Connection failed:", data)

@sio.event
def disconnect(reason=None):
    print("Disconnected from server:", reason)
    release_modifiers()

@sio.on("session-created")
def session_created(data):
    global session_id, log_position, watcher_started
    session_id = data["sessionId"]
    try:
        log_position = GEMINI_LOG.stat().st_size
    except FileNotFoundError:
        log_position = 0

    print("\nSession created!")
    print("Session ID:", session_id)
    print("Waiting for phone commands...")

    if not watcher_started:
        watcher_started = True
        threading.Thread(target=watch_gemini_log, daemon=True).start()

@sio.on("phone-connected")
def phone_connected():
    print("Phone connected!")

@sio.on("execute-command")
def execute_command(data):
    command = data.get("command", "").upper()

    if command not in ALLOWED_COMMANDS:
        print("Blocked unknown command:", command)
        return

    try:
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
                pyautogui.scroll(amount)
            except Exception as error:
                print("Could not execute scroll:", repr(error))
        return
    x, y = data.get("x"), data.get("y")
    if action not in {"move", "down", "up", "click", "right-click", "double-click"} or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return
    try:
        width, height = pyautogui.size()
        point = (round(max(0, min(1, x)) * (width - 1)), round(max(0, min(1, y)) * (height - 1)))
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
        pyautogui.write(text, interval=0)
    except Exception as error:
        print("Could not type text (only keyboard-supported characters may work):", repr(error))

@sio.on("phone-disconnected")
def phone_disconnected():
    release_modifiers()

def release_modifiers():
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


def watch_gemini_log():
    global log_position

    while True:
        try:
            if GEMINI_LOG.exists():
                size = GEMINI_LOG.stat().st_size
                if size < log_position:
                    log_position = 0

                with GEMINI_LOG.open("r", encoding="utf-8") as log:
                    log.seek(log_position)
                    for line in log:
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        tool = entry.get("tool") or entry.get("tool_name")
                        if session_id and isinstance(tool, str):
                            sio.emit("agent-activity", {
                                "sessionId": session_id,
                                "event": {
                                    "event": entry.get("event") or entry.get("hook_event_name"),
                                    "tool": tool,
                                },
                            })
                    log_position = log.tell()
        except Exception as error:
            print("Gemini log reader error:", repr(error))

        time.sleep(0.5)

if __name__ == "__main__":
    try:
        sio.connect(SERVER_URL)
        sio.wait()
    except KeyboardInterrupt:
        print("\nStopping client...")
        sio.disconnect()
    except Exception as error:
        print("Error:", repr(error))

