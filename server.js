const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const { Server } = require("socket.io");

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
const MESSAGE_TTL = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
const messageStore = new Map(); // roomId -> Array of {username, message, timestamp, expiresAt}

// =================== KEEP-ALIVE MECHANISM ===================
// This prevents the server from shutting down due to inactivity
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutes (less than 15 to be safe)
let keepAliveTimer = null;
let keepAliveEnabled = true; // Start with keep-alive enabled

function startKeepAlive() {
  // Don't start if disabled
  if (!keepAliveEnabled) {
    console.log(`[${new Date().toISOString()}] Keep-alive is disabled`);
    return;
  }
  
  // Clear existing timer if any
  if (keepAliveTimer) {
    clearTimeout(keepAliveTimer);
  }
  
  // Schedule the next keep-alive ping
  keepAliveTimer = setTimeout(() => {
    keepServerAlive();
    startKeepAlive(); // Restart the timer
  }, KEEP_ALIVE_INTERVAL);
  
  console.log(`[${new Date().toISOString()}] Keep-alive timer started (next in ${KEEP_ALIVE_INTERVAL / 60000} minutes)`);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearTimeout(keepAliveTimer);
    keepAliveTimer = null;
    console.log(`[${new Date().toISOString()}] Keep-alive timer stopped`);
  }
}

function keepServerAlive() {
  // Don't run if disabled
  if (!keepAliveEnabled) {
    return;
  }
  
  // This function creates a small "ping" to keep the server active
  console.log(`[${new Date().toISOString()}] Sending keep-alive signal`);
  
  // Option 1: Send a ping to all connected clients
  // This keeps WebSocket connections alive
  if (io && io.sockets) {
    io.emit("keep-alive-ping", {
      timestamp: new Date().toISOString(),
      message: "Server keep-alive ping",
      keepAliveEnabled: keepAliveEnabled
    });
  }
  
  // Option 2: Log server status (just to show activity)
  const totalUsers = users.size;
  const totalRooms = rooms.size;
  const totalMessages = Array.from(messageStore.values())
    .reduce((acc, messages) => acc + messages.length, 0);
  
  console.log(`[${new Date().toISOString()}] Server status: ${totalUsers} users, ${totalRooms} rooms, ${totalMessages} messages stored`);
  
  // Option 3: Make a small HTTP request to itself
  // This works for Render.com and similar platforms
  if (keepAliveEnabled && (process.env.NODE_ENV === 'production' || process.env.RENDER)) {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    try {
      const protocol = url.startsWith('https') ? https : http;
      const req = protocol.get(`${url}/api/health`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log(`[${new Date().toISOString()}] Keep-alive HTTP request successful`);
        });
      });
      
      req.on('error', (err) => {
        console.log(`[${new Date().toISOString()}] Keep-alive HTTP request failed: ${err.message}`);
      });
      
      req.setTimeout(5000, () => {
        req.destroy();
        console.log(`[${new Date().toISOString()}] Keep-alive HTTP request timeout`);
      });
    } catch (error) {
      console.log(`[${new Date().toISOString()}] Keep-alive error: ${error.message}`);
    }
  }
}

// Add a health check endpoint for keep-alive
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    users: users.size,
    rooms: rooms.size,
    messages: Array.from(messageStore.values())
      .reduce((acc, messages) => acc + messages.length, 0),
    keepAliveEnabled: keepAliveEnabled
  });
});

// Add a simple endpoint that just returns 200 OK
app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});
// =================== END KEEP-ALIVE MECHANISM ===================

// Function to store a message
function storeMessage(roomId, username, message) {
  const timestamp = new Date().toISOString();
  const expiresAt = Date.now() + MESSAGE_TTL; // Use milliseconds since epoch
  
  const messages = messageStore.get(roomId) || [];
  const messageObj = { 
    username, 
    message, 
    timestamp, 
    expiresAt // Store as timestamp (number) not Date object
  };
  
  messages.push(messageObj);
  messageStore.set(roomId, messages);
  
  // Keep only the last 200 messages per room to prevent memory issues
  if (messages.length > 200) {
    messages.splice(0, messages.length - 200);
  }
  
  return messageObj;
}

