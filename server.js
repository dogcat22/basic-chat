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
const redisUrl = process.env.REDIS_URL || "rediss://default:AbsqAAIncDJiNDcyZGU3ZjliMmM0YjQzYjUxNGNjNTQyOTk1MDNlZnAyNDc5MTQ@desired-koi-47914.upstash.io:6379";

if (!redisUrl) {
  console.error("❌ REDIS_URL is not set");
  process.exit(1);
}

const redis = createClient({
  url: redisUrl,
  socket: {
    tls: true,
    rejectUnauthorized: false
  }
});

redis.on("error", (err) => {
  console.error("❌ Redis error:", err);
});

(async () => {
  try {
    await redis.connect();
    console.log("✅ Connected to Redis (Upstash)");
  } catch (err) {
    console.error("❌ Redis connection failed:", err);
    process.exit(1);
  }
})();

// ================== STATIC FILES ==================
app.use(express.static("public"));

// ================== REDIS MESSAGE HELPERS ==================
const MESSAGE_TTL = 6 * 60 * 60; // 6 hours
const MAX_MESSAGES = 200;

async function storeMessage(roomId, msg) {
  const key = `room:${roomId}`;

  await redis.rPush(key, JSON.stringify(msg));
  await redis.lTrim(key, -MAX_MESSAGES, -1);
  await redis.expire(key, MESSAGE_TTL);
}

async function getRecentMessages(roomId) {
  const key = `room:${roomId}`;
  const messages = await redis.lRange(key, 0, -1);
  return messages.map(m => JSON.parse(m));
}

// ================== SOCKET.IO ==================
io.on("connection", async (socket) => {
  console.log("User connected:", socket.id);

  const DEFAULT_ROOM = "001";
  let currentRoom = DEFAULT_ROOM;
  let username = "Guest";

  socket.join(DEFAULT_ROOM);

  // 🔹 LOAD history on connect
  const history = await getRecentMessages(DEFAULT_ROOM);
  socket.emit("chat-history", history);

  socket.emit("room joined", DEFAULT_ROOM);

  // 🔹 CHAT MESSAGE
  socket.on("chat message", async (data) => {
    const message = data?.message?.trim();
    if (!message) return;

    username = data.username || username;

    const msg = {
      username,
      message,
      timestamp: Date.now()
    };

    await storeMessage(currentRoom, msg);

    io.to(currentRoom).emit("chat message", msg);
  });

  // 🔹 JOIN ROOM
  socket.on("join room", async (roomId) => {
    if (!/^\d{3}$/.test(roomId)) return;
    if (roomId === currentRoom) return;

    socket.leave(currentRoom);
    currentRoom = roomId;
    socket.join(roomId);

    const history = await getRecentMessages(roomId);
    socket.emit("chat-history", history);

    socket.emit("room joined", roomId);
  });

  socket.on("disconnect", () => {
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
