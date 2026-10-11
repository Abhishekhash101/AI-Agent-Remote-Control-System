const express = require("express")
const http = require("http")
const cors = require("cors")
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
            phone: null
        });

        socket.join(sessionId)
        socket.emit("session-created", { sessionId });

        console.log(`Session created : ${sessionId}`);

    });


    //phone connection joins 
    socket.on("join-session", ({ sessionId }) => {
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

        console.log(`Phone joined session: ${sessionId}`);
    });

    //phone send commands 
    socket.on("remote-command", ({ sessionId, command } = {}) => {
        const session = sessions.get(sessionId);
        if (!session || typeof command !== "string") {
            return
        }

        //only paired phone can send the commands
        if (socket.id !== session.phone) {
            return
        }

        io.to(session.laptop).emit("execute-command", {
            command
        })

        console.log(`Command : ${command}->Laptop`)

    })

    socket.on("disconnect", () => {

        console.log("Client disconnected:", socket.id);

        // Remove sessions belonging to disconnected laptop
        for (const [sessionId, session] of sessions.entries()) {

            if (session.laptop === socket.id) {
                sessions.delete(sessionId);
                console.log(`Session removed: ${sessionId}`);
            } else if (session.phone === socket.id) {
                session.phone = null;
                io.to(session.laptop).emit("phone-disconnected");
            }
        }
    });

});

function generateSessionId() {

    return Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();
}


const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
    console.log(`AgentBridge server running on port ${PORT}`);
});
