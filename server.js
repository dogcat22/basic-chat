// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { createClient } = require("redis");

// ================== APP SETUP ==================
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// ================== REDIS SETUP ==================
const redis = createClient({
  url: process.env.REDIS_URL
});

redis.on("error", (err) => {
  console.error("❌ Redis error:", err);
});

(async () => {
  await redis.connect();
  console.log("✅ Connected to Redis");
})();

// ================== STATIC FILES ==================
app.use(express.static("public"));

// ================== USER / ROOM STATE ==================
const rooms = new Map(); // roomId -> Set(socketId)
const users = new Map(); // socketId -> { username, room }

// ================== REDIS MESSAGE HELPERS ==================
const MESSAGE_TTL = 6 * 60 * 60; // 6 hours
const MAX_MESSAGES = 200;

async function storeMessage(roomId, username, message) {
  const msg = {
    username,
    message,
    timestamp: new Date().toISOString()
  };

  const key = `room:${roomId}`;

  await redis.rPush(key, JSON.stringify(msg));
  await redis.lTrim(key, -MAX_MESSAGES, -1);
  await redis.expire(key, MESSAGE_TTL);

  return msg;
}

async function getRecentMessages(roomId) {
  const key = `room:${roomId}`;
  const messages = await redis.lRange(key, 0, -1);
  return messages.map(m => JSON.parse(m));
}

// ================== SOCKET.IO ==================
io.on("connection", async (socket) => {
  console.log("User connected:", socket.id);

  // Default room
  const DEFAULT_ROOM = "001";
  socket.join(DEFAULT_ROOM);

  rooms.set(DEFAULT_ROOM, rooms.get(DEFAULT_ROOM) || new Set());
  rooms.get(DEFAULT_ROOM).add(socket.id);

  users.set(socket.id, { username: "Guest", room: DEFAULT_ROOM });

  const recentMessages = await getRecentMessages(DEFAULT_ROOM);
  recentMessages.forEach(msg => socket.emit("chat message", msg));

  socket.emit("room joined", DEFAULT_ROOM);

  // Chat message
  socket.on("chat message", async (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const room = data.room || user.room;
    const username = data.username || user.username;
    const message = data.message?.trim();

    if (!message) return;

    const stored = await storeMessage(room, username, message);

    io.to(room).emit("chat message", {
      ...stored,
      room
    });

    user.username = username;
  });

  // Join room
  socket.on("join room", async (roomId) => {
    if (!/^\d{3}$/.test(roomId)) return;

    const user = users.get(socket.id);
    if (!user || user.room === roomId) return;

    socket.leave(user.room);
    rooms.get(user.room)?.delete(socket.id);

    socket.join(roomId);
    rooms.set(roomId, rooms.get(roomId) || new Set());
    rooms.get(roomId).add(socket.id);

    user.room = roomId;

    const recentMessages = await getRecentMessages(roomId);
    recentMessages.forEach(msg => socket.emit("chat message", msg));

    socket.emit("room joined", roomId);
  });

  // Disconnect
  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (!user) return;

    rooms.get(user.room)?.delete(socket.id);
    if (rooms.get(user.room)?.size === 0) {
      rooms.delete(user.room);
    }

    users.delete(socket.id);
    console.log("User disconnected:", socket.id);
  });
});

// ================== ROUTES ==================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ================== START SERVER ==================
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`💬 Chat ready (rooms 001–100)`);
});