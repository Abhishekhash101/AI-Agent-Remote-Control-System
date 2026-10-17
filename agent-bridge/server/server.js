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

app.get('/', (req, res) => {
    res.json({
        status: "online",
        service: "AgentBridge Server"
    });
});

io.on('connection', (socket) => {
    console.log("Client connected...", socket.id);

    //laptop create a session
    socket.on("create-session", () => {
        const sessionId = generateSessionId();
        sessions.set(sessionId, {
            laptop: socket.id,
            phone: null,
            screenHost: null
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
        if (!["move", "click"].includes(action) || !Number.isFinite(x) || !Number.isFinite(y)) return;
        io.to(session.laptop).emit("execute-pointer", {
            action, x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y))
        });
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
                if (session.phone) {
                    io.to(session.phone).emit("laptop-disconnected");
                }
                sessions.delete(sessionId);
                console.log(`Session removed: ${sessionId}`);
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
        sessionId = crypto.randomBytes(6).toString("hex").toUpperCase();
    } while (sessions.has(sessionId));
    return sessionId;
}


const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
    console.log(`AgentBridge server running on port ${PORT}`);
});
