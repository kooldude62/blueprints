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

// In-memory storage (clears on restart)
const rooms = {}; 
// Structure: { CODE: { owner: socketId, players: [{id, name}] } }

app.post("/create", (req, res) => {
  const code = nanoid(6).toUpperCase();
  rooms[code] = { owner: null, players: [] }; // owner assigned on socket join
  res.json({ joinCode: code });
});

app.post("/join", (req, res) => {
  const { code } = req.body;
  if (!rooms[code]) return res.status(404).json({ error: "Room not found" });
  res.json({ success: true });
});

// Realtime handling
io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  socket.on("joinRoom", ({ code, playerName, isOwner }) => {
    if (!rooms[code]) {
      socket.emit("errorMsg", "Room not found");
      return;
    }

    socket.join(code);

    if (isOwner) {
      rooms[code].owner = socket.id;
    }

    rooms[code].players.push({ id: socket.id, name: playerName });

    io.to(code).emit("playerList", {
      players: rooms[code].players,
      owner: rooms[code].owner
    });
  });

  socket.on("kickPlayer", ({ code, targetId }) => {
    if (!rooms[code]) return;

    if (rooms[code].owner !== socket.id) {
      socket.emit("errorMsg", "Only the owner can kick players.");
      return;
    }

    // Remove target
    rooms[code].players = rooms[code].players.filter(p => p.id !== targetId);
    io.to(targetId).emit("kicked");
    io.sockets.sockets.get(targetId)?.leave(code);

    io.to(code).emit("playerList", {
      players: rooms[code].players,
      owner: rooms[code].owner
    });
  });

  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      const wasOwner = room.owner === socket.id;

      room.players = room.players.filter(p => p.id !== socket.id);

      if (wasOwner) {
        // If owner leaves, delete room
        io.to(code).emit("errorMsg", "Room closed because the owner left.");
        delete rooms[code];
      } else {
        io.to(code).emit("playerList", {
          players: room.players,
          owner: room.owner
        });
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server running on port", PORT));
