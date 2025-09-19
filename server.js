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

// In-memory rooms (NOTE: not shared across multiple server instances)
const rooms = {}; 
// rooms[code] = { owner: socketId, players: { socketId: { id, name, score } }, started:false, currentQuestion:null, timer:null }

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// REST: create room (returns code)
app.post("/api/create", (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Missing name" });

  const code = genCode();
  rooms[code] = { owner: null, players: {}, started: false, currentQuestion: null, timer: null };
  // do not assign owner here — owner gets assigned on socket join (less racey)
  return res.json({ code });
});

// REST: check/join room before socket join (validate)
app.post("/api/join", (req, res) => {
  let { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: "Missing code or name" });
  code = String(code).trim().toUpperCase();
  const room = rooms[code];
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.started) return res.status(400).json({ error: "Game already started" });
  // name collision
  const taken = Object.values(room.players).some(p => p.name === name);
  if (taken) return res.status(409).json({ error: "Name already taken" });
  return res.json({ ok: true });
});

// debug endpoint
app.get("/api/rooms", (req, res) => res.json(rooms));

// ---------- Socket handlers ----------
io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  // Client requests to join after REST validation
  socket.on("joinRoom", ({ code, name, isOwner }, cb) => {
    if (!code || !name) {
      cb?.({ success: false, message: "Missing code or name" });
      return;
    }
    code = String(code).trim().toUpperCase();
    const room = rooms[code];
    if (!room) {
      cb?.({ success: false, message: "Room not found" });
      return;
    }
    if (room.started) {
      cb?.({ success: false, message: "Game already started" });
      return;
    }
    // duplicate name
    if (Object.values(room.players).some(p => p.name === name)) {
      cb?.({ success: false, message: "Name already taken in room" });
      return;
    }

    // If this socket is owner (owner clicks create and then joins), assign
    if (isOwner) room.owner = socket.id;

    // Add player
    room.players[socket.id] = { id: socket.id, name, score: 0 };
    socket.join(code);

    // Broadcast updated list + owner id so clients can decide who sees owner UI
    io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });

    cb?.({ success: true, code });
  });

  // Same safe create path using socket (if client prefers socket flow)
  socket.on("createRoomSocket", ({ name }, cb) => {
    if (!name) { cb?.({ success:false, message:"Missing name" }); return; }
    const code = genCode();
    rooms[code] = { owner: socket.id, players: { [socket.id]: { id: socket.id, name, score:0 } }, started:false, currentQuestion:null, timer:null };
    socket.join(code);
    io.to(code).emit("playerList", { players: Object.values(rooms[code].players), owner: rooms[code].owner });
    cb?.({ success: true, code });
  });

  // Kick
  socket.on("kickPlayer", ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return socket.emit("errorMsg", "Room not found");
    if (room.owner !== socket.id) return socket.emit("errorMsg", "Only owner can kick");
    if (room.players[targetId]) {
      delete room.players[targetId];
      io.to(targetId).emit("kicked");
      io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });
    }
  });

  // Start game
  socket.on("startGame", (code) => {
    const room = rooms[code];
    if (!room) return;
    if (room.owner !== socket.id) return socket.emit("errorMsg", "Only owner can start");
    room.started = true;
    io.to(code).emit("goToGamePage");
    // Also emit full playerList so game page can display initial scores
    io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });
  });

  // Quiz: createQuestion, submitAnswer, endQuestionNow
  socket.on("createQuestion", (payload) => {
    const { code, question, options, correctIndexes, duration, points } = payload || {};
    const room = rooms[code];
    if (!room) return socket.emit("errorMsg", "Room not found");
    if (room.owner !== socket.id) return socket.emit("errorMsg", "Only owner can create questions");
    if (room.currentQuestion) return socket.emit("errorMsg", "Question already active");

    const dur = Math.max(1, Math.floor(duration||10));
    const pts = Math.max(0, Math.floor(points||1));
    room.currentQuestion = { question, options, correctIndexes: (correctIndexes||[]).map(Number), duration: dur, points: pts, answers: {} };
    io.to(code).emit("questionStarted", { question, options, duration: dur });

    // timer
    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(()=> finishQuestion(code), dur*1000);
  });

  socket.on("submitAnswer", ({ code, selections }) => {
    const room = rooms[code];
    if (!room || !room.currentQuestion) return socket.emit("errorMsg", "No active question");
    if (room.currentQuestion.answers[socket.id]) return socket.emit("errorMsg", "Already answered");
    room.currentQuestion.answers[socket.id] = (Array.isArray(selections) ? selections.map(Number) : [Number(selections)]);
    if (room.owner) io.to(room.owner).emit("playerAnswered", { id: socket.id, name: room.players[socket.id]?.name });
  });

  socket.on("endQuestionNow", (code) => {
    const room = rooms[code];
    if (!room || room.owner !== socket.id) return socket.emit("errorMsg", "Only owner can end question");
    finishQuestion(code);
  });

  socket.on("disconnect", () => {
    // remove from any room they were in
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        // if owner left -> close room
        if (room.owner === socket.id) {
          if (room.timer) clearTimeout(room.timer);
          io.to(code).emit("roomClosed");
          delete rooms[code];
        } else {
          io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });
        }
        break;
      }
    }
  });

  // helper to finish
  function finishQuestion(code) {
    const room = rooms[code];
    if (!room || !room.currentQuestion) return;
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }

    const cq = room.currentQuestion;
    const correctSet = new Set(cq.correctIndexes.map(Number));
    const results = [];

    for (const pid in room.players) {
      const player = room.players[pid];
      const sels = cq.answers[pid] || [];
      const selsSet = new Set(sels.map(Number));
      let isCorrect = false;
      if (selsSet.size === correctSet.size) {
        isCorrect = [...correctSet].every(i => selsSet.has(i));
      }
      let awarded = 0;
      if (isCorrect) {
        player.score = (player.score || 0) + cq.points;
        awarded = cq.points;
      }
      results.push({ id: pid, name: player.name, correct: isCorrect, awarded });
    }

    room.currentQuestion = null;
    io.to(code).emit("questionEnded", { results, correctIndexes: Array.from(correctSet) });
    const leaderboard = Object.values(room.players).sort((a,b)=> (b.score||0) - (a.score||0));
    io.to(code).emit("leaderboard", leaderboard);
    io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });
  }
});

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
