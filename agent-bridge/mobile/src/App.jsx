import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

// Set VITE_SERVER_URL in mobile/.env.local to your laptop's LAN address when
// opening this app on a phone, for example http://192.168.1.20:3000.
const SERVER_URL = import.meta.env.VITE_SERVER_URL;

export default function App() {
  const hostMode = new URLSearchParams(window.location.search).get("mode") === "host";
  const [sessionId, setSessionId] = useState("");
  const [socket, setSocket] = useState(null);
  const [status, setStatus] = useState("Disconnected");
  const [connecting, setConnecting] = useState(false);
  const [activities, setActivities] = useState([]);
  const [hasVideo, setHasVideo] = useState(false);
  const clientRef = useRef(null);
  const peerRef = useRef(null);
  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const sessionRef = useRef("");
  const pendingCandidates = useRef([]);
  const phoneReadyRef = useRef(false);

  function closePeer() {
    peerRef.current?.close();
    peerRef.current = null;
    pendingCandidates.current = [];
  }

  function makePeer() {
    closePeer();
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    peerRef.current = peer;
    peer.onicecandidate = ({ candidate }) => {
      if (candidate) clientRef.current?.emit("screen-signal", {
        sessionId: sessionRef.current,
        signal: { type: "candidate", candidate },
      });
    };
    peer.onconnectionstatechange = () => {
      if (["failed", "disconnected"].includes(peer.connectionState)) {
        setStatus("Screen connection interrupted");
      }
    };
    if (!hostMode) {
      peer.ontrack = ({ streams }) => {
        if (videoRef.current) videoRef.current.srcObject = streams[0];
        setHasVideo(true);
        setStatus("Screen connected · touch to control");
      };
    }
    return peer;
  }

  useEffect(() => () => {
    closePeer();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    clientRef.current?.disconnect();
  }, []);

  async function startScreenShare() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streamRef.current = stream;
      stream.getTracks().forEach((track) => track.onended = () => {
        clientRef.current?.emit("screen-ended", { sessionId: sessionRef.current });
        streamRef.current = null;
        closePeer();
        setStatus("Screen sharing stopped");
      });
      if (sessionRef.current) {
        const peer = makePeer();
        stream.getTracks().forEach((track) => peer.addTrack(track, stream));
        setStatus("Sharing screen · waiting for phone");
        if (phoneReadyRef.current) await sendScreenOffer(peer);
      }
    } catch (error) {
      setStatus(error.name === "NotAllowedError" ? "Screen capture was cancelled" : `Could not share screen: ${error.message}`);
    }
  }

  async function sendScreenOffer(peer) {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    clientRef.current?.emit("screen-signal", {
      sessionId: sessionRef.current,
      signal: { type: "description", description: peer.localDescription },
    });
  }

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
      setStatus(hostMode ? "Opening screen host..." : "Joining session...");
      sessionRef.current = normalizedSessionId;
      client.emit(hostMode ? "join-screen-host" : "join-session", { sessionId: normalizedSessionId });
    });
    const joined = () => {
      setConnecting(false);
      setStatus(hostMode ? "Host connected · start screen sharing" : "Connected");
      setSocket(client);
    };
    client.on("session-joined", joined);
    client.on("screen-host-joined", joined);
    client.on("screen-phone-ready", async () => {
      phoneReadyRef.current = true;
      if (!hostMode || !streamRef.current) return;
      try {
        const peer = peerRef.current || makePeer();
        if (!peer.getSenders().length) streamRef.current.getTracks().forEach((track) => peer.addTrack(track, streamRef.current));
        await sendScreenOffer(peer);
      } catch (error) {
        setStatus(`Could not start screen connection: ${error.message}`);
      }
    });
    client.on("screen-phone-left", () => {
      phoneReadyRef.current = false;
      closePeer();
      if (videoRef.current) videoRef.current.srcObject = null;
      setHasVideo(false);
      setStatus("Phone disconnected · waiting to reconnect");
    });
    client.on("screen-signal", async (signal) => {
      try {
        let peer = peerRef.current;
        if (!peer && !hostMode && signal.type === "description") peer = makePeer();
        if (!peer) return;
        if (signal.type === "description") {
          await peer.setRemoteDescription(signal.description);
          for (const candidate of pendingCandidates.current) await peer.addIceCandidate(candidate);
          pendingCandidates.current = [];
          if (signal.description.type === "offer") {
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            client.emit("screen-signal", { sessionId: sessionRef.current, signal: { type: "description", description: peer.localDescription } });
          }
        } else if (signal.type === "candidate") {
          if (peer.remoteDescription) await peer.addIceCandidate(signal.candidate);
          else pendingCandidates.current.push(signal.candidate);
        }
      } catch (error) {
        setStatus(`Screen connection error: ${error.message}`);
      }
    });
    client.on("screen-host-available", () => setStatus("Connected · screen host available"));
    client.on("screen-host-unavailable", () => { closePeer(); setStatus("Screen host disconnected"); });
    client.on("screen-ended", () => {
      closePeer();
      if (videoRef.current) videoRef.current.srcObject = null;
      setHasVideo(false);
      setStatus("Laptop screen sharing stopped");
    });
    const rejectJoin = (message) => {
      setStatus(message);
      setConnecting(false);
      setSocket(null);
      clientRef.current = null;
      client.disconnect();
    };
    client.on("screen-error", (data) => rejectJoin(data?.message || "Could not open screen host"));
    client.on("agent-activity", (activity) => {
      setActivities((previous) => [
        {
          ...activity,
          id: `${Date.now()}-${Math.random()}`,
        },
        ...previous,
      ].slice(0, 30));
    });
    client.on("join-error", (data) => {
      rejectJoin(data?.message || "Connection failed");
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
      if (reason === "io client disconnect") return;
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
    closePeer();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    clientRef.current?.disconnect();
    clientRef.current = null;
    setConnecting(false);
    setSocket(null);
    setStatus("Disconnected");
  }

  function sendPointer(event, action) {
    const video = videoRef.current;
    const rect = video?.getBoundingClientRect();
    if (!rect || !video.videoWidth || !video.videoHeight || !socket?.connected) return;
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const shownWidth = video.videoWidth * scale;
    const shownHeight = video.videoHeight * scale;
    const offsetX = (rect.width - shownWidth) / 2;
    const offsetY = (rect.height - shownHeight) / 2;
    socket.emit("remote-pointer", {
      sessionId: sessionRef.current,
      action,
      x: Math.max(0, Math.min(1, (event.clientX - rect.left - offsetX) / shownWidth)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top - offsetY) / shownHeight)),
    });
  }

  return (
    <main className="app">
      <section className="panel" aria-labelledby="app-title">
        <div className="brand-mark" aria-hidden="true">A</div>
        <p className="eyebrow">{hostMode ? "DESKTOP SCREEN SHARE" : "REMOTE CONTROL"}</p>
        <h1 id="app-title">AgentBridge</h1>
        <p className="subtitle">{hostMode ? "Share this laptop screen with your paired phone." : "View and control your laptop remotely."}</p>

        <label htmlFor="sessionId">{hostMode ? "Session ID from laptop client" : "Laptop Session ID"}</label>
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

        {hostMode && socket && <button className="connect share-screen" onClick={startScreenShare} disabled={!!streamRef.current}>Share this screen</button>}

        {!hostMode && socket && <div className="screen-viewer">
          <video ref={videoRef} autoPlay playsInline muted onPointerMove={(event) => sendPointer(event, "move")} onPointerUp={(event) => sendPointer(event, "click")} />
          {!hasVideo && <span>Waiting for the laptop screen…</span>}
        </div>}

        {!hostMode && <div className="controls" aria-label="Remote commands">
          <button disabled={!socket} onClick={() => sendCommand("ENTER")}>
            <span className="key-icon" aria-hidden="true">↵</span> ENTER
          </button>
          <button disabled={!socket} onClick={() => sendCommand("SPACE")}>
            <span className="key-icon space-icon" aria-hidden="true" /> SPACE
          </button>
          <button disabled={!socket} onClick={() => sendCommand("ESC")}>
            <span className="key-icon esc-icon" aria-hidden="true">⎋</span> ESC
          </button>
        </div>}

        {!hostMode && <div className="activity-panel">
          <h2>Gemini activity</h2>

          {activities.length === 0 ? (
            <p className="activity-empty">Waiting for tool activity...</p>
          ) : (
            <ul className="activity-list">
              {activities.map((activity) => (
                <li key={activity.id}>
                  <span>{activity.agent || "Gemini CLI"}</span>
                  <strong>{activity.tool}</strong>
                  <small>{activity.event}</small>
                </li>
              ))}
            </ul>
          )}
        </div>}

        <p className="hint">
          {hostMode ? "Keep this browser tab open while sharing. Stop sharing from the browser to end capture." : "Keep the laptop client and screen host browser open while connected."}
        </p>
      </section>
      <footer>SECURE LOCAL CONNECTION <span>•</span> AGENTBRIDGE</footer>
    </main>
  );
}
