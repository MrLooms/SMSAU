// SMS Among Us - WebSocket Relay Server
// Deploy to Render.com (free tier) as a Node.js web service.
// All players connect here; the relay routes packets within a room.

const WebSocket = require("ws");
const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({ port: PORT });
const rooms = {}; // { roomCode: [ws|null, ...] }  (max 10 slots)

console.log(`Relay listening on port ${PORT}`);

wss.on("connection", (ws) => {
    let room = null;   // array of slots for this room
    let slot = -1;     // this client's slot index

    ws.on("message", (data, isBinary) => {
        // data is always a Buffer from the ws library
        if (!Buffer.isBuffer(data)) data = Buffer.from(data);

        // ---- Room-join handshake ----
        // Client sends [0xFD, code_hi, code_lo] before any game packets.
        if (room === null) {
            if (data.length < 3 || data[0] !== 0xFD) {
                // Not a join packet; echo it back (handles GMS desktop handshake)
                ws.send(data);
                return;
            }

            const code = (data[1] << 8) | data[2];
            if (!rooms[code]) rooms[code] = new Array(10).fill(null);
            room = rooms[code];

            slot = room.findIndex(s => s === null);
            if (slot === -1) {
                // Room full
                ws.close(1008, "Room full");
                return;
            }
            room[slot] = ws;

            // Tell the client its player ID slot (NET_MSG.PLAYER_JOIN = 0, flag 255 = ID assignment)
            ws.send(Buffer.from([0, slot, 255]));
            console.log(`Room ${code}: slot ${slot} joined (${room.filter(Boolean).length} connected)`);
            return;
        }

        // ---- Broadcast to everyone else in the room ----
        for (let i = 0; i < room.length; i++) {
            if (i !== slot && room[i] && room[i].readyState === WebSocket.OPEN) {
                room[i].send(data);
            }
        }
    });

    ws.on("close", () => {
        if (room === null || slot === -1) return;
        room[slot] = null;
        console.log(`Slot ${slot} disconnected`);

        // Notify remaining players (NET_MSG.PLAYER_LEAVE = 1)
        const leaveMsg = Buffer.from([1, slot]);
        for (let i = 0; i < room.length; i++) {
            if (room[i] && room[i].readyState === WebSocket.OPEN) {
                room[i].send(leaveMsg);
            }
        }

        // Clean up empty room
        if (room.every(s => s === null)) {
            const code = Object.keys(rooms).find(k => rooms[k] === room);
            if (code) {
                delete rooms[code];
                console.log(`Room ${code} cleaned up`);
            }
        }
    });

    ws.on("error", (err) => {
        console.error(`Socket error (slot ${slot}):`, err.message);
    });
});
