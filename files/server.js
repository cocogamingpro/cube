const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

// ---------- Config ----------
const PLATFORM_RADIUS = 12; // platform spans -12..12 on x and z (25x25)
const PALETTE_SIZE = 10; // must match the client palette length
const MAX_BLOCKS = 20000; // per world
const MAX_ROOMS = 200;
const MAX_PLAYERS = 16; // per world
const EMPTY_TTL = 5 * 60 * 1000; // empty worlds are deleted after 5 min
const BOUNDS = { x: 60, z: 60, yMin: 0, yMax: 40 };
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

const key = (x, y, z) => `${x},${y},${z}`;

// ---------- Worlds ("rooms") ----------
// Each world has its own blocks + players. Players join with a 5-letter code.
const rooms = new Map(); // code -> { code, blocks, players, emptySince }

function newCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = { code: newCode(), blocks: new Map(), players: new Map(), emptySince: Date.now() };
  for (let x = -PLATFORM_RADIUS; x <= PLATFORM_RADIUS; x++) {
    for (let z = -PLATFORM_RADIUS; z <= PLATFORM_RADIUS; z++) {
      room.blocks.set(key(x, 0, z), (x + z) % 2 === 0 ? 8 : 9); // checkerboard
    }
  }
  rooms.set(room.code, room);
  return room;
}

// ---------- HTTP ----------
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Helpers ----------
let nextId = 1;

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

const send = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};
const roomBroadcast = (room, obj, except) => {
  const data = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws !== except && p.ws.readyState === 1) p.ws.send(data);
  }
};
const publicPlayer = ({ id, name, color, x, y, z, ry }) => ({ id, name, color, x, y, z, ry });

const cleanName = (n, id) => {
  const name = String(n ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16);
  return name || `Player${id}`;
};

const isInt = (n) => Number.isInteger(n);
const validBlockPos = (x, y, z) =>
  isInt(x) && isInt(y) && isInt(z) &&
  Math.abs(x) <= BOUNDS.x && Math.abs(z) <= BOUNDS.z &&
  y >= BOUNDS.yMin && y <= BOUNDS.yMax;

function enterRoom(ws, room, name) {
  const id = nextId++;
  const player = { id, name: cleanName(name, id), x: 0, y: 2, z: 0, ry: 0, color: randomColor(), ws };
  room.players.set(id, player);
  room.emptySince = null;
  ws.room = room;
  ws.player = player;

  const blockList = [];
  for (const [k, c] of room.blocks) {
    const [x, y, z] = k.split(",").map(Number);
    blockList.push([x, y, z, c]);
  }
  send(ws, {
    type: "init",
    id,
    code: room.code,
    name: player.name,
    color: player.color,
    blocks: blockList,
    players: [...room.players.values()].filter((p) => p.id !== id).map(publicPlayer),
  });
  roomBroadcast(room, { type: "join", player: publicPlayer(player) }, ws);
}

function leaveRoom(ws) {
  const { room, player } = ws;
  if (!room) return;
  room.players.delete(player.id);
  roomBroadcast(room, { type: "leave", id: player.id });
  if (room.players.size === 0) room.emptySince = Date.now();
  ws.room = null;
  ws.player = null;
}

// ---------- Connections ----------
wss.on("connection", (ws) => {
  ws.room = null;
  ws.player = null;
  ws.isAlive = true;
  ws.msgCount = 0;
  ws.lastChat = 0;

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    if (++ws.msgCount > 400) return; // very small flood protection

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // --- Lobby messages ---
    if (msg.type === "host") {
      if (ws.room) return;
      if (rooms.size >= MAX_ROOMS) return send(ws, { type: "error", message: "The server is full. Try again later." });
      return enterRoom(ws, createRoom(), msg.name);
    }
    if (msg.type === "join") {
      if (ws.room) return;
      const room = rooms.get(String(msg.code ?? "").toUpperCase().trim());
      if (!room) return send(ws, { type: "error", message: "No world with that code. Check it and try again." });
      if (room.players.size >= MAX_PLAYERS) return send(ws, { type: "error", message: "That world is full." });
      return enterRoom(ws, room, msg.name);
    }
    if (msg.type === "leave") return leaveRoom(ws);

    // --- In-world messages ---
    const room = ws.room;
    if (!room) return;
    const player = ws.player;

    switch (msg.type) {
      case "move": {
        const { x, y, z, ry } = msg;
        if (![x, y, z, ry].every(Number.isFinite)) return;
        Object.assign(player, { x, y, z, ry });
        roomBroadcast(room, { type: "move", id: player.id, x, y, z, ry }, ws);
        break;
      }
      case "place": {
        const { x, y, z, c } = msg;
        if (!validBlockPos(x, y, z)) return;
        if (!isInt(c) || c < 0 || c >= PALETTE_SIZE) return;
        if (room.blocks.has(key(x, y, z)) || room.blocks.size >= MAX_BLOCKS) return;
        room.blocks.set(key(x, y, z), c);
        roomBroadcast(room, { type: "set", x, y, z, c });
        break;
      }
      case "break": {
        const { x, y, z } = msg;
        if (!validBlockPos(x, y, z)) return;
        if (!room.blocks.delete(key(x, y, z))) return;
        roomBroadcast(room, { type: "del", x, y, z });
        break;
      }
      case "chat": {
        const now = Date.now();
        if (now - ws.lastChat < 400) return; // max ~2 messages/second
        const text = String(msg.text ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
        if (!text) return;
        ws.lastChat = now;
        roomBroadcast(room, { type: "chat", id: player.id, name: player.name, color: player.color, text });
        break;
      }
    }
  });

  ws.on("close", () => leaveRoom(ws));
});

// Reset flood counters every second.
setInterval(() => {
  for (const ws of wss.clients) ws.msgCount = 0;
}, 1000);

// Delete worlds that have been empty for a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0 && room.emptySince && now - room.emptySince > EMPTY_TTL) rooms.delete(code);
  }
}, 30000);

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
