# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.
# AgentBridge web app

The laptop client prints a session ID when you run `laptop/laptop_client.py`.
For screen sharing, open the web app on the laptop with `?mode=host`, enter that
ID, connect, then choose **Share this screen** and select the display or window.

Join that same ID from the regular web app on a phone or another laptop. Both
can act as the controller; the server supports one controller connection at a
time. Use the mouse or touch on the live preview to click and drag, or use the
buttons for right-click, double-click, and scrolling. On a laptop, click the
preview and type or use supported keys and shortcuts with its keyboard. On a
phone, use the keyboard field and extra key buttons. Keep the Python client and
screen-host browser open during the session.

Screen capture requires browser permission and a secure context (HTTPS, or
`localhost`). When testing on the LAN, run the host page on the laptop at
`localhost` and open the phone app at its network address. Keep the laptop
Python client and host browser tab running for the session. Stopping browser
sharing or disconnecting either client ends the screen stream.

Set `VITE_SERVER_URL` in `.env.local` to the Socket.IO server URL before
building/developing. WebRTC uses a public STUN server; networks that block direct
peer connectivity may require configuring a TURN service.

## Codex from the phone

Install and sign in to Codex CLI on the laptop, then start the existing bridge:

```bash
python3 laptop/laptop_client.py
```

Join the session from the phone and use **Codex on this laptop → Start Codex**.
The laptop client launches `codex app-server --stdio` locally and uses the
project root as the thread working directory. Send prompts in the Codex panel;
command and file-change approvals appear there with approve-once and decline
actions. The App Server is not exposed on Render: Render relays messages only
between the paired phone and the laptop client.
