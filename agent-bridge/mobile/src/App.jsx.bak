import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

// Set VITE_SERVER_URL in mobile/.env.local to your laptop's LAN address when
// opening this app on a phone, for example http://192.168.1.20:3000.
const SERVER_URL = import.meta.env.VITE_SERVER_URL;

export default function App() {
  const [sessionId, setSessionId] = useState("");
  const [socket, setSocket] = useState(null);
  const [status, setStatus] = useState("Disconnected");
  const [connecting, setConnecting] = useState(false);
  const clientRef = useRef(null);

  useEffect(() => () => clientRef.current?.disconnect(), []);

  function connectToLaptop() {
    const normalizedSessionId = sessionId.trim().toUpperCase();
    if (!normalizedSessionId) {
      setStatus("Enter your session ID");
      return;
    }
    if (connecting || clientRef.current) return;

    setConnecting(true);
    setStatus("Connecting...");
    const client = io(SERVER_URL);
    clientRef.current = client;

    client.on("connect", () => {
      setStatus("Joining session...");
      client.emit("join-session", { sessionId: normalizedSessionId });
    });
    client.on("session-joined", () => {
      setConnecting(false);
      setStatus("Connected");
      setSocket(client);
    });
    client.on("join-error", (data) => {
      setStatus(data?.message || "Connection failed");
      setConnecting(false);
      clientRef.current = null;
      client.disconnect();
    });
    client.on("command-forwarded", ({ command }) => {
      setStatus(`${command} sent`);
    });
    client.on("command-error", (data) => {
      setStatus(data?.message || "Command could not be sent");
    });
    client.on("laptop-disconnected", () => {
      setStatus("Laptop disconnected. Reconnect with its current session ID.");
      setConnecting(false);
      setSocket(null);
      clientRef.current = null;
      client.disconnect();
    });
    client.on("connect_error", (error) => {
      setStatus(`Connecting to server: ${error.message}`);
    });
    client.io.on("reconnect_attempt", () => {
      setStatus("Connection lost. Reconnecting...");
    });
    client.on("disconnect", (reason) => {
      if (reason === "io server disconnect") {
        setConnecting(false);
        setSocket(null);
        clientRef.current = null;
        setStatus("Server closed the connection. Reconnect to continue.");
      } else {
        // Socket.IO reconnects automatically after temporary transport drops.
        setStatus("Connection lost. Reconnecting...");
      }
    });
  }

  function sendCommand(command) {
    if (!socket?.connected) return;
    socket.emit("remote-command", {
      sessionId: sessionId.trim().toUpperCase(),
      command,
    });
  }

  function disconnect() {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setConnecting(false);
    setSocket(null);
    setStatus("Disconnected");
  }

  return (
    <main className="app">
      <section className="panel" aria-labelledby="app-title">
        <div className="brand-mark" aria-hidden="true">A</div>
        <p className="eyebrow">REMOTE CONTROL</p>
        <h1 id="app-title">AgentBridge</h1>
        <p className="subtitle">Control your AI agent remotely.</p>

        <label htmlFor="sessionId">Laptop Session ID</label>
        <input
          id="sessionId"
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && !socket && connectToLaptop()}
          placeholder="Enter session ID"
          autoCapitalize="characters"
          autoComplete="off"
          disabled={!!socket}
        />

        {!socket ? (
          <button className="connect" onClick={connectToLaptop} disabled={connecting}>
            {connecting ? "Connecting..." : <>Connect to laptop <span aria-hidden="true">→</span></>}
          </button>
        ) : (
          <button className="disconnect" onClick={disconnect}>
            Disconnect
          </button>
        )}

        <p className="status" role="status" aria-live="polite">
          <span className={`status-dot ${socket?.connected ? "online" : ""}`} />
          Status: <strong>{status}</strong>
        </p>

        <div className="controls" aria-label="Remote commands">
          <button disabled={!socket} onClick={() => sendCommand("ENTER")}>
            <span className="key-icon" aria-hidden="true">↵</span> ENTER
          </button>
          <button disabled={!socket} onClick={() => sendCommand("SPACE")}>
            <span className="key-icon space-icon" aria-hidden="true" /> SPACE
          </button>
          <button disabled={!socket} onClick={() => sendCommand("ESC")}>
            <span className="key-icon esc-icon" aria-hidden="true">⎋</span> ESC
          </button>
        </div>

        <p className="hint">
          Keep the laptop client running while connected.
        </p>
      </section>
      <footer>SECURE LOCAL CONNECTION <span>•</span> AGENTBRIDGE</footer>
    </main>
  );
}
