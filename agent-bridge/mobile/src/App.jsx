import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

// Set VITE_SERVER_URL in mobile/.env.local to your laptop's LAN address when
// opening this app on a phone, for example http://192.168.1.20:3000.
const SERVER_URL = import.meta.env.VITE_SERVER_URL;

export default function App() {
  const [sessionId, setSessionId] = useState("");
  const [socket, setSocket] = useState(null);
  const [status, setStatus] = useState("Disconnected");

  useEffect(() => () => socket?.disconnect(), [socket]);

  function connectToLaptop() {
    const normalizedSessionId = sessionId.trim().toUpperCase();
    if (!normalizedSessionId) {
      setStatus("Enter your session ID");
      return;
    }

    setStatus("Connecting...");
    const client = io(SERVER_URL);

    client.on("connect", () => {
      client.emit("join-session", { sessionId: normalizedSessionId });
    });
    client.on("session-joined", () => {
      setStatus("Connected");
      setSocket(client);
    });
    client.on("join-error", (data) => {
      setStatus(data?.message || "Connection failed");
      client.disconnect();
    });
    client.on("connect_error", () => {
      setStatus("Could not reach server");
      client.disconnect();
    });
    client.on("phone-disconnected", () => {
      setStatus("Laptop disconnected");
      setSocket(null);
      client.disconnect();
    });
    client.on("disconnect", () => {
      setSocket(null);
      setStatus("Disconnected");
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
    socket?.disconnect();
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
          <button className="connect" onClick={connectToLaptop}>
            Connect to laptop <span aria-hidden="true">→</span>
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
