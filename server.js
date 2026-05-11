/* ============================================================
   CricScore – Real-Time Server  (Express + Socket.io)
   ============================================================ */
const express    = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });

// Middleware
app.use(express.json());
// Serve static files from the same directory
app.use(express.static(path.join(__dirname)));

// ── User tracking logic ──
const USERS_FILE = path.join(__dirname, 'users.json');

function getUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error("Error reading users file:", err);
    return [];
  }
}

function saveUser(email, ip) {
  const users = getUsers();
  const newUser = {
    email,
    ip,
    timestamp: new Date().toISOString()
  };
  users.push(newUser);
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("Error saving user:", err);
  }
}

// API to record login
app.post('/api/login', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  saveUser(email, ip);
  
  console.log(`[AUTH] User logged in: ${email}`);
  res.json({ success: true });
});

// API to view logged-in users
app.get('/api/users', (req, res) => {
  res.json(getUsers());
});

// ── Room store: code → { hostId, state, viewers } ──
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

io.on('connection', (socket) => {

  // Host creates a new room
  socket.on('host-match', (cb) => {
    let code;
    do { code = genCode(); } while (rooms.has(code));
    rooms.set(code, { hostId: socket.id, state: null, viewers: 0 });
    socket.join(code);
    socket.data.code = code;
    socket.data.role = 'host';
    cb({ code });
    console.log(`[${code}] Room created`);
  });

  // Viewer joins
  socket.on('join-match', ({ code }, cb) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) return cb({ error: 'Match not found. Check the code.' });
    const c = code.toUpperCase();
    socket.join(c);
    socket.data.code = c;
    socket.data.role = 'viewer';
    room.viewers++;
    io.to(room.hostId).emit('viewer-count', room.viewers);
    cb({ ok: true, state: room.state });
    console.log(`[${c}] Viewer joined (${room.viewers} total)`);
  });

  // Host broadcasts updated state
  socket.on('push-state', ({ code, state }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    room.state = state;
    socket.to(code).emit('state-sync', state);
  });

  // Cleanup
  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (socket.data.role === 'host') {
      socket.to(code).emit('host-disconnected');
      rooms.delete(code);
      console.log(`[${code}] Room closed`);
    } else {
      room.viewers = Math.max(0, room.viewers - 1);
      io.to(room.hostId).emit('viewer-count', room.viewers);
    }
  });
});

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
  console.log(`\n🏏  CricScore LIVE  →  http://localhost:${PORT}\n`);
});
