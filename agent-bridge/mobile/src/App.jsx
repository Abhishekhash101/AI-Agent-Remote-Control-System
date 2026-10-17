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
  const [isSharing, setIsSharing] = useState(false);
  const [keyboardDraft, setKeyboardDraft] = useState("");
  const [heldModifiers, setHeldModifiers] = useState([]);
  const [codexThreadId, setCodexThreadId] = useState("");
  const [codexMessages, setCodexMessages] = useState([]);
  const [codexDraft, setCodexDraft] = useState("");
  const [codexApprovals, setCodexApprovals] = useState([]);
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexStatus, setCodexStatus] = useState("Codex is not connected");
  const [codexActivity, setCodexActivity] = useState("");
  const clientRef = useRef(null);
  const peerRef = useRef(null);
  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const sessionRef = useRef("");
  const pendingCandidates = useRef([]);
  const phoneReadyRef = useRef(false);
  const keyboardDraftRef = useRef("");
  const lastPointerRef = useRef({ x: 0.5, y: 0.5 });

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
      setIsSharing(true);
      stream.getTracks().forEach((track) => track.onended = () => {
        clientRef.current?.emit("screen-ended", { sessionId: sessionRef.current });
        streamRef.current = null;
        setIsSharing(false);
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
    if (!/^[A-Z0-9]{5}$/.test(normalizedSessionId)) {
      setStatus("Session ID must be 5 letters or numbers");
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
      if (!hostMode) {
        setCodexStatus("Restoring Codex session…");
        client.emit("codex-start", { sessionId: normalizedSessionId });
      }
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
    client.on("codex-thread-ready", ({ threadId, cwd }) => {
      setCodexThreadId(threadId);
      setCodexStatus(`Connected to Codex · ${cwd || "local workspace"}`);
    });
    client.on("codex-history", ({ messages, busy }) => {
      if (!Array.isArray(messages)) return;
      setCodexMessages(messages.filter((message) =>
        message && typeof message.id === "string" &&
        ["user", "assistant", "tool"].includes(message.role) &&
        typeof message.text === "string"
      ));
      setCodexBusy(busy === true);
      setCodexActivity(busy ? "Codex is continuing the current turn…" : "");
    });
    client.on("codex-turn-accepted", () => {
      setCodexBusy(true);
      setCodexStatus("Codex is working…");
    });
    client.on("codex-event", (event) => {
      const params = event.params || {};
      if (event.method === "turn/started") {
        setCodexBusy(true);
        setCodexActivity("Codex is working on your request…");
      }
      if (event.method === "item/started") {
        const item = params.item || {};
        if (item.type === "commandExecution") setCodexActivity(`Running command: ${item.command || "command"}`);
        else if (item.type === "fileChange") setCodexActivity("Codex is preparing file changes…");
        else if (item.type === "mcpToolCall") setCodexActivity(`Using tool: ${item.server || item.tool || item.toolName || "MCP tool"}`);
        else if (item.type === "webSearch") setCodexActivity("Searching the web…");
        else if (item.type === "agentMessage") setCodexActivity("Codex is writing a response…");
      }
      if (event.method === "item/completed") {
        const item = params.item || {};
        if (item.type === "commandExecution") setCodexActivity("Command finished; Codex is continuing…");
        else if (item.type === "fileChange") setCodexActivity("File changes prepared; Codex is continuing…");
      }
      if (event.method === "turn/completed") {
        setCodexBusy(false);
        setCodexActivity("");
        setCodexStatus(params.turn?.status === "failed" ? "Codex turn failed" : "Codex turn complete");
      }
      if (event.method === "item/agentMessage/delta" && typeof params.delta === "string") {
        const id = `assistant-${params.itemId || "current"}`;
        setCodexMessages((previous) => {
          const existing = previous.findIndex((message) => message.id === id);
          if (existing < 0) return [...previous, { id, role: "assistant", text: params.delta }];
          return previous.map((message, index) => index === existing ? { ...message, text: message.text + params.delta } : message);
        });
      } else if (event.method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
        const id = `tool-${params.itemId || "current"}`;
        setCodexMessages((previous) => {
          const existing = previous.findIndex((message) => message.id === id);
          if (existing < 0) return [...previous, { id, role: "tool", text: params.delta }];
          return previous.map((message, index) => index === existing ? { ...message, text: message.text + params.delta } : message);
        });
      }
    });
    client.on("codex-approval", (approval) => {
      setCodexApprovals((previous) => previous.some((item) => String(item.requestId) === String(approval.requestId)) ? previous : [...previous, approval]);
      setCodexStatus("Codex needs your approval");
    });
    client.on("codex-error", ({ message }) => {
      setCodexBusy(false);
      setCodexActivity("");
      setCodexStatus(message || "Codex connection error");
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

  function sendKey(key, action = "press") {
    if (!socket?.connected) return;
    socket.emit("remote-key", { sessionId: sessionRef.current, key, action });
  }

  function startCodex() {
    if (!socket?.connected) return;
    setCodexStatus("Starting local Codex App Server…");
    socket.emit("codex-start", { sessionId: sessionRef.current });
  }

  function sendCodexMessage(event) {
    event.preventDefault();
    const text = codexDraft.trim();
    if (!socket?.connected || !codexThreadId || !text) return;
    setCodexMessages((previous) => [...previous, { id: `user-${Date.now()}`, role: "user", text }]);
    setCodexDraft("");
    setCodexStatus("Sending to Codex…");
    socket.emit("codex-send", { sessionId: sessionRef.current, text });
  }

  function respondToCodexApproval(approval, decision) {
    if (!socket?.connected) return;
    socket.emit("codex-approval-decision", {
      sessionId: sessionRef.current,
      requestId: approval.requestId,
      method: approval.method,
      decision,
    });
    setCodexApprovals((previous) => previous.filter((item) => String(item.requestId) !== String(approval.requestId)));
    setCodexStatus(decision.startsWith("accept") ? "Approval sent" : "Request declined");
  }

  function toggleModifier(key) {
    const isHeld = heldModifiers.includes(key);
    sendKey(key, isHeld ? "up" : "down");
    setHeldModifiers((previous) => isHeld ? previous.filter((modifier) => modifier !== key) : [...previous, key]);
  }

  function updateRemoteText(event) {
    const next = event.target.value;
    const previous = keyboardDraftRef.current;
    let prefix = 0;
    while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
    const removed = previous.length - prefix;
    const inserted = next.slice(prefix);
    for (let index = 0; index < removed; index += 1) sendKey("backspace");
    if (inserted) socket?.emit("remote-text", { sessionId: sessionRef.current, text: inserted.slice(0, 500) });
    keyboardDraftRef.current = next;
    setKeyboardDraft(next);
  }

  function disconnect() {
    closePeer();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setIsSharing(false);
    clientRef.current?.disconnect();
    clientRef.current = null;
    setConnecting(false);
    setSocket(null);
    setStatus("Disconnected");
  }

  function sendPointer(event, action) {
    const point = getPointerPosition(event);
    if (action === "move") lastPointerRef.current = point;
    if (!socket?.connected) return;
    socket.emit("remote-pointer", { sessionId: sessionRef.current, action, ...point });
  }

  function getPointerPosition(event) {
    const video = videoRef.current;
    const rect = video?.getBoundingClientRect();
    if (!rect || !video.videoWidth || !video.videoHeight) return lastPointerRef.current;
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const shownWidth = video.videoWidth * scale;
    const shownHeight = video.videoHeight * scale;
    const offsetX = (rect.width - shownWidth) / 2;
    const offsetY = (rect.height - shownHeight) / 2;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left - offsetX) / shownWidth)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top - offsetY) / shownHeight)),
    };
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
          onChange={(event) => setSessionId(event.target.value.slice(0, 5))}
          onKeyDown={(event) => event.key === "Enter" && !socket && connectToLaptop()}
          placeholder="5-character code"
          maxLength={5}
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

        {hostMode && socket && <button className="connect share-screen" onClick={startScreenShare} disabled={isSharing}>Share this screen</button>}

        {!hostMode && socket && <div className="screen-viewer">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture?.(event.pointerId);
              if (event.button === 0) sendPointer(event, "down");
            }}
            onPointerMove={(event) => sendPointer(event, "move")}
            onPointerUp={(event) => {
              if (event.button === 0) sendPointer(event, "up");
            }}
            onPointerCancel={(event) => sendPointer(event, "up")}
            onContextMenu={(event) => { event.preventDefault(); sendPointer(event, "right-click"); }}
            onWheel={(event) => {
              event.preventDefault();
              socket.emit("remote-pointer", { sessionId: sessionRef.current, action: "scroll", y: -Math.sign(event.deltaY) * Math.max(1, Math.min(10, Math.round(Math.abs(event.deltaY) / 80))) });
            }}
          />
          {!hasVideo && <span>Waiting for the laptop screen…</span>}
        </div>}

        {!hostMode && socket && <div className="pointer-controls" aria-label="Mouse controls">
          <button onClick={() => sendPointer(lastPointerRef.current, "click")}>Left click</button>
          <button onClick={() => sendPointer(lastPointerRef.current, "double-click")}>Double click</button>
          <button onClick={() => sendPointer(lastPointerRef.current, "right-click")}>Right click</button>
          <button onClick={() => socket.emit("remote-pointer", { sessionId: sessionRef.current, action: "scroll", y: 3 })}>Scroll up</button>
          <button onClick={() => socket.emit("remote-pointer", { sessionId: sessionRef.current, action: "scroll", y: -3 })}>Scroll down</button>
        </div>}

        {!hostMode && <div className="controls" aria-label="Remote commands">
          <button disabled={!socket} onClick={() => sendKey("enter")}>
            <span className="key-icon" aria-hidden="true">↵</span> ENTER
          </button>
          <button disabled={!socket} onClick={() => sendKey("space")}>
            <span className="key-icon space-icon" aria-hidden="true" /> SPACE
          </button>
          <button disabled={!socket} onClick={() => sendKey("esc")}>
            <span className="key-icon esc-icon" aria-hidden="true">⎋</span> ESC
          </button>
        </div>}

        {!hostMode && socket && <section className="keyboard-panel" aria-label="Remote keyboard">
          <h2>Keyboard</h2>
          <label htmlFor="remoteText">Type on laptop</label>
          <input
            id="remoteText"
            value={keyboardDraft}
            onChange={(event) => { if (!event.nativeEvent.isComposing) updateRemoteText(event); }}
            onCompositionEnd={updateRemoteText}
            onKeyDown={(event) => {
              const keys = { Enter: "enter", Tab: "tab", Escape: "esc", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
              if (keys[event.key]) {
                event.preventDefault();
                sendKey(keys[event.key]);
              } else if (event.key === "Backspace" && !event.currentTarget.value) {
                event.preventDefault();
                sendKey("backspace");
              } else if (event.key === "Delete") {
                event.preventDefault();
                sendKey("delete");
              }
            }}
            placeholder="Tap here and type…"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck="false"
          />
          <div className="keyboard-keys">
            {["tab", "backspace", "delete", "insert", "home", "end", "pageup", "pagedown", "up", "down", "left", "right", "capslock", "numlock", "pause", "printscreen", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"].map((key) => (
              <button key={key} onClick={() => sendKey(key)}>{key === "pageup" ? "PgUp" : key === "pagedown" ? "PgDn" : key.toUpperCase()}</button>
            ))}
            {["shift", "ctrl", "alt"].map((key) => (
              <button key={key} className={heldModifiers.includes(key) ? "modifier active" : "modifier"} aria-pressed={heldModifiers.includes(key)} onClick={() => toggleModifier(key)}>{key.toUpperCase()}</button>
            ))}
            <button onClick={() => { keyboardDraftRef.current = ""; setKeyboardDraft(""); }}>Clear typing</button>
          </div>
        </section>}

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

        {!hostMode && socket && <section className="codex-panel" aria-label="Codex remote session">
          <div className="codex-heading">
            <div>
              <h2>Codex on this laptop</h2>
              <p>{codexStatus}</p>
            </div>
            {!codexThreadId && <button className="codex-start" onClick={startCodex}>Start Codex</button>}
          </div>
          {codexThreadId && <small className="codex-workspace">Thread {codexThreadId}</small>}
          {codexActivity && <p className="codex-live-activity" role="status">{codexActivity}</p>}
          {codexApprovals.map((approval) => {
            const params = approval.params || {};
            const detail = params.command || params.reason || Object.keys(params.fileChanges || {}).join(", ") || approval.method;
            return <article className="codex-approval" key={String(approval.requestId)}>
              <strong>{approval.method.includes("fileChange") ? "File change approval" : "Command approval"}</strong>
              <code>{String(detail).slice(0, 700)}</code>
              {params.cwd && <small>Directory: {params.cwd}</small>}
              <div>
                <button onClick={() => respondToCodexApproval(approval, "accept")}>Approve once</button>
                <button onClick={() => respondToCodexApproval(approval, "decline")}>Decline</button>
              </div>
            </article>;
          })}
          <div className="codex-transcript" aria-live="polite">
            {codexMessages.length === 0 ? <p className="activity-empty">Start a Codex thread to chat with the agent running on this laptop.</p> : codexMessages.map((message) => (
              <article className={`codex-message ${message.role}`} key={message.id}>
                <strong>{message.role === "user" ? "You" : message.role === "tool" ? "Tool output" : "Codex"}</strong>
                <pre>{message.text}</pre>
              </article>
            ))}
          </div>
          <form className="codex-composer" onSubmit={sendCodexMessage}>
            <textarea value={codexDraft} onChange={(event) => setCodexDraft(event.target.value)} placeholder={codexThreadId ? (codexBusy ? "Send Codex an update…" : "Message Codex…") : "Start Codex first"} disabled={!codexThreadId} rows={3} />
            <button type="submit" disabled={!codexThreadId || !codexDraft.trim()}>{codexBusy ? "Send update" : "Send"}</button>
          </form>
        </section>}

        <p className="hint">
          {hostMode ? "Keep this browser tab open while sharing. Stop sharing from the browser to end capture." : "Keep the laptop client and screen host browser open while connected."}
        </p>
      </section>
      <footer>SECURE LOCAL CONNECTION <span>•</span> AGENTBRIDGE</footer>
    </main>
  );
}
