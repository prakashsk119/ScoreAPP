/* ============================================================
   CricScore – Real-Time Server  (Express + Socket.io + MongoDB)
   ============================================================ */
require('dotenv').config();
const express    = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const mongoose   = require('mongoose');
const dns        = require('dns');

// Prefer IPv4 for DNS resolution (prevents SRV lookup timeout on cloud hosts)
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}

const app        = express();

// ── MongoDB Connection ──
let MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/cricscore';
if (MONGO_URI.startsWith('mongodb+srv://') && !MONGO_URI.includes('authSource=')) {
  MONGO_URI += (MONGO_URI.includes('?') ? '&' : '?') + 'authSource=admin';
}

let isMongoConnected = false;
let lastMongoError = null;

function connectMongo() {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
  mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000,
    family: 4,
  })
    .then(() => {
      isMongoConnected = true;
      lastMongoError = null;
      console.log('✅ MongoDB connected successfully');
    })
    .catch(err => {
      isMongoConnected = false;
      lastMongoError = err.message;
      console.error('❌ MongoDB connection error:', err.message);
    });
}


connectMongo();

mongoose.connection.on('connected', () => { isMongoConnected = true; });
mongoose.connection.on('disconnected', () => { 
  isMongoConnected = false;
  console.log('⚠️ MongoDB disconnected. Scheduling reconnect in 5s...');
  setTimeout(connectMongo, 5000);
});

// Middleware to ensure DB is connected before processing API requests
async function ensureDbConnected(req, res, next) {
  if (mongoose.connection.readyState === 1) {
    isMongoConnected = true;
    return next();
  }
  console.log('⚠️ MongoDB not connected (readyState:', mongoose.connection.readyState, '). Reconnecting...');
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
      family: 4,
    });
    isMongoConnected = true;
    next();
  } catch (err) {
    isMongoConnected = false;
    console.error('❌ Database reconnect attempt failed:', err.message);
    return res.status(503).json({ error: 'Database connecting... Please try again in a few seconds.' });
  }
}



// ── Mongoose Schemas ──
const userSchema = new mongoose.Schema({
  phone:    { type: String, required: true, unique: true },
  username: String,
  email:    String,
  password: String,
  profile:  { type: mongoose.Schema.Types.Mixed, default: {} },
  created:  { type: Date, default: Date.now },
  logins:   { type: Array, default: [] }
});

const matchSchema = new mongoose.Schema({
  data:    { type: mongoose.Schema.Types.Mixed },
  savedAt: { type: Date, default: Date.now }
});

const User  = mongoose.model('User', userSchema);
const Match = mongoose.model('Match', matchSchema);

// ── HTTP + Socket.io setup ──
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false
  }
});

// ── CORS headers for all Express routes ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Multer for profile photos ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `avatar-${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ── Middleware ──
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Protect API routes with auto-reconnect DB middleware (except db-status and health)
app.use('/api', (req, res, next) => {
  if (req.path === '/db-status') return next();
  ensureDbConnected(req, res, next);
});

// ── Health check ──
app.get('/health', (req, res) => res.json({ status: 'ok', mongo: isMongoConnected }));


// ── DB Status (for debugging) ──
app.get('/api/db-status', (req, res) => {
  res.json({
    mongoConnected: isMongoConnected,
    mongoState: mongoose.connection.readyState,
    // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
    mongoURI: MONGO_URI ? 'set' : 'missing',
    env_MONGO_URI: process.env.MONGO_URI ? 'set ✅' : 'MISSING ❌',
    lastError: lastMongoError
  });
});


// ─────────────────────────────────────────────────────────────
//  MATCH HISTORY API
// ─────────────────────────────────────────────────────────────

