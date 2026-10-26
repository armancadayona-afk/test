/**
 * On-Tour - Apartment Tour Presentation Backend Server
 * Production-ready Express + Socket.IO WebRTC Signaling Engine
 * (Admin Password Bypassed for Direct Testing)
 */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false }
});

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = (process.env.SESSION_SECRET || 'on-tour-default-stable-secret-key-2026').trim();

// In-Memory Room Management State
const rooms = new Map();

// Session Setup - accessible over both HTTP and HTTPS
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,
    secure: false, // Ensures cookie is accepted under any proxy setup
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
      connectSrc: ["'self'", "wss:", "ws:", "https:", "http:"],
      mediaSrc: ["'self'", "blob:", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// DIRECT ROUTE: /admin (Direct access - password bypassed)
app.get('/admin', (req, res) => {
  if (req.session) {
    req.session.isAdmin = true;
  }
  return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// DIRECT ROUTE: /call
app.get('/call', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'call.html'));
});

// Admin check-session endpoint always returns true for testing
app.get('/api/admin/check-session', (req, res) => {
  if (req.session) {
    req.session.isAdmin = true;
  }
  return res.json({ authenticated: true });
});

app.post('/api/admin/login', (req, res) => {
  if (req.session) {
    req.session.isAdmin = true;
  }
  return res.json({ success: true, redirect: '/admin' });
});

app.post('/api/admin/logout', (req, res) => {
  if (req.session) {
    req.session.isAdmin = false;
  }
  res.json({ success: true, redirect: '/' });
});

// Provide standard public STUN/TURN configurations
app.get('/api/ice-servers', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL.trim(),
      username: process.env.TURN_USERNAME.trim(),
      credential: process.env.TURN_CREDENTIAL.trim()
    });
  }

  res.json({ iceServers });
});

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// --- Socket.IO Room & WebRTC Signaling ---
io.on('connection', (socket) => {
  let currentRoom = null;
  let userRole = null;
  let userDisplayName = null;

  // 1. Room Creation (Admin)
  socket.on('create-room', (callback) => {
    // Password check bypassed for testing
    const roomCode = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 Characters
    rooms.set(roomCode, {
      adminSocketId: socket.id,
      createdAt: Date.now(),
      participants: new Map([[socket.id, { displayName: 'Tour Guide (Admin)', role: 'admin' }]]),
      chatHistory: []
    });

    currentRoom = roomCode;
    userRole = 'admin';
    userDisplayName = 'Tour Guide (Admin)';
    socket.join(roomCode);

    callback({ success: true, roomCode });
  });

  // 2. Joining Room
  socket.on('join-room', ({ roomCode, displayName }, callback) => {
    const cleanRoomCode = (roomCode || '').trim().toUpperCase();
    const cleanName = (displayName || '').trim();

    if (!rooms.has(cleanRoomCode)) {
      return callback({ error: 'Tour room not found or has concluded.' });
    }

    if (!cleanName) {
      return callback({ error: 'Display name is required.' });
    }

    const room = rooms.get(cleanRoomCode);
    const session = socket.request.session;
    const isAdmin = (socket.id === room.adminSocketId || !room.adminSocketId || (session && session.isAdmin));

    userRole = isAdmin ? 'admin' : 'client';
    userDisplayName = cleanName;
    currentRoom = cleanRoomCode;

    if (userRole === 'admin') {
      room.adminSocketId = socket.id;
    }

    room.participants.set(socket.id, {
      displayName: userDisplayName,
      role: userRole
    });

    socket.join(cleanRoomCode);

    socket.to(cleanRoomCode).emit('participant-joined', {
      socketId: socket.id,
      displayName: userDisplayName,
      role: userRole
    });

    const clientList = [];
    room.participants.forEach((data, id) => {
      if (id !== socket.id) {
        clientList.push({ socketId: id, displayName: data.displayName, role: data.role });
      }
    });

    callback({
      success: true,
      roomCode: cleanRoomCode,
      role: userRole,
      adminSocketId: room.adminSocketId,
      peers: clientList,
      chatHistory: room.chatHistory
    });
  });

  // 3. WebRTC Signaling Dispatch
  socket.on('webrtc-offer', ({ targetSocketId, sdp }) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    if (!room.participants.has(targetSocketId)) return;

    io.to(targetSocketId).emit('webrtc-offer', {
      senderSocketId: socket.id,
      displayName: userDisplayName,
      role: userRole,
      sdp
    });
  });

  socket.on('webrtc-answer', ({ targetSocketId, sdp }) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    if (!room.participants.has(targetSocketId)) return;

    io.to(targetSocketId).emit('webrtc-answer', {
      senderSocketId: socket.id,
      sdp
    });
  });

  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate }) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    if (!room.participants.has(targetSocketId)) return;

    io.to(targetSocketId).emit('webrtc-ice-candidate', {
      senderSocketId: socket.id,
      candidate
    });
  });

  // 4. Media State Toggle Announcements
  socket.on('media-state-change', ({ videoEnabled, audioEnabled }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('participant-media-state', {
      socketId: socket.id,
      videoEnabled: !!videoEnabled,
      audioEnabled: !!audioEnabled
    });
  });

  // 5. Room Chat
  socket.on('send-chat', ({ message }) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    if (typeof message !== 'string' || message.trim().length === 0) return;

    const sanitizedMessage = message.trim().slice(0, 500);
    const chatPayload = {
      sender: userDisplayName,
      role: userRole,
      text: sanitizedMessage,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    const room = rooms.get(currentRoom);
    room.chatHistory.push(chatPayload);
    if (room.chatHistory.length > 100) room.chatHistory.shift();

    io.to(currentRoom).emit('chat-broadcast', chatPayload);
  });

  // 6. Admin End Room Command
  socket.on('end-room', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    if (socket.id !== room.adminSocketId) return;

    io.to(currentRoom).emit('room-closed');
    rooms.delete(currentRoom);
    currentRoom = null;
  });

  // 7. Cleanup on Disconnect
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;

    const room = rooms.get(currentRoom);
    room.participants.delete(socket.id);

    if (socket.id === room.adminSocketId) {
      io.to(currentRoom).emit('admin-disconnected');
      room.adminSocketId = null;
    }

    socket.to(currentRoom).emit('participant-left', {
      socketId: socket.id,
      displayName: userDisplayName
    });

    if (room.participants.size === 0) {
      rooms.delete(currentRoom);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ON-TOUR] Server listening on http://0.0.0.0:${PORT} (Admin password bypassed)`);
});
