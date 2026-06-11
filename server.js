/* ============================================================
   CricScore – Real-Time Server  (Express + Socket.io)
   ============================================================ */
require('dotenv').config();
const express    = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const twilio     = require('twilio');

const app        = express();

// Twilio Setup (Optional: requires ENV vars to actually send SMS)
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const httpServer = createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });

// Configure Multer for profile photos
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
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Middleware
app.use(express.json());
// Serve static files from the same directory
app.use(express.static(path.join(__dirname)));
// Serve uploads folder
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── User management logic ──
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

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("Error saving users:", err);
  }
}

// ── Match history management logic ──
const MATCHES_FILE = path.join(__dirname, 'matches.json');

function getMatches() {
  try {
    if (!fs.existsSync(MATCHES_FILE)) return [];
    const data = fs.readFileSync(MATCHES_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error("Error reading matches file:", err);
    return [];
  }
}

function saveMatches(matches) {
  try {
    fs.writeFileSync(MATCHES_FILE, JSON.stringify(matches, null, 2));
  } catch (err) {
    console.error("Error saving matches:", err);
  }
}

// API to get match history
app.get('/api/matches', (req, res) => {
  res.json(getMatches());
});

// API to save a match
app.post('/api/matches', (req, res) => {
  const match = req.body;
  if (!match) return res.status(400).json({ error: 'Match data required' });
  
  const matches = getMatches();
  matches.push(match);
  saveMatches(matches);
  
  console.log(`[DATA] Match saved globally`);
  res.json({ success: true });
});

// In-memory OTP storage (for demonstration, resets on server restart)
const otps = {};

// API to send OTP
app.post('/api/send-otp', async (req, res) => {
  let { phone, type } = req.body;
  if (!phone) return res.status(400).json({ error: 'Mobile number required' });

  // Normalize: remove spaces, dashes, etc.
  phone = phone.replace(/[\s\-\(\)]/g, '');

  const users = getUsers();
  const userExists = users.find(u => u.phone === phone);

  if (type === 'reset') {
    if (!userExists) {
      return res.status(404).json({ error: 'This mobile number is not registered.' });
    }
  } else {
    // Default is registration
    if (userExists) {
      return res.status(400).json({ error: 'This mobile number is already registered. Please login instead.' });
    }
  }

  // Generate 6-digit OTP
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  otps[phone] = otpCode;

  // Attempt to send real SMS if Twilio is configured
  if (twilioClient && process.env.TWILIO_PHONE_NUMBER) {
    try {
      // Ensure phone number has country code for Twilio. Defaulting to +91 (India) if missing.
      const formattedPhone = phone.startsWith('+') ? phone : `+91${phone}`;
      
      await twilioClient.messages.create({
        body: `Your CricScore verification code is ${otpCode}. Do not share this code with anyone.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: formattedPhone
      });
      
      console.log(`[AUTH] REAL SMS sent to ${formattedPhone}`);
      return res.json({ success: true, message: 'OTP sent via SMS', realSMS: true });
    } catch (err) {
      console.error(`[AUTH] Failed to send real SMS: ${err.message}. Falling back to MOCK SMS.`);
      // Fallback to mock SMS below
    }
  }

  console.log(`[AUTH] MOCK SMS sent to ${phone}. OTP: ${otpCode}`);
  res.json({ success: true, message: 'OTP sent', otp: otpCode, realSMS: false });
});

// API to register
app.post('/api/register', (req, res) => {
  let { phone, password, otp } = req.body;
  
  if (!phone || !password || !otp) {
    return res.status(400).json({ error: 'All fields (Mobile, OTP, Password) are required' });
  }

  phone = phone.replace(/[\s\-\(\)]/g, '');
  
  // Validate OTP
  if (otps[phone] !== otp) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  
  const users = getUsers();
  if (users.find(u => u.phone === phone)) {
    return res.status(400).json({ error: 'User already exists' });
  }

  const newUser = {
    phone,
    password, // In a real app, hash this!
    profile: {
      matchName: phone, // Save phone by default
      battingHand: 'Right Hand',
      bowlingType: 'Right-arm Fast'
    },
    created: new Date().toISOString(),
    logins: []
  };

  users.push(newUser);
  saveUsers(users);
  
  // Clear OTP
  delete otps[phone];
  
  console.log(`[AUTH] New user registered: ${phone}`);
  res.json({ success: true, user: { phone: newUser.phone, profile: newUser.profile } });
});

// API to reset password
app.post('/api/reset-password', (req, res) => {
  let { phone, password, otp } = req.body;
  
  if (!phone || !password || !otp) {
    return res.status(400).json({ error: 'All fields (Mobile, OTP, New Password) are required' });
  }

  phone = phone.replace(/[\s\-\(\)]/g, '');
  
  // Validate OTP
  if (otps[phone] !== otp) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  const users = getUsers();
  const userIndex = users.findIndex(u => u.phone === phone);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'This mobile number is not registered.' });
  }

  // Update password
  users[userIndex].password = password;
  saveUsers(users);
  
  // Clear OTP
  delete otps[phone];
  
  console.log(`[AUTH] Password reset for user: ${phone}`);
  res.json({ success: true, message: 'Password reset successfully!' });
});

// API to login
app.post('/api/login', (req, res) => {
  let { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Mobile number and password required' });
  
  phone = phone.replace(/[\s\-\(\)]/g, '');
  
  const users = getUsers();
  const user = users.find(u => u.phone === phone);
  
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid mobile number or password' });
  }

  // Update login history
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  user.logins.push({ timestamp: new Date().toISOString(), ip });
  if (user.logins.length > 10) user.logins.shift(); // Keep last 10
  
  saveUsers(users);
  
  console.log(`[AUTH] User logged in: ${phone}`);
  res.json({ success: true, user: { phone: user.phone, profile: user.profile } });
});

// API to login via Visme Forms success event
app.post('/api/visme-login', (req, res) => {
  const phone = "VismeUser";
  const users = getUsers();
  let user = users.find(u => u.phone === phone);
  
  if (!user) {
    user = {
      phone,
      password: "password123",
      profile: {
        matchName: "Visme User",
        battingHand: 'Right Hand',
        bowlingType: 'Right-arm Fast'
      },
      created: new Date().toISOString(),
      logins: []
    };
    users.push(user);
    saveUsers(users);
    console.log(`[AUTH] Created new default VismeUser account`);
  }

  // Update login history
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  user.logins.push({ timestamp: new Date().toISOString(), ip });
  if (user.logins.length > 10) user.logins.shift();
  
  saveUsers(users);
  
  console.log(`[AUTH] User logged in via Visme Forms: ${phone}`);
  res.json({ success: true, user: { phone: user.phone, profile: user.profile } });
});


// API to update profile
app.post('/api/update-profile', (req, res) => {
  const { phone, profile } = req.body;
  if (!phone || !profile) return res.status(400).json({ error: 'Mobile number and profile required' });

  const users = getUsers();
  const userIndex = users.findIndex(u => u.phone === phone);
  
  if (userIndex === -1) return res.status(404).json({ error: 'User not found' });

  users[userIndex].profile = { ...users[userIndex].profile, ...profile };
  saveUsers(users);
  
  console.log(`[AUTH] Profile updated: ${phone}`);
  res.json({ success: true });
});

// API to upload avatar
app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
  const { phone } = req.body;
  if (!phone || !req.file) return res.status(400).json({ error: 'Mobile number and file required' });

  const users = getUsers();
  const userIndex = users.findIndex(u => u.phone === phone);
  if (userIndex === -1) return res.status(404).json({ error: 'User not found' });

  const avatarUrl = `/uploads/${req.file.filename}`;
  users[userIndex].profile.avatar = avatarUrl;
  saveUsers(users);

  console.log(`[AUTH] Avatar uploaded for: ${phone}`);
  res.json({ success: true, avatarUrl });
});

// API to view all users (for admin/debug)
app.get('/api/users', (req, res) => {
  // Filter out passwords for safety even in debug
  const users = getUsers().map(u => {
    const { password, ...safeUser } = u;
    return safeUser;
  });
  res.json(users);
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

  // WebRTC Signaling: Viewer requests audio
  socket.on('viewer-request-audio', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    // Send request to the host
    socket.to(room.hostId).emit('viewer-request-audio', { viewerId: socket.id });
  });

  // WebRTC Signaling: Relay ICE and SDP
  socket.on('webrtc-signal', ({ targetId, signal }) => {
    socket.to(targetId).emit('webrtc-signal', { from: socket.id, signal });
  });

  // Host toggles commentary state
  socket.on('commentary-state', ({ code, isLive }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    socket.to(code).emit('commentary-state', isLive);
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
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏏  CricScore LIVE  →  http://localhost:${PORT}\n`);
});