app.get('/api/matches', async (req, res) => {
  try {
    const matches = await Match.find().sort({ savedAt: -1 });
    res.json(matches.map(m => m.data));
  } catch (err) {
    console.error('[DB] Error fetching matches:', err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

app.post('/api/matches', async (req, res) => {
  const matchData = req.body;
  if (!matchData) return res.status(400).json({ error: 'Match data required' });
  try {
    await Match.create({ data: matchData });
    console.log('[DATA] Match saved to MongoDB');
    res.json({ success: true });
  } catch (err) {
    console.error('[DB] Error saving match:', err);
    res.status(500).json({ error: 'Failed to save match' });
  }
});

// ─────────────────────────────────────────────────────────────
//  AUTH API
// ─────────────────────────────────────────────────────────────

// In-memory OTP store (resets on server restart — fine for MVP)
const otps = {};

// Send OTP
app.post('/api/send-otp', async (req, res) => {
  let { phone, type } = req.body;
  if (!phone) return res.status(400).json({ error: 'Mobile number required' });
  phone = phone.replace(/[\s\-\(\)]/g, '');

  try {
    const userExists = await User.findOne({ phone });
    if (type === 'reset') {
      if (!userExists) return res.status(404).json({ error: 'This mobile number is not registered.' });
    } else {
      if (userExists) return res.status(400).json({ error: 'This mobile number is already registered. Please login instead.' });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    otps[phone] = otpCode;
    console.log(`[AUTH] MOCK OTP for ${phone}: ${otpCode}`);
    res.json({ success: true, message: 'OTP sent', otp: otpCode, realSMS: false });
  } catch (err) {
    console.error('[DB] send-otp error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Register
app.post('/api/register', async (req, res) => {
  let { password, username, email } = req.body;
  if (!password || !username || !email)
    return res.status(400).json({ error: 'All fields (Username, Email, Password) are required' });

  username = username.trim();
  email = email.trim().toLowerCase();

  try {
    const existsUsername = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
    if (existsUsername) return res.status(400).json({ error: 'User with this username already exists' });

    const existsEmail = await User.findOne({ email });
    if (existsEmail) return res.status(400).json({ error: 'User with this email address already exists' });

    const phone = username;
    const newUser = await User.create({
      phone, username, email, password,
      profile: { matchName: username, battingHand: 'Right Hand', bowlingType: 'Right-arm Fast' }
    });

    console.log(`[AUTH] New user registered: ${username} (${email})`);
    res.json({ success: true, user: { phone: newUser.phone, profile: newUser.profile } });
  } catch (err) {
    console.error('[DB] register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset Password
app.post('/api/reset-password', async (req, res) => {
  let { phone, password, otp } = req.body;
  if (!phone || !password || !otp)
    return res.status(400).json({ error: 'All fields (Mobile, OTP, New Password) are required' });

  phone = phone.replace(/[\s\-\(\)]/g, '');
  if (otps[phone] !== otp) return res.status(400).json({ error: 'Invalid or expired OTP' });

  try {
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ error: 'This mobile number is not registered.' });

    user.password = password;
    await user.save();
    delete otps[phone];
    console.log(`[AUTH] Password reset for: ${phone}`);
    res.json({ success: true, message: 'Password reset successfully!' });
  } catch (err) {
    console.error('[DB] reset-password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  let { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Login ID and password required' });

  const loginId = phone.trim();
  const normalizedPhone = loginId.replace(/[\s\-\(\)]/g, '');

  try {
    const user = await User.findOne({
      $or: [
        { phone: normalizedPhone },
        { username: new RegExp(`^${loginId}$`, 'i') },
        { email: loginId.toLowerCase() }
      ]
    });

    if (!user || user.password !== password)
      return res.status(401).json({ error: 'Invalid credentials or password' });

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    user.logins.push({ timestamp: new Date().toISOString(), ip });
    if (user.logins.length > 10) user.logins.shift();
    await user.save();

    console.log(`[AUTH] User logged in: ${user.username || user.phone}`);
    res.json({ success: true, user: { phone: user.phone, profile: user.profile } });
  } catch (err) {
    console.error('[DB] login error:', err);
    res.status(500).json({ error: err.message || 'Login failed' });
  }
});

// Visme Login
app.post('/api/visme-login', async (req, res) => {
  const { phone, name } = req.body;
  const userPhone = phone || 'VismeUser';
  const userName  = name  || 'Visme User';

  try {
    let user = await User.findOne({ phone: userPhone });
    if (!user) {
      user = await User.create({
        phone: userPhone,
        password: 'password123',
        profile: { matchName: userName, battingHand: 'Right Hand', bowlingType: 'Right-arm Fast' }
      });
      console.log(`[AUTH] Created VismeUser: ${userPhone}`);
    } else if (name && name !== 'Visme User' && user.profile) {
      user.profile.matchName = name;
      await user.save();
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    user.logins.push({ timestamp: new Date().toISOString(), ip });
    if (user.logins.length > 10) user.logins.shift();
    await user.save();

    res.json({ success: true, user: { phone: user.phone, profile: user.profile } });
  } catch (err) {
    console.error('[DB] visme-login error:', err);
    res.status(500).json({ error: err.message || 'Visme login failed' });
  }
});

// Update Profile
app.post('/api/update-profile', async (req, res) => {
  const { phone, profile } = req.body;
  if (!phone || !profile) return res.status(400).json({ error: 'Mobile number and profile required' });

  try {
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.profile = { ...user.profile, ...profile };
    await user.save();
    console.log(`[AUTH] Profile updated: ${phone}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[DB] update-profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload Avatar
app.post('/api/upload-avatar', upload.single('avatar'), async (req, res) => {
  const { phone } = req.body;
  if (!phone || !req.file) return res.status(400).json({ error: 'Mobile number and file required' });

  try {
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const avatarUrl = `/uploads/${req.file.filename}`;
    user.profile.avatar = avatarUrl;
    await user.save();
    console.log(`[AUTH] Avatar uploaded for: ${phone}`);
    res.json({ success: true, avatarUrl });
  } catch (err) {
    console.error('[DB] upload-avatar error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// List Users (debug)
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find({}, { password: 0 });
    res.json(users);
  } catch (err) {
    console.error('[DB] users fetch error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch users' });
  }
});

// ─────────────────────────────────────────────────────────────
//  SOCKET.IO – Real-Time Match Rooms
// ─────────────────────────────────────────────────────────────

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

  // WebRTC signaling
  socket.on('viewer-request-audio', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    socket.to(room.hostId).emit('viewer-request-audio', { viewerId: socket.id });
  });

  socket.on('webrtc-signal', ({ targetId, signal }) => {
    socket.to(targetId).emit('webrtc-signal', { from: socket.id, signal });
  });

  socket.on('commentary-state', ({ code, isLive }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    socket.to(code).emit('commentary-state', isLive);
  });

  // Cleanup on disconnect
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

// ── Start Server ──
const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏏  CricScore LIVE  →  http://localhost:${PORT}\n`);
});
