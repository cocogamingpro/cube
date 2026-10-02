const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

// ---------- Config ----------
const PLATFORM_RADIUS = 12; // platform spans -12..12 on x and z (25x25)
const PALETTE_SIZE = 10; // must match the client palette length
const MAX_BLOCKS = 20000; // per world
const MAX_ROOMS = 50;
const MAX_PLAYERS = 12; // per world
const BOUNDS = { x: 60, z: 60, yMin: 0, yMax: 40 };
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

const key = (x, y, z) => `${x},${y},${z}`;

// ---------- Worlds (rooms) ----------
// code -> { code, blocks: Map, players: Map, hostId, open }
// Everything lives in memory: a world disappears when its last player leaves.
const rooms = new Map();

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const blocks = new Map();
  for (let x = -PLATFORM_RADIUS; x <= PLATFORM_RADIUS; x++) {
    for (let z = -PLATFORM_RADIUS; z <= PLATFORM_RADIUS; z++) {
      blocks.set(key(x, 0, z), (x + z) % 2 === 0 ? 8 : 9); // checkerboard
    }
  }
  const room = { code: makeCode(), blocks, players: new Map(), hostId: null, open: false };
  rooms.set(room.code, room);
  return room;
}

// ---------- Helpers ----------
const send = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};
const broadcast = (room, obj, exceptWs) => {
  const data = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws !== exceptWs && p.ws.readyState === 1) p.ws.send(data);
  }
};
const publicPlayer = (p) => ({
  id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, z: p.z, ry: p.ry,
});

const randomColor = () => {
  const hue = Math.floor(Math.random() * 360);
  const s = 0.65, l = 0.55;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const to255 = (v) => Math.round(v * 255);
  return (to255(f(0)) << 16) | (to255(f(8)) << 8) | to255(f(4));
};

const cleanName = (raw) =>
  String(raw ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16) || "Player";
const cleanText = (raw) =>
  String(raw ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);

const isInt = Number.isInteger;
const validBlockPos = (x, y, z) =>
  isInt(x) && isInt(y) && isInt(z) &&
  Math.abs(x) <= BOUNDS.x && Math.abs(z) <= BOUNDS.z &&
  y >= BOUNDS.yMin && y <= BOUNDS.yMax;

let nextId = 1;

function joinRoom(ws, room, name) {
  const id = nextId++;
  const player = {
    id, ws, name: cleanName(name), color: randomColor(),
    x: 0, y: 2, z: 0, ry: 0, lastChat: 0,
  };
  room.players.set(id, player);
  if (room.hostId === null) room.hostId = id;
  ws.room = room;
  ws.playerId = id;

  const blockList = [];
  for (const [k, c] of room.blocks) {
    const [x, y, z] = k.split(",").map(Number);
    blockList.push([x, y, z, c]);
  }
  send(ws, {
    type: "init",
    id,
    code: room.code,
    open: room.open,
    hostId: room.hostId,
    blocks: blockList,
    players: [...room.players.values()].filter((p) => p.id !== id).map(publicPlayer),
  });
  broadcast(room, { type: "join", player: publicPlayer(player) }, ws);
  broadcast(room, { type: "chat", system: true, text: `${player.name} joined` });
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  const player = room.players.get(ws.playerId);
  room.players.delete(ws.playerId);
  ws.room = null;

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  broadcast(room, { type: "leave", id: ws.playerId });
  if (player) broadcast(room, { type: "chat", system: true, text: `${player.name} left` });

  if (room.hostId === ws.playerId) {
    room.hostId = room.players.keys().next().value;
    broadcast(room, { type: "host", id: room.hostId });
  }
}

// ---------- HTTP + WebSocket ----------
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.room = null;
  ws.isAlive = true;
  ws.msgCount = 0;

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    if (++ws.msgCount > 400) return; // flood protection (reset every second)

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // --- Not in a world yet: only create / join are allowed ---
    if (!ws.room) {
      if (msg.type === "create") {
        if (rooms.size >= MAX_ROOMS) {
          return send(ws, { type: "error", message: "The server is full. Try again later." });
        }
        joinRoom(ws, createRoom(), msg.name);
      } else if (msg.type === "join") {
        const code = String(msg.code ?? "").trim().toUpperCase();
        const room = rooms.get(code);
        if (!room || !room.open) {
          return send(ws, { type: "error", message: "No open world with that code." });
        }
        if (room.players.size >= MAX_PLAYERS) {
          return send(ws, { type: "error", message: "That world is full." });
        }
        joinRoom(ws, room, msg.name);
      }
      return;
    }

    // --- In a world ---
    const room = ws.room;
    const player = room.players.get(ws.playerId);
    if (!player) return;

    switch (msg.type) {
      case "move": {
        const { x, y, z, ry } = msg;
        if (![x, y, z, ry].every(Number.isFinite)) return;
        Object.assign(player, { x, y, z, ry });
        broadcast(room, { type: "move", id: player.id, x, y, z, ry }, ws);
        break;
      }
      case "place": {
        const { x, y, z, c } = msg;
        if (!validBlockPos(x, y, z)) return;
        if (!isInt(c) || c < 0 || c >= PALETTE_SIZE) return;
        if (room.blocks.has(key(x, y, z)) || room.blocks.size >= MAX_BLOCKS) return;
        room.blocks.set(key(x, y, z), c);
        broadcast(room, { type: "set", x, y, z, c });
        break;
      }
      case "break": {
        const { x, y, z } = msg;
        if (!validBlockPos(x, y, z)) return;
        if (!room.blocks.delete(key(x, y, z))) return;
        broadcast(room, { type: "del", x, y, z });
        break;
      }
      case "chat": {
        const text = cleanText(msg.text);
        const now = Date.now();
        if (!text || now - player.lastChat < 400) return;
        player.lastChat = now;
        broadcast(room, { type: "chat", name: player.name, color: player.color, text });
        break;
      }
      case "open": {
        if (player.id !== room.hostId) return; // only the host can open/close
        room.open = !!msg.open;
        broadcast(room, { type: "open", open: room.open });
        break;
      }
    }
  });

  ws.on("close", () => leaveRoom(ws));
});

setInterval(() => {
  for (const ws of wss.clients) ws.msgCount = 0;
}, 1000);

// Heartbeat: drop dead connections and keep proxies from idling the socket.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`Cube running on port ${PORT}`));
