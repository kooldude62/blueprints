// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Debug endpoint to see rooms in memory
app.get("/api/debugRooms", (req, res) => res.json(rooms));

// -------------------- ROOM STORAGE --------------------
const rooms = {}; // rooms[code] = { ownerId, players[], started, pendingOwnerName }

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// -------------------- REST ENDPOINTS --------------------

// Create a room (with pending owner name until socket joins)
app.post("/api/create", (req, res) => {
  const name = req.body.name?.trim();
  if (!name) return res.status(400).json({ error: "Missing name" });

  let code;
  do {
    code = genCode();
  } while (rooms[code]);

  rooms[code] = {
    ownerId: null,
    players: [],
    started: false,
    currentQuestion: null,
    timer: null,
    pendingOwnerName: name
  };

  res.json({ code });
});

// Validate join (before socket connects)
app.post("/api/join", (req, res) => {
  let { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: "Missing code or name" });

  code = String(code).trim().toUpperCase();
  const room = rooms[code];
  if (!room) return res.status(404).json({ error: "Room not found" });

  if (room.started && !room.players.find(p => p.name === name)) {
    return res.status(400).json({ error: "Game already started" });
  }

  if (room.players.find(p => p.name === name)) {
    return res.status(409).json({ error: "Name already taken" });
  }

  return res.json({ ok: true });
});

// -------------------- SOCKET HANDLERS --------------------
io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  // Join a room
  socket.on("joinRoom", ({ code, name, isOwner }, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ success: false, message: "Room not found" });

    // Claim ownership if this socket is supposed to be owner
    if (isOwner && !room.ownerId && room.pendingOwnerName === name) {
      room.ownerId = socket.id;
      delete room.pendingOwnerName;
    }

    // Game already started check
    if (room.started) {
      const existing = room.players.find(p => p.name === name);
      if (!existing) return cb?.({ success: false, message: "Game already started" });
      // reconnect logic
      existing.id = socket.id;
      socket.join(code);
      io.to(code).emit("playerList", { players: room.players, owner: room.ownerId });
      return cb?.({ success: true, code, owner: room.ownerId, players: room.players });
    }

    // prevent name collision
    if (room.players.find(p => p.name === name)) {
      return cb?.({ success: false, message: "Name already taken" });
    }

    // add player
    room.players.push({ id: socket.id, name, score: 0 });
    socket.join(code);

    io.to(code).emit("playerList", { players: room.players, owner: room.ownerId });
    cb?.({ success: true, code, owner: room.ownerId, players: room.players });
  });

  // Kick player
  socket.on("kickPlayer", ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return;
    if (room.ownerId !== socket.id) return;

    room.players = room.players.filter(p => p.id !== targetId);
    io.to(targetId).emit("kicked");
    io.to(code).emit("playerList", { players: room.players, owner: room.ownerId });
  });

  // Start game
  socket.on("startGame", (code) => {
    const room = rooms[code];
    if (!room) return;
    if (room.ownerId !== socket.id) return;

    room.started = true;
    io.to(code).emit("goToGamePage");
    io.to(code).emit("playerList", { players: room.players, owner: room.ownerId });
  });

  // Disconnect handling
  socket.on("disconnect", () => {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (!room) continue;
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const wasOwner = room.ownerId === socket.id;
        room.players.splice(idx, 1);
        if (wasOwner) {
          io.to(code).emit("roomClosed");
          delete rooms[code];
        } else {
          io.to(code).emit("playerList", { players: room.players, owner: room.ownerId });
        }
        break;
      }
    }
  });
});

// -------------------- START SERVER --------------------
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
