const express = require("express")
const http = require("http")
const cors = require("cors")
const crypto = require("crypto")
const { Server } = require("socket.io")

const app = express();
const server = http.createServer(app)

app.use(cors());
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
})

//storage of active sessions

const sessions = new Map();
const LAPTOP_RECONNECT_GRACE_MS = 60000;

app.get('/', (req, res) => {
    res.json({
        status: "online",
        service: "AgentBridge Server"
    });
});

io.on('connection', (socket) => {
    console.log("Client connected...", socket.id);

    //laptop create a session
    socket.on("create-session", ({ sessionId: previousSessionId } = {}) => {
        const existing = sessions.get(previousSessionId);
        if (existing && !existing.laptop && existing.laptopReconnectTimer) {
            clearTimeout(existing.laptopReconnectTimer);
            existing.laptopReconnectTimer = null;
            existing.laptop = socket.id;
            socket.join(previousSessionId);
            socket.emit("session-created", { sessionId: previousSessionId, resumed: true });
            if (existing.phone) {
                io.to(existing.phone).emit("laptop-reconnected");
                io.to(socket.id).emit("phone-connected");
            }
            console.log(`Laptop reconnected to session: ${previousSessionId}`);
            return;
        }

        const sessionId = generateSessionId();
        sessions.set(sessionId, {
            laptop: socket.id,
            phone: null,
            screenHost: null,
            laptopReconnectTimer: null,
        });

        socket.join(sessionId)
        socket.emit("session-created", { sessionId });

        console.log(`Session created : ${sessionId}`);

    });

    // A browser on the laptop captures the screen; the Python client remains
    // the trusted bridge for OS-level pointer input.
    socket.on("join-screen-host", ({ sessionId } = {}) => {
        const session = sessions.get(sessionId);
        if (!session || session.laptop === socket.id) {
            socket.emit("screen-error", { message: "Invalid session for screen sharing." });
            return;
        }
        if (session.screenHost && session.screenHost !== socket.id) {
            socket.emit("screen-error", { message: "A screen host is already connected." });
            return;
        }
        session.screenHost = socket.id;
        socket.join(sessionId);
        socket.emit("screen-host-joined", { sessionId });
        if (session.phone) {
            io.to(session.phone).emit("screen-host-available");
            io.to(socket.id).emit("screen-phone-ready");
        }
    });


    //phone connection joins 
    socket.on("join-session", ({ sessionId } = {}) => {
        const session = sessions.get(sessionId);
        if (!session) {
            socket.emit("join-error", {
                message: "Invalid session Id"
            })
            return;
        }
        session.phone = socket.id;
        socket.join(sessionId);
        socket.emit("session-joined", {
            sessionId
        })


        // we needto tell laptop that phone is connecteed..
        io.to(session.laptop).emit("phone-connected");
        if (session.screenHost) io.to(session.screenHost).emit("screen-phone-ready");

        console.log(`Phone joined session: ${sessionId}`);
    });

    socket.on("screen-signal", ({ sessionId, signal } = {}) => {
        const session = sessions.get(sessionId);
        if (!session || !signal || typeof signal !== "object") return;
        if (socket.id === session.screenHost && session.phone) {
            io.to(session.phone).emit("screen-signal", signal);
        } else if (socket.id === session.phone && session.screenHost) {
            io.to(session.screenHost).emit("screen-signal", signal);
        }
    });

    socket.on("screen-ended", ({ sessionId } = {}) => {
        const session = sessions.get(sessionId);
        if (session && socket.id === session.screenHost && session.phone) {
            io.to(session.phone).emit("screen-ended");
        }
    });

    socket.on("remote-pointer", ({ sessionId, action, x, y } = {}) => {
        const session = sessions.get(sessionId);
        if (!session || socket.id !== session.phone) return;
        if (action === "scroll") {
            if (!Number.isInteger(y) || Math.abs(y) > 10) return;
            io.to(session.laptop).emit("execute-pointer", { action, amount: y });
            return;
        }
        if (!["move", "down", "up", "click", "right-click", "double-click"].includes(action) || !Number.isFinite(x) || !Number.isFinite(y)) return;
        io.to(session.laptop).emit("execute-pointer", {
            action, x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y))
        });
    });

    socket.on("remote-key", ({ sessionId, key, action = "press" } = {}) => {
        const session = sessions.get(sessionId);
        const keys = new Set([
            "enter", "space", "esc", "backspace", "tab", "delete", "insert",
            "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
            "shift", "ctrl", "alt", "win", "capslock", "numlock", "pause", "printscreen",
            ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
        ]);
        if (!session || socket.id !== session.phone || typeof key !== "string" || !keys.has(key)) return;
        if (!["press", "down", "up"].includes(action)) return;
        if (action !== "press" && !["shift", "ctrl", "alt", "win"].includes(key)) return;
        io.to(session.laptop).emit("execute-key", { key, action });
    });

    socket.on("remote-text", ({ sessionId, text } = {}) => {
        const session = sessions.get(sessionId);
        if (!session || socket.id !== session.phone || typeof text !== "string" || text.length > 500) return;
        io.to(session.laptop).emit("execute-text", { text });
    });

    socket.on("codex-start", ({ sessionId } = {}) => {
        const session = sessions.get(sessionId);
        if (session && socket.id === session.phone) {
            io.to(session.laptop).emit("codex-start", { sessionId });
        }
    });

    socket.on("codex-send", ({ sessionId, text } = {}) => {
        const session = sessions.get(sessionId);
        if (!session || socket.id !== session.phone || typeof text !== "string" || !text.trim() || text.length > 12000) return;
        io.to(session.laptop).emit("codex-send", { sessionId, text });
    });

    socket.on("codex-approval-decision", ({ sessionId, requestId, method, decision } = {}) => {
        const session = sessions.get(sessionId);
        const methods = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"];
        const decisions = ["accept", "acceptForSession", "decline", "cancel"];
        if (!session || socket.id !== session.phone || !["string", "number"].includes(typeof requestId)) return;
        if (!methods.includes(method) || !decisions.includes(decision)) return;
        io.to(session.laptop).emit("codex-approval-decision", { sessionId, requestId, method, decision });
    });

    socket.on("codex-thread-ready", (payload = {}) => {
        const session = sessions.get(payload.sessionId);
        if (!session || socket.id !== session.laptop || !session.phone || typeof payload.threadId !== "string") return;
        io.to(session.phone).emit("codex-thread-ready", {
            threadId: payload.threadId,
            cwd: typeof payload.cwd === "string" ? payload.cwd : "",
        });
    });

    socket.on("codex-history", (payload = {}) => {
        const session = sessions.get(payload.sessionId);
        if (!session || socket.id !== session.laptop || !session.phone || !Array.isArray(payload.messages)) return;
        const messages = payload.messages.filter((message) =>
            message && typeof message.id === "string" &&
            ["user", "assistant", "tool"].includes(message.role) &&
            typeof message.text === "string"
        ).map((message) => ({
            id: message.id.slice(0, 200),
            role: message.role,
            text: message.text,
        }));
        io.to(session.phone).emit("codex-history", { messages, busy: payload.busy === true });
    });

    socket.on("codex-turn-accepted", (payload = {}) => {
        const session = sessions.get(payload.sessionId);
        if (session && socket.id === session.laptop && session.phone) {
            io.to(session.phone).emit("codex-turn-accepted");
        }
    });

    socket.on("codex-event", (payload = {}) => {
        const session = sessions.get(payload.sessionId);
        if (!session || socket.id !== session.laptop || !session.phone || !payload.event || typeof payload.event.method !== "string") return;
        io.to(session.phone).emit("codex-event", payload.event);
    });

    socket.on("codex-approval", (payload = {}) => {
        const session = sessions.get(payload.sessionId);
        if (!session || socket.id !== session.laptop || !session.phone || !["string", "number"].includes(typeof payload.requestId)) return;
        if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(payload.method)) return;
        io.to(session.phone).emit("codex-approval", {
            requestId: payload.requestId,
            method: payload.method,
            params: payload.params || {},
        });
    });

    socket.on("codex-error", (payload = {}) => {
        const session = sessions.get(payload.sessionId);
        if (!session || socket.id !== session.laptop || !session.phone || typeof payload.message !== "string") return;
        io.to(session.phone).emit("codex-error", { message: payload.message.slice(0, 1000) });
    });

    //phone send commands 
    socket.on("remote-command", ({ sessionId, command } = {}) => {
        const session = sessions.get(sessionId);
        if (!session) {
            socket.emit("command-error", { message: "Session expired. Reconnect using the laptop's current session ID." });
            return
        }
        if (typeof command !== "string") {
            socket.emit("command-error", { message: "Invalid command." });
            return
        }

        //only paired phone can send the commands
        if (socket.id !== session.phone) {
            socket.emit("command-error", { message: "This phone is no longer paired with the laptop." });
            return
        }

        io.to(session.laptop).emit("execute-command", {
            command
        })
        socket.emit("command-forwarded", { command });

        console.log(`Command : ${command}->Laptop`)

    })

    socket.on("agent-activity", ({ sessionId, event } = {}) => {
        const session = sessions.get(sessionId);

        if (!session || socket.id !== session.laptop || !session.phone) {
            return;
        }

        if (!event || typeof event.tool !== "string") return;

        io.to(session.phone).emit("agent-activity", {
            agent: "Gemini CLI",
            event: event.event || "BeforeTool",
            tool: event.tool,
            time: new Date().toISOString()
        });
    });

    socket.on("disconnect", (reason) => {

        console.log("Client disconnected:", socket.id, reason);

        // Remove sessions belonging to disconnected laptop
        for (const [sessionId, session] of sessions.entries()) {

            if (session.laptop === socket.id) {
                session.laptop = null;
                if (session.phone) io.to(session.phone).emit("laptop-reconnecting");
                session.laptopReconnectTimer = setTimeout(() => {
                    if (session.laptop !== null) return;
                    if (session.phone) io.to(session.phone).emit("laptop-disconnected");
                    sessions.delete(sessionId);
                    console.log(`Session removed after reconnect timeout: ${sessionId}`);
                }, LAPTOP_RECONNECT_GRACE_MS);
            } else if (session.phone === socket.id) {
                session.phone = null;
                io.to(session.laptop).emit("phone-disconnected");
                if (session.screenHost) io.to(session.screenHost).emit("screen-phone-left");
            } else if (session.screenHost === socket.id) {
                session.screenHost = null;
                if (session.phone) io.to(session.phone).emit("screen-host-unavailable");
            }
        }
    });

});

function generateSessionId() {
    let sessionId;
    do {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        sessionId = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
    } while (sessions.has(sessionId));
    return sessionId;
}


const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
    console.log(`AgentBridge server running on port ${PORT}`);
});
