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
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// In-memory rooms (reset if server restarts)
const rooms = {}; 
// rooms[code] = { owner: socketId, players: { id:{id,name,score} }, started, currentQuestion, timer }

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// REST: create room
app.post("/api/create", (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Missing name" });
  const code = genCode();
  rooms[code] = {
    owner: null,
    players: {},
    started: false,
    currentQuestion: null,
    timer: null,
  };
  return res.json({ code });
});

// REST: join room validation
app.post("/api/join", (req, res) => {
  let { code, name } = req.body || {};
  if (!code || !name)
    return res.status(400).json({ error: "Missing code or name" });
  code = String(code).trim().toUpperCase();
  const room = rooms[code];
  if (!room) return res.status(404).json({ error: "Room not found" });

  if (room.started && !Object.values(room.players).some((p) => p.name === name)) {
    return res.status(400).json({ error: "Game already started" });
  }
  if (Object.values(room.players).some((p) => p.name === name))
    return res.status(409).json({ error: "Name already taken" });
  return res.json({ ok: true });
});

// Debugging endpoint
app.get("/api/rooms", (req, res) => res.json(rooms));

// ----------------- SOCKET HANDLERS -----------------
io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  // Join or reconnect
  socket.on("joinRoom", ({ code, name, isOwner }, cb) => {
    if (!code || !name)
      return cb?.({ success: false, message: "Missing code or name" });
    code = String(code).trim().toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ success: false, message: "Room not found" });

    // If room already started
    if (room.started) {
      const existingId = Object.keys(room.players).find(
        (id) => room.players[id].name === name
      );
      if (!existingId) {
        return cb?.({ success: false, message: "Game already started" });
      }
      // reconnect
      const old = room.players[existingId];
      delete room.players[existingId];
      room.players[socket.id] = { id: socket.id, name: old.name, score: old.score };
      socket.join(code);
      if (isOwner) room.owner = socket.id;
      io.to(code).emit("playerList", {
        players: Object.values(room.players),
        owner: room.owner,
      });
      return cb?.({
        success: true,
        code,
        owner: room.owner,
        players: Object.values(room.players),
      });
    }

    // Not started yet
    if (Object.values(room.players).some((p) => p.name === name)) {
      return cb?.({ success: false, message: "Name already taken" });
    }
    if (isOwner) {
      room.owner = socket.id;
    }
    room.players[socket.id] = { id: socket.id, name, score: 0 };
    socket.join(code);
    io.to(code).emit("playerList", {
      players: Object.values(room.players),
      owner: room.owner,
    });
    return cb?.({
      success: true,
      code,
      owner: room.owner,
      players: Object.values(room.players),
    });
  });

  // Kick player
  socket.on("kickPlayer", ({ code, targetId }) => {
    code = String(code).toUpperCase();
    const room = rooms[code];
    if (!room) return;
    if (room.owner !== socket.id) return;
    if (room.players[targetId]) {
      delete room.players[targetId];
      io.to(targetId).emit("kicked");
      io.to(code).emit("playerList", {
        players: Object.values(room.players),
        owner: room.owner,
      });
    }
  });

  // Start game
  socket.on("startGame", (code) => {
    code = String(code).toUpperCase();
    const room = rooms[code];
    if (!room) return;
    if (room.owner !== socket.id) return;
    room.started = true;
    io.to(code).emit("goToGamePage");
    io.to(code).emit("playerList", {
      players: Object.values(room.players),
      owner: room.owner,
    });
  });

  // Create question
  socket.on("createQuestion", ({ code, question, options, correctIndexes, duration, points }) => {
    code = String(code).toUpperCase();
    const room = rooms[code];
    if (!room) return;
    if (room.owner !== socket.id) return;
    if (room.currentQuestion) return;

    const dur = Math.max(1, Math.floor(duration || 10));
    const pts = Math.max(0, Math.floor(points || 1));
    room.currentQuestion = {
      question,
      options,
      correctIndexes: (correctIndexes || []).map(Number),
      duration: dur,
      points: pts,
      answers: {},
    };

    io.to(code).emit("questionStarted", { question, options, duration: dur });
    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => finishQuestion(code), dur * 1000);
  });

  // Submit answer
  socket.on("submitAnswer", ({ code, selections }) => {
    code = String(code).toUpperCase();
    const room = rooms[code];
    if (!room || !room.currentQuestion) return;
    if (room.currentQuestion.answers[socket.id]) return;
    room.currentQuestion.answers[socket.id] = Array.isArray(selections)
      ? selections.map(Number)
      : [Number(selections)];
    if (room.owner) {
      io.to(room.owner).emit("playerAnswered", {
        id: socket.id,
        name: room.players[socket.id]?.name,
      });
    }
  });

  socket.on("endQuestionNow", (code) => {
    code = String(code).toUpperCase();
    const room = rooms[code];
    if (!room || room.owner !== socket.id) return;
    finishQuestion(code);
  });

  // Disconnect
  socket.on("disconnect", () => {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (!room) continue;
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        if (room.owner === socket.id) {
          if (room.timer) clearTimeout(room.timer);
          io.to(code).emit("roomClosed");
          delete rooms[code];
        } else {
          io.to(code).emit("playerList", {
            players: Object.values(room.players),
            owner: room.owner,
          });
        }
        break;
      }
    }
  });

  // Helper: finish question
  function finishQuestion(code) {
    const room = rooms[code];
    if (!room || !room.currentQuestion) return;
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }

    const cq = room.currentQuestion;
    const correctSet = new Set(cq.correctIndexes);
    const results = [];

    for (const pid in room.players) {
      const player = room.players[pid];
      const sels = cq.answers[pid] || [];
      const selsSet = new Set(sels.map(Number));
      let isCorrect = false;
      if (selsSet.size === correctSet.size) {
        isCorrect = [...correctSet].every((i) => selsSet.has(i));
      }
      let awarded = 0;
      if (isCorrect) {
        player.score = (player.score || 0) + cq.points;
        awarded = cq.points;
      }
      results.push({
        id: pid,
        name: player.name,
        correct: isCorrect,
        awarded,
      });
    }

    room.currentQuestion = null;
    io.to(code).emit("questionEnded", {
      results,
      correctIndexes: Array.from(correctSet),
    });
    const leaderboard = Object.values(room.players).sort(
      (a, b) => (b.score || 0) - (a.score || 0)
    );
    io.to(code).emit("leaderboard", leaderboard);
    io.to(code).emit("playerList", {
      players: Object.values(room.players),
      owner: room.owner,
    });
  }
});

server.listen(PORT, () =>
  console.log(`Server listening on http://localhost:${PORT}`)
);
