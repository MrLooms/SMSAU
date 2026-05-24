// SMS Among Us — WebSocket Relay Server
// Deploy on Render (render.com) as a Node web service.
// Build command: npm install   Start command: node server.js

const WebSocket = require('ws');
const PORT = process.env.PORT || 3000;

// rooms[code] = [ws|null, ...] — up to 10 slots indexed by player_id
const rooms = {};

const wss = new WebSocket.Server({ port: PORT });
console.log(`SMS Among Us relay running on port ${PORT}`);

wss.on('connection', ws => {
    let room = null;
    let slot = -1;

    ws.on('message', (data, isBinary) => {
        if (!Buffer.isBuffer(data)) data = Buffer.from(data);

        // --------------------------------------------------------
        // Before the room-join we may receive GameMaker's
        // proprietary "GMS handshake" bytes (desktop runner only).
        // The handshake expects its data to be echoed back.
        // Our room-join packet always starts with 0xFD, so anything
        // else here is a GMS handshake step — just echo it and wait.
        // HTML5 builds use the browser's native WebSocket and skip
        // the GMS handshake entirely, so this branch is never hit.
        // --------------------------------------------------------
        if (room === null) {
            if (data.length === 0 || data[0] !== 0xFD) {
                ws.send(data, { binary: true }); // echo GMS handshake
                return;
            }

            // Room-join handshake: [0xFD, code_hi, code_lo]
            if (data.length < 3) { ws.close(1008, 'bad handshake'); return; }
            const code = (data[1] << 8) | data[2];

            if (!rooms[code]) rooms[code] = new Array(10).fill(null);
            room = rooms[code];

            slot = room.findIndex(s => s === null);
            if (slot === -1) { ws.close(1013, 'room full'); return; }

            room[slot] = ws;

            // Tell the new player their assigned ID: [PLAYER_JOIN=0, slot, 255]
            ws.send(Buffer.from([0, slot, 255]));
            return;
        }

        // Regular game packet — broadcast to everyone else in the room
        for (let i = 0; i < room.length; i++) {
            if (i !== slot && room[i] && room[i].readyState === WebSocket.OPEN)
                room[i].send(data, { binary: true });
        }
    });

    ws.on('close', () => {
        if (room === null || slot === -1) return;
        room[slot] = null;

        // Notify everyone else this player left: [PLAYER_LEAVE=1, slot]
        const leaveMsg = Buffer.from([1, slot]);
        for (let i = 0; i < room.length; i++) {
            if (room[i] && room[i].readyState === WebSocket.OPEN)
                room[i].send(leaveMsg, { binary: true });
        }

        // Clean up empty rooms
        if (room.every(s => s === null)) {
            const key = Object.keys(rooms).find(k => rooms[k] === room);
            if (key !== undefined) delete rooms[key];
        }
    });

    ws.on('error', err => {
        console.error('socket error:', err.message);
    });
});
