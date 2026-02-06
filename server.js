// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const redis = require("redis");

// Create Express app
const app = express();

// Create HTTP server
const server = http.createServer(app);

// Attach Socket.IO to the server with CORS configuration
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Use dynamic port (for Render) or default 3000
const PORT = process.env.PORT || 3000;

// Serve static files from "public" folder
app.use(express.static("public"));

// Track rooms and users (in-memory for active connections)
const rooms = new Map(); // roomId -> Set of socketIds
const users = new Map(); // socketId -> {username, room}

// =================== REDIS CONFIGURATION ===================
// For debugging: Paste your Redis URL directly here
const REDIS_URL = 'redis://default:Rq8Eio5fK4QnSMVWeq6vywH0FHYJseHa@redis-16146.crce220.us-east-1-4.ec2.cloud.redislabs.com:16146'; // ⬅️ CHANGE THIS TO YOUR CLOUD REDIS URL

const redisClient = redis.createClient({
  url: REDIS_URL,
  // For cloud Redis with TLS (uncomment if needed):
  // socket: {
  //   tls: true,
  //   rejectUnauthorized: false
  // }
});

// Redis event handlers for better debugging
redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err.message);
  console.error('Full error:', err);
});

redisClient.on('connect', () => {
  console.log('Redis Client Connected');
});

redisClient.on('ready', () => {
  console.log('Redis Client Ready');
});

redisClient.on('reconnecting', () => {
  console.log('Redis Client Reconnecting...');
});

// Fallback in-memory storage for when Redis fails
const fallbackStore = new Map();

// Connect to Redis
redisClient.connect().then(() => {
  console.log('Connected to Redis successfully');
}).catch(err => {
  console.error('Failed to connect to Redis:', err.message);
  console.warn('⚠️  Using fallback in-memory storage (messages will not persist)');
});
// =================== END REDIS CONFIGURATION ===================

// Add a simple endpoint that just returns 200 OK
app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

