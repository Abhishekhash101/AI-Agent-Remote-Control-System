
import socketio
import pyautogui

SERVER_URL = "http://127.0.0.1:3000"

sio = socketio.Client(reconnection=True)

ALLOWED_COMMANDS = {
    "ENTER": "enter",
    "SPACE": "space",
    "ESC": "esc",
    "BACKSPACE": "backspace",
}

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

@sio.on("session-created")
def session_created(data):
    print("\nSession created!")
    print("Session ID:", data["sessionId"])
    print("Waiting for phone commands...")

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

if __name__ == "__main__":
    try:
        sio.connect(SERVER_URL)
        sio.wait()
    except KeyboardInterrupt:
        print("\nStopping client...")
        sio.disconnect()
    except Exception as error:
        print("Error:", repr(error))

     