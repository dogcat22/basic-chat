// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

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

// Track rooms and users
const rooms = new Map(); // roomId -> Set of socketIds
const users = new Map(); // socketId -> {username, room}

// Store messages temporarily (for 6 hours)
const messageStore = new Map(); // roomId -> Array of {username, message, timestamp, expiresAt}

// Cleanup interval to remove expired messages
setInterval(cleanupExpiredMessages, 3600000); // Run every hour

function cleanupExpiredMessages() {
  const now = Date.now();
  for (const [roomId, messages] of messageStore) {
    const validMessages = messages.filter(msg => msg.expiresAt > now);
    if (validMessages.length === 0) {
      messageStore.delete(roomId);
    } else {
      messageStore.set(roomId, validMessages);
    }
  }
  console.log(`Cleaned up expired messages at ${new Date().toISOString()}`);
}

function storeMessage(roomId, username, message) {
  const timestamp = new Date().toISOString();
  const expiresAt = Date.now() + (6 * 60 * 60 * 1000); // 6 hours from now
  
  if (!messageStore.has(roomId)) {
    messageStore.set(roomId, []);
  }
  
  const messages = messageStore.get(roomId);
  messages.push({
    username,
    message,
    timestamp,
    expiresAt
  });
  
  // Keep only the last 100 messages per room to prevent memory issues
  if (messages.length > 100) {
    messages.splice(0, messages.length - 100);
  }
  
  return { username, message, timestamp, expiresAt };
}

function getRecentMessages(roomId) {
  const now = Date.now();
  if (!messageStore.has(roomId)) {
    return [];
  }
  
  const messages = messageStore.get(roomId)
    .filter(msg => msg.expiresAt > now)
    .map(({ username, message, timestamp }) => ({
      username,
      message,
      timestamp,
      room: roomId
    }));
  
  return messages;
}

// Handle socket connections
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Default to room '001'
  socket.join('001');
  rooms.set('001', rooms.get('001') || new Set());
  rooms.get('001').add(socket.id);
  users.set(socket.id, { username: 'Guest', room: '001' });
  
  // Send recent messages from the default room
  const recentMessages = getRecentMessages('001');
  recentMessages.forEach(msg => {
    socket.emit("chat message", msg);
  });
  
  socket.emit('room joined', '001');

  // Listen for chat messages
  socket.on("chat message", (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const room = data.room || user.room;
    
    // Store the message
    const storedMessage = storeMessage(
      room,
      data.username || user.username,
      data.message
    );
    
    // Add username and room to data
    const messageData = {
      username: data.username || user.username,
      message: data.message,
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
  socket.on("join room", (roomId) => {
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
    const recentMessages = getRecentMessages(formattedRoom);
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
    rooms: roomList
  });
});

// Add API endpoint to get message statistics
app.get("/api/message-stats", (req, res) => {
  const now = Date.now();
  const roomStats = {};
  let totalMessages = 0;
  
  for (const [roomId, messages] of messageStore) {
    const validMessages = messages.filter(msg => msg.expiresAt > now);
    roomStats[roomId] = validMessages.length;
    totalMessages += validMessages.length;
  }
  
  res.json({
    totalMessages,
    messagesPerRoom: roomStats,
    cleanupRuns: Math.floor(Date.now() / 3600000) // hours since epoch
  });
});

// Serve main HTML file
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Room-based chat system ready`);
  console.log(`Rooms available: 001-100`);
  console.log(`Messages will be stored for 6 hours`);
});
