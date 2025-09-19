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

// In-memory rooms (not shared across processes)
const rooms = {}; // rooms[code] = { owner: socketId, players: { socketId: { id, name, score } }, started, currentQuestion, timer }

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// REST create
app.post("/api/create", (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Missing name" });
  const code = genCode();
  rooms[code] = { owner: null, players: {}, started: false, currentQuestion: null, timer: null };
  return res.json({ code });
});

// REST join validation
app.post("/api/join", (req, res) => {
  let { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: "Missing code or name" });
  code = String(code).trim().toUpperCase();
  const room = rooms[code];
  if (!room) return res.status(404).json({ error: "Room not found" });
  // If game started, disallow new joins; allow reconnects (handled by socket)
  if (room.started && !Object.values(room.players).some(p => p.name === name)) {
    return res.status(400).json({ error: "Game already started" });
  }
  if (Object.values(room.players).some(p => p.name === name)) return res.status(409).json({ error: "Name already taken" });
  return res.json({ ok: true });
});

// debugging endpoint
app.get("/api/rooms", (req, res) => res.json(rooms));

// Socket handlers
io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  // Fallback socket create (if REST not used)
  socket.on("createRoomSocket", ({ name }, cb) => {
    if (!name) return cb?.({ success: false, message: "Missing name" });
    const code = genCode();
    rooms[code] = { owner: socket.id, players: { [socket.id]: { id: socket.id, name, score: 0 } }, started: false, currentQuestion: null, timer: null };
    socket.join(code);
    io.to(code).emit("playerList", { players: Object.values(rooms[code].players), owner: rooms[code].owner });
    return cb?.({ success: true, code });
  });

  // joinRoom: robust, supports reconnects after start if name exists
  // payload: { code, name, isOwner }
  socket.on("joinRoom", ({ code, name, isOwner }, cb) => {
    if (!code || !name) return cb?.({ success: false, message: "Missing code or name" });
    code = String(code).trim().toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ success: false, message: "Room not found" });

    // If the room already started
    if (room.started) {
      // allow reconnect if the name already existed (reconnect case)
      const existingPid = Object.keys(room.players).find(pid => room.players[pid].name === name);
      if (!existingPid && !isOwner) {
        return cb?.({ success: false, message: "Game already started" });
      }
      // If player existed under a previous socket id, move their state to new socket id
      if (existingPid) {
        const old = room.players[existingPid];
        delete room.players[existingPid];
        room.players[socket.id] = { id: socket.id, name: old.name, score: old.score || 0 };
        socket.join(code);
        // if the reconnecting player claims owner and server had owner same name? We'll only reassign owner if isOwner true
        if (isOwner) room.owner = socket.id;
        io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });
        return cb?.({ success: true, code, owner: room.owner, players: Object.values(room.players) });
      }
    } else {
      // room not started
      // name collision prevention
      if (Object.values(room.players).some(p => p.name === name)) {
        return cb?.({ success: false, message: "Name already taken in this room" });
      }
      if (isOwner) {
        room.owner = socket.id;
      }
      room.players[socket.id] = { id: socket.id, name, score: 0 };
      socket.join(code);
      io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });
      return cb?.({ success: true, code, owner: room.owner, players: Object.values(room.players) });
    }
  });

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

  socket.on("startGame", (code) => {
    const room = rooms[code];
    if (!room) return socket.emit("errorMsg", "Room not found");
    if (room.owner !== socket.id) return socket.emit("errorMsg", "Only owner can start");
    room.started = true;
    // broadcast goToGamePage and current players
    io.to(code).emit("goToGamePage");
    io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });
  });

  // Quiz creation
  socket.on("createQuestion", ({ code, question, options, correctIndexes, duration, points }) => {
    const room = rooms[code];
    if (!room) return socket.emit("errorMsg", "Room not found");
    if (room.owner !== socket.id) return socket.emit("errorMsg", "Only owner can create questions");
    if (room.currentQuestion) return socket.emit("errorMsg", "Question already active");

    const dur = Math.max(1, Math.floor(duration || 10));
    const pts = Math.max(0, Math.floor(points || 1));
    room.currentQuestion = {
      question,
      options,
      correctIndexes: (correctIndexes || []).map(Number),
      duration: dur,
      points: pts,
      answers: {}
    };

    io.to(code).emit("questionStarted", { question, options, duration: dur });
    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => finishQuestion(code), dur * 1000);
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
    // remove from room(s)
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (!room) continue;
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        if (room.owner === socket.id) {
          // owner left -> close room
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

  // helper finish
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
