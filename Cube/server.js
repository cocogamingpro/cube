const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

// ---------- World config ----------
const PLATFORM_RADIUS = 12; // platform spans -12..12 on x and z (25x25)
const PALETTE_SIZE = 10; // must match the client palette length
const MAX_BLOCKS = 20000;
const BOUNDS = { x: 60, z: 60, yMin: 0, yMax: 40 };

// Blocks live in memory: "x,y,z" -> colour index.
// (The world resets whenever the server restarts.)
const blocks = new Map();
const key = (x, y, z) => `${x},${y},${z}`;

for (let x = -PLATFORM_RADIUS; x <= PLATFORM_RADIUS; x++) {
  for (let z = -PLATFORM_RADIUS; z <= PLATFORM_RADIUS; z++) {
    blocks.set(key(x, 0, z), (x + z) % 2 === 0 ? 8 : 9); // checkerboard
  }
}

// ---------- HTTP ----------
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Players ----------
const players = new Map(); // id -> { id, x, y, z, ry, color }
let nextId = 1;

const randomColor = () => {
  const hue = Math.floor(Math.random() * 360);
  // HSL -> hex int (saturation 65%, lightness 55%)
  const s = 0.65, l = 0.55;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const to255 = (v) => Math.round(v * 255);
  return (to255(f(0)) << 16) | (to255(f(8)) << 8) | to255(f(4));
};

const send = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};
const broadcast = (obj, except) => {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === 1) client.send(data);
  }
};

const isInt = (n) => Number.isInteger(n);
const validBlockPos = (x, y, z) =>
  isInt(x) && isInt(y) && isInt(z) &&
  Math.abs(x) <= BOUNDS.x && Math.abs(z) <= BOUNDS.z &&
  y >= BOUNDS.yMin && y <= BOUNDS.yMax;

wss.on("connection", (ws) => {
  const id = nextId++;
  const player = { id, x: 0, y: 2, z: 0, ry: 0, color: randomColor() };
  players.set(id, player);
  ws.playerId = id;
  ws.isAlive = true;
  ws.msgCount = 0;

  // Send the full world + everyone currently online to the new player.
  const blockList = [];
  for (const [k, c] of blocks) {
    const [x, y, z] = k.split(",").map(Number);
    blockList.push([x, y, z, c]);
  }
  send(ws, {
    type: "init",
    id,
    color: player.color,
    blocks: blockList,
    players: [...players.values()].filter((p) => p.id !== id),
  });
  broadcast({ type: "join", player }, ws);

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    // Very small flood protection.
    if (++ws.msgCount > 400) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "move": {
        const { x, y, z, ry } = msg;
        if (![x, y, z, ry].every(Number.isFinite)) return;
        Object.assign(player, { x, y, z, ry });
        broadcast({ type: "move", id, x, y, z, ry }, ws);
        break;
      }
      case "place": {
        const { x, y, z, c } = msg;
        if (!validBlockPos(x, y, z)) return;
        if (!isInt(c) || c < 0 || c >= PALETTE_SIZE) return;
        if (blocks.has(key(x, y, z)) || blocks.size >= MAX_BLOCKS) return;
        blocks.set(key(x, y, z), c);
        broadcast({ type: "set", x, y, z, c });
        break;
      }
      case "break": {
        const { x, y, z } = msg;
        if (!validBlockPos(x, y, z)) return;
        if (!blocks.delete(key(x, y, z))) return;
        broadcast({ type: "del", x, y, z });
        break;
      }
    }
  });

  ws.on("close", () => {
    players.delete(id);
    broadcast({ type: "leave", id });
  });
});

// Reset flood counters every second.
setInterval(() => {
  for (const ws of wss.clients) ws.msgCount = 0;
}, 1000);

// Heartbeat: drop dead connections and keep proxies from idling the socket.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`Block Platform running on port ${PORT}`));
