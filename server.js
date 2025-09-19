const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const rooms = {}; // { CODE: { ownerId, players:[{id,name,score}], started:false } }

// generate random 4-letter code
function genCode() {
  return crypto.randomBytes(2).toString("hex").toUpperCase();
}

// REST: create room
app.post("/api/create", (req, res) => {
  const name = req.body.name?.trim();
  if (!name) return res.status(400).json({ error: "Missing name" });

  let code;
  do {
    code = genCode();
  } while (rooms[code]);

  rooms[code] = {
    ownerId: null, // assigned later when socket joins
    players: [],
    started: false,
    currentQ: null,
  };

  res.json({ code });
});

// REST: join validation
app.post("/api/join", (req, res) => {
  const code = String(req.body.code || "").toUpperCase();
  const name = req.body.name?.trim();
  if (!rooms[code]) return res.status(404).json({ error: "Room not found" });
  if (!name) return res.status(400).json({ error: "Missing name" });
  res.json({ ok: true });
});

// --- socket.io ---
io.on("connection", (socket) => {
  console.log("connected", socket.id);

  socket.on("createRoomSocket", ({ name }, cb) => {
    const code = genCode();
    rooms[code] = {
      ownerId: socket.id,
      players: [{ id: socket.id, name, score: 0 }],
      started: false,
      currentQ: null,
    };
    socket.join(code);
    cb({ success: true, code });
    io.to(code).emit("playerList", { players: rooms[code].players, owner: rooms[code].ownerId });
  });

  socket.on("joinRoom", ({ code, name, isOwner }, cb) => {
    code = String(code || "").toUpperCase();
    if (!rooms[code]) return cb({ success: false, message: "Room not found" });
    const room = rooms[code];
    if (room.started) return cb({ success: false, message: "Game already started" });

    if (isOwner && !room.ownerId) {
      room.ownerId = socket.id;
    }

    const existing = room.players.find(p => p.id === socket.id);
    if (!existing) {
      room.players.push({ id: socket.id, name, score: 0 });
    }

    socket.join(code);
    cb({ success: true, owner: room.ownerId, players: room.players });
    io.to(code).emit("playerList", { players: room.players, owner: room.ownerId });
  });

  socket.on("startGame", (code) => {
    if (!rooms[code]) return;
    const room = rooms[code];
    if (room.ownerId !== socket.id) return;
    room.started = true;
    io.to(code).emit("goToGamePage");
  });

  socket.on("kickPlayer", ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.ownerId !== socket.id) return;
    room.players = room.players.filter(p => p.id !== targetId);
    io.to(targetId).emit("kicked");
    io.to(code).emit("playerList", { players: room.players, owner: room.ownerId });
  });

  socket.on("createQuestion", ({ code, question, options, correctIndexes, duration, points }) => {
    const room = rooms[code];
    if (!room || room.ownerId !== socket.id) return;
    room.currentQ = { question, options, correctIndexes, duration, points, answers: {} };
    io.to(code).emit("questionStarted", { question, options, duration });
    setTimeout(() => endQuestion(code), duration * 1000);
  });

  socket.on("submitAnswer", ({ code, selections }) => {
    const room = rooms[code];
    if (!room?.currentQ) return;
    room.currentQ.answers[socket.id] = selections;
  });

  socket.on("endQuestionNow", (code) => {
    const room = rooms[code];
    if (room?.ownerId === socket.id) endQuestion(code);
  });

  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.ownerId === socket.id) {
        io.to(code).emit("roomClosed");
        delete rooms[code];
      } else {
        io.to(code).emit("playerList", { players: room.players, owner: room.ownerId });
      }
    }
  });
});

function endQuestion(code) {
  const room = rooms[code];
  if (!room?.currentQ) return;
  const q = room.currentQ;

  const results = [];
  for (const player of room.players) {
    const selections = q.answers[player.id] || [];
    const correct = selections.length === q.correctIndexes.length &&
      selections.every(idx => q.correctIndexes.includes(idx));
    const awarded = correct ? q.points : 0;
    player.score += awarded;
    results.push({ id: player.id, correct, awarded });
  }

  io.to(code).emit("questionEnded", { results, correctIndexes: q.correctIndexes });
  io.to(code).emit("leaderboard", room.players);
  room.currentQ = null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server on " + PORT));
