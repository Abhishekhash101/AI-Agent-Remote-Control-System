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

The phone joins the session ID printed by `laptop/laptop_client.py`. For desktop
screen sharing, open the web app on the laptop with `?mode=host`, enter that
same ID, connect, then choose **Share this screen** and select the display or
window. On the phone, open the regular app and join the same ID. Touch the
preview to click, hold and drag to drag, or use the mouse controls to left-click,
right-click, double-click, and scroll. The keyboard field opens the phone
keyboard and sends typed text to the laptop; the extra keys and Shift/Ctrl/Alt
buttons cover navigation and shortcuts. Keep the laptop client running.

Screen capture requires browser permission and a secure context (HTTPS, or
`localhost`). When testing on the LAN, run the host page on the laptop at
`localhost` and open the phone app at its network address. Keep the laptop
Python client and host browser tab running for the session. Stopping browser
sharing or disconnecting either client ends the screen stream.

Set `VITE_SERVER_URL` in `.env.local` to the Socket.IO server URL before
building/developing. WebRTC uses a public STUN server; networks that block direct
peer connectivity may require configuring a TURN service.
