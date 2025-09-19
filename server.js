const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = {}; // { CODE: { players, owner, started, _ownerTimeout } }

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on("connection", (socket) => {
  console.log("New client connected", socket.id);

  // Create room
  socket.on("createRoom", ({ name }, cb) => {
    const code = generateRoomCode();
    rooms[code] = {
      players: { [socket.id]: { id: socket.id, name, score: 0 } },
      owner: socket.id,
      started: false,
    };
    socket.join(code);
    console.log("Room created:", code);
    cb?.({ success: true, code });
  });

  // Join existing room
  socket.on("joinRoom", ({ code, name }, cb) => {
    code = String(code).trim().toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ success: false, message: "Room not found" });
    if (room.started) return cb?.({ success: false, message: "Game already started" });

    room.players[socket.id] = { id: socket.id, name, score: 0 };
    socket.join(code);

    io.to(code).emit("playerList", {
      players: Object.values(room.players),
      owner: room.owner,
    });
    cb?.({ success: true, code });
  });

  // Rejoin after refresh
  socket.on("rejoinRoom", ({ code, name }, cb) => {
    code = String(code).trim().toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ success: false, message: "Room not found" });

    const existing = Object.values(room.players).find((p) => p.name === name);
    if (!existing) {
      return cb?.({ success: false, message: "Player not in this room" });
    }

    // Swap socket ID
    delete room.players[existing.id];
    room.players[socket.id] = { id: socket.id, name, score: existing.score };
    socket.join(code);

    if (room._ownerTimeout) {
      clearTimeout(room._ownerTimeout);
      delete room._ownerTimeout;
    }

    io.to(code).emit("playerList", {
      players: Object.values(room.players),
      owner: room.owner,
    });
    cb?.({ success: true });
  });

  // Start game
  socket.on("startGame", (code) => {
    code = String(code).trim().toUpperCase();
    const room = rooms[code];
    if (room && room.owner === socket.id) {
      room.started = true;
      io.to(code).emit("gameStarted");
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (!room) continue;

      if (room.players[socket.id]) {
        const wasOwner = room.owner === socket.id;
        delete room.players[socket.id];

        if (wasOwner) {
          room._ownerTimeout = setTimeout(() => {
            if (!room.owner || !io.sockets.sockets.get(room.owner)) {
              io.to(code).emit("roomClosed");
              delete rooms[code];
              console.log("Room deleted:", code);
            }
          }, 30000); // 30s grace
        }

        io.to(code).emit("playerList", {
          players: Object.values(room.players),
          owner: room.owner,
        });
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));
