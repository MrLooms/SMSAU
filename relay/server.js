// SMS Among Us - HTTP Relay Server
// Deploy to Render.com as a Node.js web service.

const express = require("express");
const cors    = require("cors");
const app     = express();

app.use(cors());

// Read raw POST body as a string regardless of Content-Type.
// http_post_string in GameMaker GXC often omits the Content-Type header,
// so express.text() would leave req.body undefined. This always works.
app.use((req, res, next) => {
    if (req.method !== "POST") return next();
    let raw = "";
    req.on("data", chunk => { raw += chunk.toString(); });
    req.on("end", () => { req.body = raw; next(); });
});

// rooms[code] = { slots: bool[10], players: { pid: { lastSeen, queue[] } } }
const rooms = {};

// Remove players inactive for >30s, clean up empty rooms
setInterval(() => {
    const now = Date.now();
    for (const code of Object.keys(rooms)) {
        const room = rooms[code];
        for (const pidStr of Object.keys(room.players)) {
            if (now - room.players[pidStr].lastSeen > 30000) {
                console.log(`Room ${code}: slot ${pidStr} timed out`);
                const leaveMsg = `1,${pidStr}`;
                for (const [op, other] of Object.entries(room.players)) {
                    if (op !== pidStr) other.queue.push(leaveMsg);
                }
                delete room.players[pidStr];
                room.slots[parseInt(pidStr)] = false;
            }
        }
        if (Object.keys(room.players).length === 0) {
            console.log(`Room ${code} cleaned up`);
            delete rooms[code];
        }
    }
}, 10000);

// POST /join   body: {"code":1234,"create":true}  (host)
//              body: {"code":1234}                 (client — room must already exist)
// → {"pid":0}
app.post("/join", (req, res) => {
    let body;
    try { body = JSON.parse(req.body); }
    catch (e) { return res.status(400).json({ error: "bad json", raw: req.body }); }

    const code   = body.code;
    const create = body.create === true;

    if (typeof code !== "number" || code < 1000 || code > 9999)
        return res.status(400).json({ error: "bad code", got: code });

    if (create) {
        // Host: create the room (or reclaim it if it somehow still exists)
        rooms[code] = { slots: new Array(10).fill(false), players: {} };
    } else if (!rooms[code]) {
        // Client: room must already exist
        return res.status(404).json({ error: "room not found" });
    }

    const room = rooms[code];

    const pid = room.slots.findIndex(s => !s);
    if (pid === -1) return res.status(503).json({ error: "room full" });

    room.slots[pid] = true;
    room.players[pid] = { lastSeen: Date.now(), queue: [] };

    console.log(`Room ${code}: slot ${pid} joined (${Object.keys(room.players).length} connected)`);
    res.json({ pid });
});

// POST /broadcast   body: {"code":1234,"pid":0,"data":"0,5,255"}
app.post("/broadcast", (req, res) => {
    let body;
    try { body = JSON.parse(req.body); }
    catch (e) { return res.status(400).json({ error: "bad json" }); }

    const { code, pid, data } = body;
    const room = rooms[code];
    if (!room) return res.json({ ok: false });

    for (const [opStr, other] of Object.entries(room.players)) {
        if (parseInt(opStr) !== pid) other.queue.push(data);
    }
    res.json({ ok: true });
});

// GET /poll?code=1234&pid=0   → {"packets":["0,5,255","2,0,10,20,1"]}
app.get("/poll", (req, res) => {
    const code = parseInt(req.query.code);
    const pid  = parseInt(req.query.pid);

    const room = rooms[code];
    if (!room || !room.players[pid]) return res.json({ packets: [] });

    room.players[pid].lastSeen = Date.now();
    const packets = room.players[pid].queue;
    room.players[pid].queue = [];
    res.json({ packets });
});

// POST /leave   body: {"code":1234,"pid":0}
app.post("/leave", (req, res) => {
    let body;
    try { body = JSON.parse(req.body); }
    catch (e) { return res.status(400).json({ error: "bad json" }); }

    const { code, pid } = body;
    const room = rooms[code];
    if (!room || !room.players[pid]) return res.json({ ok: false });

    const leaveMsg = `1,${pid}`;
    for (const [opStr, other] of Object.entries(room.players)) {
        if (parseInt(opStr) !== pid) other.queue.push(leaveMsg);
    }
    delete room.players[pid];
    room.slots[pid] = false;

    console.log(`Room ${code}: slot ${pid} left`);
    if (Object.keys(room.players).length === 0) {
        delete rooms[code];
        console.log(`Room ${code} cleaned up`);
    }
    res.json({ ok: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`HTTP relay listening on port ${PORT}`));
