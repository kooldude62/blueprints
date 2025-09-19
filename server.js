const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Route fallback
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Room storage
const rooms = {}; 
// Example structure: rooms[code] = { owner: socket.id, players: { socketId: {name, points}}, started: false }

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("createRoom", (name, callback) => {
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[code] = {
      owner: socket.id,
      players: {},
      started: false
    };

    rooms[code].players[socket.id] = { name, points: 0 };

    socket.join(code);
    callback({ success: true, code });
    io.to(code).emit("updatePlayers", rooms[code].players);
  });

  socket.on("joinRoom", ({ code, name }, callback) => {
    code = code.trim().toUpperCase();

    if (!rooms[code]) {
      callback({ success: false, message: "Room not found" });
      return;
    }
    if (rooms[code].started) {
      callback({ success: false, message: "Game already started" });
      return;
    }

    rooms[code].players[socket.id] = { name, points: 0 };
    socket.join(code);

    io.to(code).emit("updatePlayers", rooms[code].players);
    callback({ success: true, code });
  });

  socket.on("kickPlayer", ({ code, targetId }) => {
    if (rooms[code] && rooms[code].owner === socket.id) {
      delete rooms[code].players[targetId];
      io.to(targetId).emit("kicked");
      io.to(code).emit("updatePlayers", rooms[code].players);
    }
  });

  socket.on("startGame", (code) => {
    if (rooms[code] && rooms[code].owner === socket.id) {
      rooms[code].started = true;
      io.to(code).emit("gameStarted", rooms[code].players);
    }
  });

  socket.on("disconnect", () => {
    for (const code in rooms) {
      if (rooms[code].players[socket.id]) {
        delete rooms[code].players[socket.id];

        // If owner leaves, delete room
        if (rooms[code].owner === socket.id) {
          io.to(code).emit("roomClosed");
          delete rooms[code];
        } else {
          io.to(code).emit("updatePlayers", rooms[code].players);
        }
        break;
      }
    }
    console.log("User disconnected:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
