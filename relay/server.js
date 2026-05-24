// SMS Among Us - HTTP Relay Server (long-poll edition)
// Deploy to Render.com (or Fly.io) as a Node.js web service.
//
// Long polling: GET /poll holds the connection open for up to LONG_POLL_MS.
// When a broadcast arrives the server wakes the waiting response immediately,
// so the client receives the packet in one round-trip instead of two.

const express = require("express");
const cors    = require("cors");
const app     = express();

const LONG_POLL_MS = 5000; // max ms to hold a poll open with no data

app.use(cors());

// Read raw POST body as a string regardless of Content-Type.
// http_post_string in GameMaker GXC often omits the Content-Type header.
app.use((req, res, next) => {
    if (req.method !== "POST") return next();
    let raw = "";
    req.on("data", chunk => { raw += chunk.toString(); });
    req.on("end", () => { req.body = raw; next(); });
});

// rooms[code] = {
//   slots: bool[10],
//   players: { pid: { lastSeen, queue[], waitRes, waitTimer } }
// }
const rooms = {};

// Flush queued packets to a waiting long-poll response, if any.
function flushWaiting(player) {
    if (!player.waitRes) return;
    if (player.queue.length === 0) return;
    clearTimeout(player.waitTimer);
    const packets = player.queue;
    player.queue   = [];
    const res      = player.waitRes;
    player.waitRes = null;
    res.json({ packets });
}

// Remove players inactive for >30s, clean up empty rooms.
setInterval(() => {
    const now = Date.now();
    for (const code of Object.keys(rooms)) {
        const room = rooms[code];
        for (const pidStr of Object.keys(room.players)) {
            const player = room.players[pidStr];
            if (now - player.lastSeen > 30000) {
                console.log(`Room ${code}: slot ${pidStr} timed out`);
                // Cancel any waiting long-poll
                if (player.waitRes) {
                    clearTimeout(player.waitTimer);
                    player.waitRes.json({ packets: [] });
                    player.waitRes = null;
                }
                // Notify others with a PLAYER_LEAVE packet
                const leaveMsg = `1,${pidStr}`;
                for (const [op, other] of Object.entries(room.players)) {
                    if (op !== pidStr) {
                        other.queue.push(leaveMsg);
                        flushWaiting(other);
                    }
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
//              body: {"code":1234}                 (client — room must exist)
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
        rooms[code] = { slots: new Array(10).fill(false), players: {} };
    } else if (!rooms[code]) {
        return res.status(404).json({ error: "room not found" });
    }

    const room = rooms[code];
    const pid  = room.slots.findIndex(s => !s);
    if (pid === -1) return res.status(503).json({ error: "room full" });

    room.slots[pid]    = true;
    room.players[pid]  = { lastSeen: Date.now(), queue: [], waitRes: null, waitTimer: null };

    console.log(`Room ${code}: slot ${pid} joined (${Object.keys(room.players).length} connected)`);
    res.json({ pid });
});

// POST /broadcast   body: {"code":1234,"pid":0,"data":"0,5,255"}
// Queues data for all other players and wakes any waiting long-poll immediately.
app.post("/broadcast", (req, res) => {
    let body;
    try { body = JSON.parse(req.body); }
    catch (e) { return res.status(400).json({ error: "bad json" }); }

    const { code, pid, data } = body;
    const room = rooms[code];
    if (!room) return res.json({ ok: false });

    for (const [opStr, other] of Object.entries(room.players)) {
        if (parseInt(opStr) !== pid) {
            other.queue.push(data);
            flushWaiting(other); // wake immediately if they're waiting
        }
    }
    res.json({ ok: true });
});

// GET /poll?code=1234&pid=0   → {"packets":["0,5,255","2,0,10,20,1"]}
// If the queue is empty, holds the connection for up to LONG_POLL_MS.
app.get("/poll", (req, res) => {
    const code = parseInt(req.query.code);
    const pid  = parseInt(req.query.pid);

    const room = rooms[code];
    if (!room || !room.players[pid]) return res.json({ packets: [] });

    const player    = room.players[pid];
    player.lastSeen = Date.now();

    // Deliver queued packets immediately if available
    if (player.queue.length > 0) {
        const packets  = player.queue;
        player.queue   = [];
        return res.json({ packets });
    }

    // Nothing queued — hold connection until broadcast arrives or timeout
    player.waitRes   = res;
    player.waitTimer = setTimeout(() => {
        if (player.waitRes === res) {
            player.waitRes = null;
            res.json({ packets: [] });
        }
    }, LONG_POLL_MS);
});

// POST /leave   body: {"code":1234,"pid":0}
app.post("/leave", (req, res) => {
    let body;
    try { body = JSON.parse(req.body); }
    catch (e) { return res.status(400).json({ error: "bad json" }); }

    const { code, pid } = body;
    const room = rooms[code];
    if (!room || !room.players[pid]) return res.json({ ok: false });

    // Cancel any waiting long-poll for this player
    const player = room.players[pid];
    if (player.waitRes) {
        clearTimeout(player.waitTimer);
        player.waitRes.json({ packets: [] });
        player.waitRes = null;
    }

    const leaveMsg = `1,${pid}`;
    for (const [opStr, other] of Object.entries(room.players)) {
        if (parseInt(opStr) !== pid) {
            other.queue.push(leaveMsg);
            flushWaiting(other);
        }
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
app.listen(PORT, () => console.log(`HTTP relay (long-poll) listening on port ${PORT}`));