// Function to cleanup expired messages
function cleanupExpiredMessages() {
  const now = Date.now(); // Use timestamp for comparison
  let totalRemoved = 0;
  
  console.log(`[${new Date().toISOString()}] Starting message cleanup...`);
  
  for (const [roomId, messages] of messageStore.entries()) {
    if (!messages || messages.length === 0) continue;
    
    const originalLength = messages.length;
    
    // Filter out expired messages
    const activeMessages = messages.filter(msg => {
      // Check if expiresAt exists and is a valid number
      if (!msg.expiresAt || typeof msg.expiresAt !== 'number') {
        console.warn(`Invalid expiresAt for message in room ${roomId}:`, msg);
        return true; // Keep messages with invalid expiresAt
      }
      
      return msg.expiresAt > now;
    });
    
    const removed = originalLength - activeMessages.length;
    totalRemoved += removed;
    
    if (removed > 0) {
      messageStore.set(roomId, activeMessages);
      console.log(`Removed ${removed} expired messages from room ${roomId}`);
    }
  }
  
  if (totalRemoved > 0) {
    console.log(`[${new Date().toISOString()}] Cleanup complete: Removed ${totalRemoved} expired messages total`);
  }
  
  // Log current message counts for debugging
  let totalMessages = 0;
  for (const messages of messageStore.values()) {
    totalMessages += messages.length;
  }
  console.log(`[${new Date().toISOString()}] Total messages stored: ${totalMessages}`);
}

// Cleanup interval to remove expired messages
setInterval(cleanupExpiredMessages, 3600000); // Run every hour

// Function to get messages for a room
function getMessagesForRoom(roomId, limit = 50) {
  const messages = messageStore.get(roomId) || [];
  const now = Date.now();
  
  // Filter out expired messages
  const activeMessages = messages.filter(msg => {
    if (!msg.expiresAt || typeof msg.expiresAt !== 'number') {
      return true; // Keep messages with invalid expiresAt
    }
    return msg.expiresAt > now;
  });
  
  // Update store with filtered messages
  if (activeMessages.length < messages.length) {
    messageStore.set(roomId, activeMessages);
  }
  
  // Return last 'limit' messages
  return activeMessages.slice(-limit);
}

// Function to handle server commands from chat
function handleServerCommand(socket, message, user) {
  const room = user.room;
  
  // Check for server!power!down! command
  if (message.toLowerCase() === "server!power!down!") {
    if (keepAliveEnabled) {
      keepAliveEnabled = false;
      stopKeepAlive();
      
      // Send confirmation message to the room
      const adminMessage = {
        username: "Server Admin",
        message: "⚡ Keep-alive function DISABLED. Server may shut down due to inactivity to save instance hours.",
        room: room,
        timestamp: new Date().toISOString(),
        isSystem: true
      };
      
      // Store the system message
      storeMessage(room, adminMessage.username, adminMessage.message);
      
      // Broadcast to users in the same room
      io.to(room).emit("chat message", adminMessage);
      
      // Also log to console
      console.log(`[${new Date().toISOString()}] Server command: Keep-alive disabled by ${user.username} in room ${room}`);
      
      // Send private confirmation to command sender
      socket.emit("chat message", {
        username: "Server Admin",
        message: "✅ Keep-alive disabled. Server will use less instance hours but may shut down after ~25 minutes of inactivity.",
        room: room,
        timestamp: new Date().toISOString(),
        isSystem: true
      });
    } else {
      // Already disabled
      socket.emit("chat message", {
        username: "Server Admin",
        message: "⚠️ Keep-alive is already disabled.",
        room: room,
        timestamp: new Date().toISOString(),
        isSystem: true
      });
    }
    return true;
  }
  
  // Check for server!power!on command
  if (message.toLowerCase() === "server!power!on") {
    if (!keepAliveEnabled) {
      keepAliveEnabled = true;
      startKeepAlive();
      
      // Send confirmation message to the room
      const adminMessage = {
        username: "Server Admin",
        message: "⚡ Keep-alive function ENABLED. Server will stay active to prevent shutdown.",
        room: room,
        timestamp: new Date().toISOString(),
        isSystem: true
      };
      
      // Store the system message
      storeMessage(room, adminMessage.username, adminMessage.message);
      
      // Broadcast to users in the same room
      io.to(room).emit("chat message", adminMessage);
      
      // Also log to console
      console.log(`[${new Date().toISOString()}] Server command: Keep-alive enabled by ${user.username} in room ${room}`);
      
      // Send private confirmation to command sender
      socket.emit("chat message", {
        username: "Server Admin",
        message: "✅ Keep-alive enabled. Server will stay active to conserve instance hours.",
        room: room,
        timestamp: new Date().toISOString(),
        isSystem: true
      });
    } else {
      // Already enabled
      socket.emit("chat message", {
        username: "Server Admin",
        message: "⚠️ Keep-alive is already enabled.",
        room: room,
        timestamp: new Date().toISOString(),
        isSystem: true
      });
    }
    return true;
  }
  
  // Check for server!status command
  if (message.toLowerCase() === "server!status") {
    const totalUsers = users.size;
    const totalRooms = rooms.size;
    const totalMessages = Array.from(messageStore.values())
      .reduce((acc, messages) => acc + messages.length, 0);
    
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    
    const statusMessage = {
      username: "Server Admin",
      message: `📊 Server Status:\n• Uptime: ${hours}h ${minutes}m ${seconds}s\n• Users: ${totalUsers}\n• Rooms: ${totalRooms}\n• Messages stored: ${totalMessages}\n• Keep-alive: ${keepAliveEnabled ? 'ENABLED ✅' : 'DISABLED ⚠️'}\n• Instance hours: ${keepAliveEnabled ? 'Conserving' : 'Saving'}`,
      room: room,
      timestamp: new Date().toISOString(),
      isSystem: true
    };
    
    socket.emit("chat message", statusMessage);
    return true;
  }
  
  // Check for server!help command
  if (message.toLowerCase() === "server!help") {
    const helpMessage = {
      username: "Server Admin",
      message: `🔧 Server Commands:\n• server!power!down! - Disable keep-alive (save instance hours)\n• server!power!on - Enable keep-alive (prevent shutdown)\n• server!status - Show server status\n• server!help - Show this help`,
      room: room,
      timestamp: new Date().toISOString(),
      isSystem: true
    };
    
    socket.emit("chat message", helpMessage);
    return true;
  }
  
  return false; // Not a server command
}

