// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// Create Express app
const app = express();

// Create HTTP server
const server = http.createServer(app);

// Attach Socket.IO to the server
const io = new Server(server);

// Use dynamic port (for Render) or default 3000
const PORT = process.env.PORT || 3000;

// Serve static files from "public" folder
app.use(express.static("public"));

// Handle socket connections
io.on("connection", (socket) => {
  console.log("User connected");

  // Listen for chat messages
  socket.on("chat message", (data) => {
    io.emit("chat message", data); // broadcast to all users
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

// ✅ Only one listen call
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
