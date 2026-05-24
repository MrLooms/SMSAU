// SMS Among Us - WebSocket Relay Server
// Deploy to Render.com (or Fly.io) as a Node.js web service.
//
// All players connect via WebSocket.  The server routes game packets between
// members of the same room.  No polling required — packets are delivered the
// instant they arrive.

const WebSocket = require('ws');
const http      = require('http');

// Plain HTTP server so Render health-checks pass and WebSocket upgrades work.
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SMS Among Us WS Relay');
});

const wss = new WebSocket.Server({ server });

// rooms[code] = { slots: bool[10], players: Map<pid, ws> }
const rooms = {};

// Send the NET_MSG.PLAYER_LEAVE CSV packet to everyone else in the room,
// then clean up the slot.
function cleanup_player(code, pid) {
    const room = rooms[code];
    if (!room) return;

    const leaveMsg = `1,${pid}`; // NET_MSG.PLAYER_LEAVE = 1
    for (const [opid, ows] of room.players) {
        if (opid !== pid && ows.readyState === WebSocket.OPEN) {
            try { ows.send(leaveMsg); } catch (_) {}
        }
    }

    room.players.delete(pid);
    room.slots[pid] = false;

    if (room.players.size === 0) {
        delete rooms[code];
        console.log(`Room ${code} cleaned up`);
    }
}

wss.on('connection', (ws) => {
    let myCode = null;
    let myPid  = -1;

    ws.on('message', (raw) => {
        const msg = raw.toString();

        if (msg.startsWith('{')) {
            // ---- Control message (JSON) ----
            let parsed;
            try { parsed = JSON.parse(msg); } catch (_) { return; }

            if (parsed.type === 'join') {
                const code   = parsed.code;
                const create = parsed.create === true;

                if (typeof code !== 'number' || code < 1000 || code > 9999) {
                    ws.send(JSON.stringify({ type: 'error', msg: 'bad code' }));
                    return;
                }

                if (create) {
                    // Close any stale room with the same code
                    if (rooms[code]) {
                        for (const [, ows] of rooms[code].players) {
                            try { ows.close(); } catch (_) {}
                        }
                    }
                    rooms[code] = { slots: new Array(10).fill(false), players: new Map() };
                } else if (!rooms[code]) {
                    ws.send(JSON.stringify({ type: 'error', msg: 'room not found' }));
                    return;
                }

                const room = rooms[code];
                const pid  = room.slots.findIndex(s => !s);
                if (pid === -1) {
                    ws.send(JSON.stringify({ type: 'error', msg: 'room full' }));
                    return;
                }

                room.slots[pid] = true;
                room.players.set(pid, ws);
                myCode = code;
                myPid  = pid;

                ws.send(JSON.stringify({ type: 'joined', pid }));
                console.log(`Room ${code}: pid ${pid} joined (${room.players.size} players)`);
            }
            // Ignore unknown control message types.

        } else {
            // ---- Game packet (raw CSV) — fan out to all other room members ----
            if (myCode === null) return;
            const room = rooms[myCode];
            if (!room) return;

            for (const [opid, ows] of room.players) {
                if (opid !== myPid && ows.readyState === WebSocket.OPEN) {
                    try { ows.send(msg); } catch (_) {}
                }
            }
        }
    });

    ws.on('close', () => {
        if (myCode !== null && myPid >= 0) {
            console.log(`Room ${myCode}: pid ${myPid} disconnected`);
            cleanup_player(myCode, myPid);
        }
    });

    ws.on('error', (err) => {
        console.error('WS error:', err.message);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`WS relay listening on port ${PORT}`));
