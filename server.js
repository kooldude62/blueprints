// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// rooms: keyed by join code
// rooms[code] = {
//   owner: socketId,
//   players: { socketId: { id, name, score } },
//   started: false,
//   currentQuestion: null,
//   timer: null
// }
const rooms = {};

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // Create room (owner)
  socket.on("createRoom", (name, callback) => {
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[code] = {
      owner: socket.id,
      players: { [socket.id]: { id: socket.id, name, score: 0 } },
      started: false,
      currentQuestion: null,
      timer: null
    };
    socket.join(code);
    // send player list with owner id
    io.to(code).emit("playerList", { players: Object.values(rooms[code].players), owner: rooms[code].owner });
    callback?.({ success: true, code });
  });

  // Join room (player or owner reconnect)
  // Accepts { code, name, isOwner }
  socket.on("joinRoom", ({ code, name, isOwner }, callback) => {
    if (!code || !name) {
      callback?.({ success: false, message: "Missing code or name" });
      return;
    }
    code = String(code).trim().toUpperCase();
    const room = rooms[code];
    if (!room) {
      callback?.({ success: false, message: "Room not found" });
      return;
    }
    if (room.started) {
      callback?.({ success: false, message: "Game already started" });
      return;
    }

    // Prevent duplicate names in same room
    const nameTaken = Object.values(room.players).some(p => p.name === name);
    if (nameTaken) {
      callback?.({ success: false, message: "Name already taken in this room" });
      return;
    }

    // If client claims to be owner, assign ownership to this socket
    if (isOwner) {
      room.owner = socket.id;
    }

    // Add player
    room.players[socket.id] = { id: socket.id, name, score: 0 };
    socket.join(code);

    // broadcast updated players + owner id
    io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });
    callback?.({ success: true, code });
  });

  // Kick player (owner only)
  socket.on("kickPlayer", ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return;
    if (room.owner !== socket.id) {
      socket.emit("errorMsg", "Only the owner can kick players.");
      return;
    }
    if (room.players[targetId]) {
      delete room.players[targetId];
      io.to(targetId).emit("kicked");
      io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });
    }
  });

  // Owner starts game (only then redirect to game page)
  socket.on("startGame", (code) => {
    const room = rooms[code];
    if (!room) return;
    if (room.owner !== socket.id) {
      socket.emit("errorMsg", "Only owner can start the game.");
      return;
    }
    room.started = true;
    io.to(code).emit("goToGamePage"); // lobby clients redirect when they receive this
  });

  // Owner creates question
  socket.on("createQuestion", ({ code, question, options, correctIndexes, duration, points }) => {
    const room = rooms[code];
    if (!room || room.owner !== socket.id) {
      socket.emit("errorMsg", "Only owner can create questions.");
      return;
    }
    if (room.currentQuestion) {
      socket.emit("errorMsg", "A question is already running.");
      return;
    }
    // sanitize/set defaults
    duration = Math.max(1, Math.floor(duration || 10));
    points = Math.max(0, Math.floor(points || 1));
    correctIndexes = Array.isArray(correctIndexes) ? correctIndexes.map(Number) : [];

    room.currentQuestion = {
      question,
      options,
      correctIndexes,
      duration,
      points,
      answers: {} // socketId -> selections array
    };

    // broadcast start
    io.to(code).emit("questionStarted", { question, options, duration });

    // set timer
    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => finishQuestion(code), duration * 1000);
  });

  // Player submits answer
  socket.on("submitAnswer", ({ code, selections }) => {
    const room = rooms[code];
    if (!room || !room.currentQuestion) {
      socket.emit("errorMsg", "No active question.");
      return;
    }
    // prevent multiple submits from same player
    if (room.currentQuestion.answers[socket.id]) {
      socket.emit("errorMsg", "You already answered.");
      return;
    }
    // store selection
    room.currentQuestion.answers[socket.id] = Array.isArray(selections) ? selections.map(Number) : [Number(selections)];
    // optionally notify owner someone answered
    if (room.owner && io.sockets.sockets.get(room.owner)) {
      io.to(room.owner).emit("playerAnswered", { id: socket.id, name: room.players[socket.id]?.name || "Unknown" });
    }
  });

  // Owner can force end question early
  socket.on("endQuestionNow", (code) => {
    const room = rooms[code];
    if (!room || room.owner !== socket.id) {
      socket.emit("errorMsg", "Only owner can end the question.");
      return;
    }
    finishQuestion(code);
  });

  // Disconnect handling
  socket.on("disconnect", () => {
    // find room that contains this socket
    for (const code in rooms) {
      const room = rooms[code];
      if (!room) continue;
      if (room.players[socket.id]) {
        // remove player
        delete room.players[socket.id];

        // if owner left, close room and notify
        if (room.owner === socket.id) {
          // clear timer
          if (room.timer) clearTimeout(room.timer);
          io.to(code).emit("roomClosed");
          delete rooms[code];
        } else {
          // broadcast updated player list
          io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });
        }
        break;
      }
    }
  });

  // helper to finish a question (grade & award points)
  function finishQuestion(code) {
    const room = rooms[code];
    if (!room || !room.currentQuestion) return;

    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }

    const cq = room.currentQuestion;
    const correctSet = new Set(cq.correctIndexes.map(Number));
    const results = [];

    for (const pid in room.players) {
      const player = room.players[pid];
      const given = cq.answers[pid] || [];
      const givenSet = new Set(given.map(Number));

      // correct if sets are identical
      let isCorrect = false;
      if (givenSet.size === correctSet.size) {
        isCorrect = [...correctSet].every(i => givenSet.has(i));
      }

      let awarded = 0;
      if (isCorrect) {
        player.score = (player.score || 0) + cq.points;
        awarded = cq.points;
      }
      results.push({ id: pid, name: player.name, correct: isCorrect, awarded });
    }

    // clear currentQuestion
    room.currentQuestion = null;

    // broadcast results and leaderboard
    io.to(code).emit("questionEnded", { results, correctIndexes: Array.from(correctSet) });
    const leaderboard = Object.values(room.players).sort((a,b)=> (b.score||0) - (a.score||0));
    io.to(code).emit("leaderboard", leaderboard);
    // also send updated player list
    io.to(code).emit("playerList", { players: Object.values(room.players), owner: room.owner });
  }
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