// Handle socket connections
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Default user info
  users.set(socket.id, {
    username: `Guest${Math.floor(Math.random() * 1000)}`,
    room: null
  });

  // Handle chat messages
  socket.on("chat message", (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const room = data.room || user.room;
    const message = data.message || "";
    
    // Check if this is a server command
    if (handleServerCommand(socket, message, user)) {
      // Command was handled, don't process as regular message
      return;
    }

    // Store the message
    const storedMessage = storeMessage(
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

    // If user is in the room, broadcast to that room
    if (user.room === room) {
      socket.to(room).emit("chat message", messageData);
    }

    // Also send back to sender
    socket.emit("chat message", messageData);

    // Broadcast to users in the same room
    io.to(room).emit("chat message", messageData);
    console.log(`Message in room ${room}: ${messageData.username}: ${messageData.message}`);
    
    // Reset keep-alive timer when there's activity (if enabled)
    if (keepAliveEnabled && keepAliveTimer) {
      clearTimeout(keepAliveTimer);
      startKeepAlive();
    }
  });

  // Handle room joining
  socket.on("join room", (data) => {
    const room = data.room || "001";
    const formattedRoom = room.padStart(3, "0");
    
    // Leave current room if any
    const user = users.get(socket.id);
    if (user && user.room) {
      const currentRoom = rooms.get(user.room);
      if (currentRoom) {
        currentRoom.delete(socket.id);
        if (currentRoom.size === 0) {
          rooms.delete(user.room);
        }
      }
      socket.leave(user.room);
    }

    // Join new room
    socket.join(formattedRoom);
    
    if (!rooms.has(formattedRoom)) {
      rooms.set(formattedRoom, new Set());
    }
    rooms.get(formattedRoom).add(socket.id);

    // Update user info
    if (user) {
      user.room = formattedRoom;
      user.username = data.username || user.username;
      users.set(socket.id, user);
    }

    // Get previous messages for the room
    const previousMessages = getMessagesForRoom(formattedRoom);

    // Send room info and previous messages to the user
    socket.emit("room joined", {
      room: formattedRoom,
      username: user.username,
      userCount: rooms.get(formattedRoom).size,
      previousMessages: previousMessages
    });

    // Notify others in the room
    socket.to(formattedRoom).emit("user joined", {
      username: user.username,
      userCount: rooms.get(formattedRoom).size
    });

    console.log(`User ${socket.id} joined room ${formattedRoom}`);
    
    // Reset keep-alive timer when there's activity (if enabled)
    if (keepAliveEnabled && keepAliveTimer) {
      clearTimeout(keepAliveTimer);
      startKeepAlive();
    }
  });

  // Handle leaving a room
  socket.on("leave room", (roomId) => {
    const user = users.get(socket.id);
    if (user && user.room === roomId) {
      socket.leave(roomId);
      
      const room = rooms.get(roomId);
      if (room) {
        room.delete(socket.id);
        if (room.size === 0) {
          rooms.delete(roomId);
        } else {
          // Notify remaining users
          socket.to(roomId).emit("user left", {
            username: user.username,
            userCount: room.size
          });
        }
      }
      
      user.room = null;
      users.set(socket.id, user);

      socket.emit('room left', roomId);
      console.log(`User ${socket.id} left room ${roomId}`);
      
      // Reset keep-alive timer when there's activity (if enabled)
      if (keepAliveEnabled && keepAliveTimer) {
        clearTimeout(keepAliveTimer);
        startKeepAlive();
      }
    }
  });

  // Handle username change
  socket.on("change username", (username) => {
    const user = users.get(socket.id);
    if (user) {
      user.username = username || 'Guest';
      
      // Reset keep-alive timer when there's activity (if enabled)
      if (keepAliveEnabled && keepAliveTimer) {
        clearTimeout(keepAliveTimer);
        startKeepAlive();
      }
    }
  });

  // Handle keep-alive ping from client
  socket.on("keep-alive-pong", () => {
    // Client responded to ping
    if (keepAliveEnabled && keepAliveTimer) {
      clearTimeout(keepAliveTimer);
      startKeepAlive();
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (user && user.room) {
      const room = rooms.get(user.room);
      if (room) {
        room.delete(socket.id);
        if (room.size === 0) {
          rooms.delete(user.room);
        } else {
          // Notify remaining users
          socket.to(user.room).emit("user left", {
            username: user.username,
            userCount: room.size
          });
        }
      }
    }
    
    users.delete(socket.id);
    console.log(`User disconnected: ${socket.id}`);
  });

  // Handle request for room list
  socket.on("get rooms", () => {
    const roomList = Array.from(rooms.entries()).map(([room, users]) => ({
      room,
      userCount: users.size
    }));
    socket.emit('rooms list', roomList);
    
    // Reset keep-alive timer when there's activity (if enabled)
    if (keepAliveEnabled && keepAliveTimer) {
      clearTimeout(keepAliveTimer);
      startKeepAlive();
    }
  });
});