// Store message in Redis with 6-hour expiration (with fallback)
async function storeMessage(roomId, username, message) {
  const timestamp = new Date().toISOString();
  const messageKey = `message:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
  const messageData = {
    username,
    message,
    timestamp,
    room: roomId
  };
  
  try {
    // Try Redis first
    await redisClient.setEx(messageKey, 6 * 60 * 60, JSON.stringify(messageData));
    
    // Also add to room's message list for easy retrieval
    const roomMessagesKey = `room:${roomId}:messages`;
    await redisClient.lPush(roomMessagesKey, messageKey);
    
    // Trim list to keep only last 200 messages
    await redisClient.lTrim(roomMessagesKey, 0, 199);
    
    // Set expiration on room messages list as well (6 hours + buffer)
    await redisClient.expire(roomMessagesKey, 6 * 60 * 60 + 3600);
    
    console.log(`✓ Message stored in Redis for room ${roomId}`);
    
  } catch (redisError) {
    console.error('Redis store failed, using fallback storage:', redisError.message);
    
    // Fallback to in-memory storage
    if (!fallbackStore.has(roomId)) {
      fallbackStore.set(roomId, []);
    }
    
    const messages = fallbackStore.get(roomId);
    messages.push({
      ...messageData,
      expiresAt: Date.now() + (6 * 60 * 60 * 1000)
    });
    
    // Keep only last 100 messages
    if (messages.length > 100) {
      messages.splice(0, messages.length - 100);
    }
    
    console.log(`⚠️  Message stored in fallback memory for room ${roomId}`);
  }
  
  return messageData;
}

// Get recent messages from Redis for a specific room (with fallback)
async function getRecentMessages(roomId) {
  try {
    // Try Redis first
    const roomMessagesKey = `room:${roomId}:messages`;
    const messageKeys = await redisClient.lRange(roomMessagesKey, 0, -1);
    
    const messages = [];
    
    for (const messageKey of messageKeys) {
      try {
        const messageData = await redisClient.get(messageKey);
        if (messageData) {
          const message = JSON.parse(messageData);
          messages.push(message);
        }
      } catch (err) {
        console.error(`Error fetching message ${messageKey}:`, err.message);
      }
    }
    
    // Sort by timestamp (newest first)
    messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Return only last 100 messages (oldest first for display)
    const result = messages.reverse().slice(-100);
    console.log(`✓ Retrieved ${result.length} messages from Redis for room ${roomId}`);
    return result;
    
  } catch (err) {
    console.error(`Redis get failed for room ${roomId}, using fallback:`, err.message);
    
    // Fallback to in-memory storage
    if (fallbackStore.has(roomId)) {
      const now = Date.now();
      const messages = fallbackStore.get(roomId)
        .filter(msg => msg.expiresAt > now)
        .map(({ username, message, timestamp, room }) => ({
          username,
          message,
          timestamp,
          room
        }));
      
      console.log(`⚠️  Retrieved ${messages.length} messages from fallback for room ${roomId}`);
      return messages.slice(-100); // Return last 100 messages
    }
    
    return [];
  }
}

// Cleanup expired messages periodically (for fallback storage)
setInterval(() => {
  try {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [roomId, messages] of fallbackStore) {
      const validMessages = messages.filter(msg => msg.expiresAt > now);
      if (validMessages.length === 0) {
        fallbackStore.delete(roomId);
      } else {
        fallbackStore.set(roomId, validMessages);
      }
      cleanedCount += (messages.length - validMessages.length);
    }
    
    if (cleanedCount > 0) {
      console.log(`Cleaned up ${cleanedCount} expired messages from fallback storage`);
    }
  } catch (err) {
    console.error('Error during fallback cleanup:', err);
  }
}, 3600000); // Run every hour

// Handle socket connections
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Default to room '001'
  socket.join('001');
  rooms.set('001', rooms.get('001') || new Set());
  rooms.get('001').add(socket.id);
  users.set(socket.id, { username: 'Guest', room: '001' });
  
  // Send recent messages from the default room
  getRecentMessages('001').then(recentMessages => {
    recentMessages.forEach(msg => {
      socket.emit("chat message", msg);
    });
  });
  
  socket.emit('room joined', '001');

  // Listen for chat messages
  socket.on("chat message", async (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const room = data.room || user.room;
    const message = data.message || "";
    
    // Store the message in Redis (or fallback)
    const storedMessage = await storeMessage(
      room,
      data.username || user.username,
      message
    );
    
    // Add username and room to data
    const messageData = {
      username: data.username || user.username,
      message: message,
      room: room,
      timestamp: storedMessage.timestamp
    };
    
    // Update user's username if provided
    if (data.username) {
      user.username = data.username;
    }
    
    // Broadcast to users in the same room
    io.to(room).emit("chat message", messageData);
    console.log(`Message in room ${room}: ${messageData.username}: ${messageData.message}`);
  });

  // Handle room joining
  socket.on("join room", async (roomId) => {
    // Validate room ID (001-100)
    if (!/^\d{3}$/.test(roomId)) {
      socket.emit('error', 'Invalid room ID. Must be 3 digits (001-100).');
      return;
    }
    
    const roomNum = parseInt(roomId);
    if (roomNum < 1 || roomNum > 100) {
      socket.emit('error', 'Room must be between 001 and 100.');
      return;
    }
    
    const formattedRoom = roomNum.toString().padStart(3, '0');
    const user = users.get(socket.id);
    
    if (user && user.room === formattedRoom) {
      // Already in this room
      return;
    }
    
    // Leave previous room
    if (user && user.room) {
      socket.leave(user.room);
      const prevRoomUsers = rooms.get(user.room);
      if (prevRoomUsers) {
        prevRoomUsers.delete(socket.id);
        if (prevRoomUsers.size === 0) {
          rooms.delete(user.room);
        }
      }
      socket.emit('room left', user.room);
    }
    
    // Join new room
    socket.join(formattedRoom);
    
    // Update room tracking
    if (!rooms.has(formattedRoom)) {
      rooms.set(formattedRoom, new Set());
    }
    rooms.get(formattedRoom).add(socket.id);
    
    // Update user info
    if (user) {
      user.room = formattedRoom;
    } else {
      users.set(socket.id, { username: 'Guest', room: formattedRoom });
    }
    
    // Send recent messages from the new room
    const recentMessages = await getRecentMessages(formattedRoom);
    recentMessages.forEach(msg => {
      socket.emit("chat message", msg);
    });
    
    // Notify user
    socket.emit('room joined', formattedRoom);
    
    // Notify others in the room (optional)
    socket.to(formattedRoom).emit('user joined', {
      username: user?.username || 'Guest',
      room: formattedRoom
    });
    
    console.log(`User ${socket.id} joined room ${formattedRoom}`);
  });

  // Handle leaving a room
  socket.on("leave room", (roomId) => {
    const user = users.get(socket.id);
    if (user && user.room === roomId) {
      socket.leave(roomId);
      
      const roomUsers = rooms.get(roomId);
      if (roomUsers) {
        roomUsers.delete(socket.id);
        if (roomUsers.size === 0) {
          rooms.delete(roomId);
        }
      }
      
      socket.emit('room left', roomId);
      console.log(`User ${socket.id} left room ${roomId}`);
    }
  });

  // Handle username updates
  socket.on("update username", (username) => {
    const user = users.get(socket.id);
    if (user) {
      user.username = username || 'Guest';
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (user) {
      // Remove from room tracking
      const roomUsers = rooms.get(user.room);
      if (roomUsers) {
        roomUsers.delete(socket.id);
        if (roomUsers.size === 0) {
          rooms.delete(user.room);
        }
      }
      
      // Remove user
      users.delete(socket.id);
      
      // Notify others in the room (optional)
      socket.to(user.room).emit('user left', {
        username: user.username,
        room: user.room
      });
    }
    
    console.log(`User disconnected: ${socket.id}`);
  });

  // Send room list on request
  socket.on("get rooms", () => {
    const roomList = Array.from(rooms.keys())
      .sort()
      .map(room => ({
        id: room,
        userCount: rooms.get(room).size
      }));
    socket.emit('rooms list', roomList);
  });
});

// Add API endpoint to get room statistics
app.get("/api/rooms", (req, res) => {
  const roomList = Array.from(rooms.keys())
    .sort()
    .map(room => ({
      id: room,
      userCount: rooms.get(room).size
    }));
  res.json({
    totalRooms: roomList.length,
    totalUsers: Array.from(users.keys()).length,
    rooms: roomList,
    timestamp: new Date().toISOString()
  });
});

// Add API endpoint to get message statistics from Redis
app.get("/api/message-stats", async (req, res) => {
  try {
    // Get all room keys from Redis
    const roomKeys = await redisClient.keys('room:*:messages');
    const roomStats = {};
    let totalMessages = 0;
    
    for (const roomKey of roomKeys) {
      const roomId = roomKey.split(':')[1];
      const messageCount = await redisClient.lLen(roomKey);
      roomStats[roomId] = messageCount;
      totalMessages += messageCount;
    }
    
    // Add fallback storage stats
    let fallbackTotal = 0;
    const fallbackStats = {};
    for (const [roomId, messages] of fallbackStore) {
      fallbackStats[roomId] = messages.length;
      fallbackTotal += messages.length;
    }
    
    res.json({
      redis: {
        totalMessages,
        messagesPerRoom: roomStats,
        connected: redisClient.isReady
      },
      fallback: {
        totalMessages: fallbackTotal,
        messagesPerRoom: fallbackStats
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error getting message stats:', err);
    res.status(500).json({ 
      error: 'Failed to get message statistics',
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Add API endpoint to get messages for a specific room
app.get("/api/rooms/:roomId/messages", async (req, res) => {
  const { roomId } = req.params;
  
  if (!/^\d{3}$/.test(roomId)) {
    return res.status(400).json({ error: 'Invalid room ID format' });
  }
  
  try {
    const messages = await getRecentMessages(roomId);
    res.json({
      roomId,
      messageCount: messages.length,
      messages: messages,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error(`Error getting messages for room ${roomId}:`, err);
    res.status(500).json({ 
      error: 'Failed to get messages',
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Add API endpoint to check Redis health
app.get("/api/redis-health", async (req, res) => {
  try {
    const pingResult = await redisClient.ping();
    
    res.json({
      status: 'healthy',
      redis: pingResult === 'PONG' ? 'connected' : 'disconnected',
      pingResult: pingResult,
      url: REDIS_URL.substring(0, 50) + (REDIS_URL.length > 50 ? '...' : ''), // Show first 50 chars
      timestamp: new Date().toISOString(),
      isReady: redisClient.isReady,
      fallbackActive: fallbackStore.size > 0
    });
  } catch (err) {
    res.status(500).json({
      status: 'unhealthy',
      redis: 'disconnected',
      error: err.message,
      url: REDIS_URL.substring(0, 50) + (REDIS_URL.length > 50 ? '...' : ''),
      timestamp: new Date().toISOString(),
      isReady: redisClient.isReady,
      fallbackActive: fallbackStore.size > 0
    });
  }
});

// Serve main HTML file
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Room-based chat system ready`);
  console.log(`Rooms available: 001-100`);
  console.log(`Messages will be stored in Redis for 6 hours`);
  console.log(`Redis URL: ${REDIS_URL.substring(0, 50)}${REDIS_URL.length > 50 ? '...' : ''}`);
  
  // Ensure Redis connection is ready
  try {
    await redisClient.ping();
    console.log('✅ Redis connection verified - PONG received');
    
    // Test Redis is working by setting a test key
    await redisClient.set('chat:test:connection', 'OK', {
      EX: 10 // expires in 10 seconds
    });
    console.log('✅ Redis test write successful');
    
    // Check existing data
    const keys = await redisClient.keys('room:*');
    console.log(`📊 Found ${keys.length} existing room keys in Redis`);
    
  } catch (err) {
    console.error('❌ Redis connection failed:', err.message);
    console.error('Make sure your Redis URL is correct and the service is accessible.');
    console.error('Current Redis URL:', REDIS_URL);
    
    if (REDIS_URL === 'redis://localhost:6379') {
      console.log('\n⚠️  You are using localhost:6379');
      console.log('   If using cloud Redis, update the REDIS_URL variable at the top of server.js');
      console.log('   Example: const REDIS_URL = \'redis://username:password@hostname:port\';');
    }
    
    console.warn('\n⚠️  Server will continue with fallback in-memory storage');
    console.warn('   Messages will NOT persist between server restarts');
  }
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  try {
    if (redisClient.isReady) {
      await redisClient.quit();
      console.log('Redis connection closed');
    }
  } catch (err) {
    console.error('Error closing Redis connection:', err);
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down gracefully...');
  try {
    if (redisClient.isReady) {
      await redisClient.quit();
      console.log('Redis connection closed');
    }
  } catch (err) {
    console.error('Error closing Redis connection:', err);
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
