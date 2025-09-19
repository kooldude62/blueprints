const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); 

// rooms structure:
// rooms[code] = {
//   owner: socketId,
//   players: [{id, name, score}],
//   currentQuestion: null,
//   answers: {}, // socketId -> array of selected indexes
//   questionTimer: null
// }
const rooms = {};

app.post("/create", (req, res) => {
  const code = nanoid(6).toUpperCase();
  rooms[code] = { owner: null, players: [], currentQuestion: null, answers: {}, questionTimer: null };
  res.json({ joinCode: code });
});

app.post("/join", (req, res) => {
  const { code } = req.body;
  if (!rooms[code]) return res.status(404).json({ error: "Room not found" });
  res.json({ success: true });
});

// helper to broadcast latest player list (with scores) and owner id
function broadcastPlayerList(code) {
  if (!rooms[code]) return;
  io.to(code).emit("playerList", { players: rooms[code].players, owner: rooms[code].owner });
}

// helper: reset current question state
function clearCurrentQuestion(code) {
  if (!rooms[code]) return;
  rooms[code].currentQuestion = null;
  rooms[code].answers = {};
  if (rooms[code].questionTimer) {
    clearTimeout(rooms[code].questionTimer);
    rooms[code].questionTimer = null;
  }
}

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  socket.on("joinRoom", ({ code, playerName, isOwner }) => {
    if (!rooms[code]) {
      socket.emit("errorMsg", "Room not found");
      return;
    }

    // Prevent duplicate names in a room
    if (rooms[code].players.some(p => p.name === playerName)) {
      socket.emit("errorMsg", "Name already taken in this room");
      return;
    }

    socket.join(code);

    if (isOwner) {
      rooms[code].owner = socket.id;
    }

    rooms[code].players.push({ id: socket.id, name: playerName, score: 0 });
    broadcastPlayerList(code);
  });

  socket.on("kickPlayer", ({ code, targetId }) => {
    if (!rooms[code]) return;
    if (rooms[code].owner !== socket.id) {
      socket.emit("errorMsg", "Only the owner can kick players.");
      return;
    }
    rooms[code].players = rooms[code].players.filter(p => p.id !== targetId);
    io.to(targetId).emit("kicked");
    io.sockets.sockets.get(targetId)?.leave(code);
    broadcastPlayerList(code);
  });

  // Owner creates question
  socket.on("createQuestion", ({ code, question, options, correctIndexes, duration, points }) => {
    if (!rooms[code]) return;
    if (rooms[code].owner !== socket.id) {
      socket.emit("errorMsg", "Only the owner can create questions.");
      return;
    }

    // If a question is already running, disallow
    if (rooms[code].currentQuestion) {
      socket.emit("errorMsg", "A question is already active.");
      return;
    }

    // store question
    rooms[code].currentQuestion = {
      question,
      options,
      correctIndexes, // array of indexes that are correct
      duration: Math.max(1, Math.floor(duration)),
      points: Math.max(0, Math.floor(points))
    };
    rooms[code].answers = {}; // clear previous answers

    // broadcast to members
    io.to(code).emit("questionStarted", {
      question: rooms[code].currentQuestion.question,
      options: rooms[code].currentQuestion.options,
      duration: rooms[code].currentQuestion.duration
    });

    // start timer
    rooms[code].questionTimer = setTimeout(() => {
      // grade answers
      const correctSet = new Set(rooms[code].currentQuestion.correctIndexes.map(i => Number(i)));
      const results = []; // {id, name, correct, awarded}
      rooms[code].players.forEach(p => {
        const given = rooms[code].answers[p.id] || [];
        // compare: treat arrays as sets (order doesn't matter)
        const givenSet = new Set(given.map(i => Number(i)));
        // correct if sets equal
        let isCorrect = false;
        if (givenSet.size === correctSet.size) {
          isCorrect = [...correctSet].every(i => givenSet.has(i));
        } else {
          isCorrect = false;
        }

        let awarded = 0;
        if (isCorrect) {
          p.score += rooms[code].currentQuestion.points;
          awarded = rooms[code].currentQuestion.points;
        }
        results.push({ id: p.id, name: p.name, correct: isCorrect, awarded });
      });

      // clear timer and current question
      clearCurrentQuestion(code);

      // send results and new leaderboard
      io.to(code).emit("questionEnded", { results, correctIndexes: Array.from(correctSet) });

      // send updated leaderboard (sorted)
      const leaderboard = [...rooms[code].players].sort((a,b)=>b.score - a.score);
      io.to(code).emit("leaderboard", leaderboard);

    }, rooms[code].currentQuestion.duration * 1000);
  });

  // Player submits answer (indexes array)
  socket.on("submitAnswer", ({ code, selections }) => {
    if (!rooms[code]) return;
    if (!rooms[code].currentQuestion) {
      socket.emit("errorMsg", "No active question.");
      return;
    }

    // If player already answered, ignore
    if (rooms[code].answers[socket.id]) {
      socket.emit("errorMsg", "You already answered.");
      return;
    }

    // store the selection as array of numbers (indexes)
    rooms[code].answers[socket.id] = Array.isArray(selections) ? selections.map(Number) : [Number(selections)];
    // optional: notify owner that a player answered
    io.to(rooms[code].owner).emit("playerAnswered", { id: socket.id, name: rooms[code].players.find(p=>p.id===socket.id)?.name });
  });

  // Owner can force end question early (optional)
  socket.on("endQuestionNow", (code) => {
    if (!rooms[code]) return;
    if (rooms[code].owner !== socket.id) {
      socket.emit("errorMsg", "Only owner can end a question.");
      return;
    }
    if (!rooms[code].currentQuestion) return;
    clearTimeout(rooms[code].questionTimer);
    // call the same grading logic by re-emitting a small wrapper:
    // For simplicity, we call a fake timeout handler (same as above)
    const correctSet = new Set(rooms[code].currentQuestion.correctIndexes.map(i => Number(i)));
    const results = [];
    rooms[code].players.forEach(p => {
      const given = rooms[code].answers[p.id] || [];
      const givenSet = new Set(given.map(i => Number(i)));
      let isCorrect = false;
      if (givenSet.size === correctSet.size) {
        isCorrect = [...correctSet].every(i => givenSet.has(i));
      } else {
        isCorrect = false;
      }
      let awarded = 0;
      if (isCorrect) {
        p.score += rooms[code].currentQuestion.points;
        awarded = rooms[code].currentQuestion.points;
      }
      results.push({ id: p.id, name: p.name, correct: isCorrect, awarded });
    });
    clearCurrentQuestion(code);
    io.to(code).emit("questionEnded", { results, correctIndexes: Array.from(correctSet) });
    const leaderboard = [...rooms[code].players].sort((a,b)=>b.score - a.score);
    io.to(code).emit("leaderboard", leaderboard);
  });

  // Owner starts the "game page" (redirect everyone)
  socket.on("startGame", (code) => {
    if (!rooms[code]) return;
    if (rooms[code].owner !== socket.id) return;
    // instruct clients to go to /game.html (client handles localStorage)
    io.to(code).emit("goToGamePage");
  });

  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      const wasOwner = room.owner === socket.id;

      room.players = room.players.filter(p => p.id !== socket.id);

      if (wasOwner) {
        // if owner leaves, close the room
        io.to(code).emit("errorMsg", "Room closed because the owner left.");
        // clear timers if any
        if (room.questionTimer) clearTimeout(room.questionTimer);
        delete rooms[code];
      } else {
        broadcastPlayerList(code);
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server running on port", PORT));
