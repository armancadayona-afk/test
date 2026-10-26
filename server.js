/**
 * On-Tour - Apartment Tour Presentation Backend Server
 * Production-ready Express + Socket.IO WebRTC Signaling Engine
 */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { Server } = require('socket.io');

const app = express();
// CRITICAL FOR RENDER: trust reverse proxy so HTTPS is recognized for secure cookies
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false }
});

// Environment Configuration
const PORT = process.env.PORT || 3000;

// Clean surrounding quotes and whitespace from ADMIN_PASSWORD if added in Render dashboard
let rawAdminPassword = process.env.ADMIN_PASSWORD || 'ChangeThisAdminPassword123!';
if ((rawAdminPassword.startsWith('"') && rawAdminPassword.endsWith('"')) ||
    (rawAdminPassword.startsWith("'") && rawAdminPassword.endsWith("'"))) {
  rawAdminPassword = rawAdminPassword.slice(1, -1);
}
const ADMIN_PASSWORD = rawAdminPassword.trim();
const SESSION_SECRET = (process.env.SESSION_SECRET || 'on-tour-default-stable-secret-key-2026').trim();

// In-Memory Room Management State
const rooms = new Map();

// Session Setup with secure: 'auto' so it works seamlessly over Render HTTPS and local HTTP
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: 'auto',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 Hours
  }
});

// Security & Parsing Middlewares
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

// Serve static assets from public
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiting on Authentication Endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait a few minutes and try again.' }
});

// --- REST Endpoints & Clean Page Routes (Per Spec Section 3) ---

// Direct URL: /admin
app.get('/admin', (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  }
  // If not logged in, serve the dedicated admin login portal
  return res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// Direct URL: /call
app.get('/call', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'call.html'));
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const inputPassword = (req.body.password || '').trim();
  if (!inputPassword) {
    return res.status(400).json({ error: 'Password is required' });
  }

  // Safe string comparison
  const bufA = Buffer.from(inputPassword);
  const bufB = Buffer.from(ADMIN_PASSWORD);
  const matched = (bufA.length === bufB.length) && crypto.timingSafeEqual(bufA, bufB);

  if (matched) {
    req.session.isAdmin = true;
    req.session.save((err) => {
      if (err) {
        console.error("Session save error:", err);
        return res.status(500).json({ error: 'Session initialization error' });
      }
      return res.json({ success: true, redirect: '/admin' });
    });
  } else {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ success: true, redirect: '/' });
    });
  } else {
    res.json({ success: true, redirect: '/' });
  }
});

app.get('/api/admin/check-session', (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.json({ authenticated: true });
  }
  return res.json({ authenticated: false });
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

// Share session middleware with Socket.IO
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// --- Socket.IO Room & WebRTC Signaling ---
io.on('connection', (socket) => {
  let currentRoom = null;
  let userRole = null;
  let userDisplayName = null;

  // 1. Room Creation (Admin Only)
  socket.on('create-room', (callback) => {
    const session = socket.request.session;
    if (!session || !session.isAdmin) {
      return callback({ error: 'Unauthorized: Admin authentication required.' });
    }

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
    const isAdmin = session && session.isAdmin && (socket.id === room.adminSocketId || !room.adminSocketId);

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

    // Notify others in room
    socket.to(cleanRoomCode).emit('participant-joined', {
      socketId: socket.id,
      displayName: userDisplayName,
      role: userRole
    });

    // Provide client with room meta, admin status, and peer lists
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
  console.log(`[ON-TOUR] Server listening on http://0.0.0.0:${PORT}`);
});
