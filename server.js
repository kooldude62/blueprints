const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // Serve frontend files

// In-memory storage for rooms (clears if server restarts)
const rooms = {};

// Create a new room
app.post("/create", (req, res) => {
  const code = nanoid(6).toUpperCase(); // 6-character join code
  rooms[code] = { players: [] };
  res.json({ joinCode: code });
});

// Join a room
app.post("/join", (req, res) => {
  const { code, playerName } = req.body;
  if (!rooms[code]) return res.status(404).json({ error: "Room not found" });

  rooms[code].players.push(playerName);
  res.json({ success: true, players: rooms[code].players });
});

// Realtime with socket.io
io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  socket.on("joinRoom", ({ code, playerName }) => {
    if (!rooms[code]) {
      socket.emit("errorMsg", "Room not found");
      return;
    }

    socket.join(code);
    rooms[code].players.push(playerName);

    io.to(code).emit("playerList", rooms[code].players);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server running on port", PORT));
