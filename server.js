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

const rooms = {}; // in-memory. Use Redis for persistence across processes.

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// REST create: returns a code (owner still assigned on socket join)
app.post("/api/create", (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Missing name" });
  const code = genCode();
  rooms[code] = { owner: null, players: {}, started: false, currentQuestion: null, timer: null };
  return res.json({ code });
});

// REST join validation (fast fail)
app.post("/api/join", (req, res) => {
  let { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: "Missing code or name" });
  code = String(code).trim().toUpperCase();
  const room = rooms[code];
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.started) return res.status(400).json({ error: "Game already started" });
  if (Object.values(room.players).some(p => p.name === name)) return res.status(409).json({ error: "Name taken" });
  return res.json({ ok: true });
});

app.get("/api/rooms", (req, res) => res.json(rooms)); // debug

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  // Socket create flow (fallback)
  socket.on("createRoomSocket", ({ name }, cb) => {
    if (!name) return cb?.({ success:false, message: "Missing name" });
    const code = genCode();
    rooms[code] = { owner: socket.id, players: { [socket.id]: { id: socket.id, name, score: 0 } }, started:false, currentQuestion:null, timer:null };
    socket.join(code);
    io.to(code).emit("playerList", { players: Object.values(rooms[code].players), owner: rooms[code].owner });
    return cb?.({ success:true, code, owner: rooms[code].owner, players: Object.values(rooms[code].players) });
  });

  // Join after REST validation (or direct)
  // payload: { code, name, isOwner }
  socket.on("joinRoom", ({ code, name, isOwner }, cb) => {
    if (!code || !name) {
      return cb?.({ success:false, message:"Missing code or name" });
    }
    code = String(code).trim().toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ success:false, message:"Room not found" });
    if (room.started) return cb?.({ success:false, message:"Game already started" });
    if (Object.values(room.players).some(p => p.name === name)) return cb?.({ success:false, message:"Name already taken" });

    if (isOwner) {
      // assign owner to this socket
      room.owner = socket.id;
    }

    room.players[socket.id] = { id: socket.id, name, score: 0 };
    socket.join(code);

    // broadcast player list & owner id
    io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });

    return cb?.({ success:true, code, owner: room.owner, players: Object.values(room.players) });
  });

  // Kick (owner only)
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

  // Start game -> redirect everyone to game page
  socket.on("startGame", (code) => {
    const room = rooms[code];
    if (!room) return socket.emit("errorMsg", "Room not found");
    if (room.owner !== socket.id) return socket.emit("errorMsg", "Only owner can start");
    room.started = true;
    io.to(code).emit("goToGamePage");
    // send fresh player list too
    io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });
  });

  // Quiz: createQuestion
  socket.on("createQuestion", ({ code, question, options, correctIndexes, duration, points }) => {
    const room = rooms[code];
    if (!room) return socket.emit("errorMsg", "Room not found");
    if (room.owner !== socket.id) return socket.emit("errorMsg", "Only owner can create questions");
    if (room.currentQuestion) return socket.emit("errorMsg", "Question already active");

    const dur = Math.max(1, Math.floor(duration||10));
    const pts = Math.max(0, Math.floor(points||1));
    room.currentQuestion = { question, options, correctIndexes: (correctIndexes||[]).map(Number), duration: dur, points: pts, answers: {} };
    io.to(code).emit("questionStarted", { question, options, duration: dur });

    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(()=> finishQuestion(code), dur*1000);
  });

  socket.on("submitAnswer", ({ code, selections }) => {
    const room = rooms[code];
    if (!room || !room.currentQuestion) return socket.emit("errorMsg", "No active question");
    if (room.currentQuestion.answers[socket.id]) return socket.emit("errorMsg", "Already answered");
    room.currentQuestion.answers[socket.id] = Array.isArray(selections) ? selections.map(Number) : [Number(selections)];
    if (room.owner && io.sockets.sockets.get(room.owner)) {
      io.to(room.owner).emit("playerAnswered", { id: socket.id, name: room.players[socket.id]?.name });
    }
  });

  socket.on("endQuestionNow", (code) => {
    const room = rooms[code];
    if (!room || room.owner !== socket.id) return socket.emit("errorMsg", "Only owner can end");
    finishQuestion(code);
  });

  socket.on("disconnect", () => {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
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

  // helper: finish & grade question
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