// API endpoint to get current rooms and users
app.get("/api/rooms", (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([room, users]) => ({
    room,
    userCount: users.size
  }));
  
  res.json({
    totalRooms: roomList.length,
    totalUsers: Array.from(users.keys()).length,
    rooms: roomList,
    timestamp: new Date().toISOString(),
    keepAliveEnabled: keepAliveEnabled
  });
  
  // Reset keep-alive timer when there's activity (if enabled)
  if (keepAliveEnabled && keepAliveTimer) {
    clearTimeout(keepAliveTimer);
    startKeepAlive();
  }
});

// Add API endpoint to get message statistics
app.get("/api/message-stats", (req, res) => {
  const roomStats = {};
  let totalMessages = 0;
  
  for (const [roomId, messages] of messageStore.entries()) {
    roomStats[roomId] = messages.length;
    totalMessages += messages.length;
  }
  
  res.json({
    totalMessages,
    messagesPerRoom: roomStats,
    cleanupRuns: Math.floor(Date.now() / 3600000), // hours since epoch
    timestamp: new Date().toISOString(),
    keepAliveEnabled: keepAliveEnabled
  });
  
  // Reset keep-alive timer when there's activity (if enabled)
  if (keepAliveEnabled && keepAliveTimer) {
    clearTimeout(keepAliveTimer);
    startKeepAlive();
  }
});

// Add endpoint to check keep-alive status
app.get("/api/keep-alive-status", (req, res) => {
  res.json({
    keepAliveEnabled: keepAliveEnabled,
    timerActive: keepAliveTimer !== null,
    nextKeepAliveIn: keepAliveTimer ? KEEP_ALIVE_INTERVAL : 0,
    timestamp: new Date().toISOString()
  });
});

// Serve main HTML file
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
  
  // Reset keep-alive timer when there's activity (if enabled)
  if (keepAliveEnabled && keepAliveTimer) {
    clearTimeout(keepAliveTimer);
    startKeepAlive();
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Room-based chat system ready`);
  console.log(`Rooms available: 001-100`);
  console.log(`Messages will be stored for 6 hours`);
  
  // Start the keep-alive mechanism
  startKeepAlive();
  console.log(`Keep-alive mechanism started (every ${KEEP_ALIVE_INTERVAL / 60000} minutes)`);
  console.log(`Server commands available in chat:`);
  console.log(`  • "server!power!down!" - Disable keep-alive to save instance hours`);
  console.log(`  • "server!power!on" - Enable keep-alive to prevent shutdown`);
  console.log(`  • "server!status" - Show server status`);
  console.log(`  • "server!help" - Show help for server commands`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  stopKeepAlive();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  stopKeepAlive();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
