const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Room data
const rooms = {}; 
/*
rooms[code] = {
  owner: socket.id,
  players: { socketId: {name, score} },
  started: false,
  currentQuestion: null,
  timer: null
}
*/

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Create room
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
    callback({ success: true, code });
    io.to(code).emit("playerList", { players: Object.values(rooms[code].players) });
  });

  // Join room
  socket.on("joinRoom", ({ code, name }, callback) => {
    code = code.trim().toUpperCase();
    const room = rooms[code];

    if (!room) {
      callback?.({ success: false, message: "Room not found" });
      return;
    }
    if (room.started) {
      callback?.({ success: false, message: "Game already started" });
      return;
    }

    room.players[socket.id] = { id: socket.id, name, score: 0 };
    socket.join(code);

    io.to(code).emit("playerList", { players: Object.values(room.players) });
    callback?.({ success: true, code });
  });

  // Kick player
  socket.on("kickPlayer", ({ code, targetId }) => {
    const room = rooms[code];
    if (room && room.owner === socket.id) {
      delete room.players[targetId];
      io.to(targetId).emit("kicked");
      io.to(code).emit("playerList", { players: Object.values(room.players) });
    }
  });

  // Start game
  socket.on("startGame", (code) => {
    const room = rooms[code];
    if (room && room.owner === socket.id) {
      room.started = true;
      io.to(code).emit("gameStarted", room.players);
    }
  });

  // Create a question (owner only)
  socket.on("createQuestion", ({ code, question, options, correctIndexes, duration, points }) => {
    const room = rooms[code];
    if (!room || room.owner !== socket.id) return;

    // Setup current question
    room.currentQuestion = {
      question,
      options,
      correctIndexes,
      duration,
      points,
      answers: {} // socketId -> selections
    };

    io.to(code).emit("questionStarted", { question, options, duration });

    // Auto end timer
    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => endQuestion(code), duration * 1000);
  });

  // Player submits answer
  socket.on("submitAnswer", ({ code, selections }) => {
    const room = rooms[code];
    if (!room || !room.currentQuestion) return;
    room.currentQuestion.answers[socket.id] = selections;
  });

  // End question early (owner only)
  socket.on("endQuestionNow", (code) => {
    const room = rooms[code];
    if (room && room.owner === socket.id) {
      endQuestion(code);
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        delete room.players[socket.id];

        if (room.owner === socket.id) {
          io.to(code).emit("roomClosed");
          delete rooms[code];
        } else {
          io.to(code).emit("playerList", { players: Object.values(room.players) });
        }
        break;
      }
    }
  });

  // Helper: end question
  function endQuestion(code) {
    const room = rooms[code];
    if (!room || !room.currentQuestion) return;

    const { correctIndexes, points, answers } = room.currentQuestion;

    const results = [];
    for (const pid in room.players) {
      const player = room.players[pid];
      const selections = answers[pid] || [];
      const isCorrect =
        selections.length > 0 &&
        selections.every(i => correctIndexes.includes(i)) &&
        correctIndexes.every(i => selections.includes(i));

      let awarded = 0;
      if (isCorrect) {
        player.score += points;
        awarded = points;
      }
      results.push({ id: pid, name: player.name, correct: isCorrect, awarded });
    }

    // Broadcast results
    io.to(code).emit("questionEnded", { results, correctIndexes });

    // Update leaderboards
    const sorted = Object.values(room.players).sort((a, b) => b.score - a.score);
    io.to(code).emit("leaderboard", sorted);

    room.currentQuestion = null;
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
