/* ============================================================
   CricScore – Real-Time Server  (Express + Socket.io + MongoDB)
   ============================================================ */
require('dotenv').config();
const express    = require('express');
const compression = require('compression');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const mongoose   = require('mongoose');
const dns        = require('dns');

// Configure reliable DNS servers for MongoDB SRV lookups (prevents ECONNREFUSED on Windows/cloud ISPs)
try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch (e) {
  console.warn('Unable to set custom DNS servers:', e.message);
}
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
  
  // Non-blocking for OTP, Auth, and status endpoints
  if (req.path === '/send-otp' || req.path === '/verify-otp' || req.path === '/otp-login' || req.path === '/db-status') {
    if (mongoose.connection.readyState === 0) connectMongo();
    return next();
  }

  console.log('⚠️ MongoDB not connected (readyState:', mongoose.connection.readyState, '). Reconnecting...');
  try {
    if (MONGO_URI) {
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 15000,
        family: 4,
      });
      isMongoConnected = true;
    }
    next();
  } catch (err) {
    isMongoConnected = false;
    console.warn('⚠️ DB connection unavailable. Continuing in standalone mode:', err.message);
    next(); // Proceed gracefully so auth and app continue working
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

const teamSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  logo:        { type: String, default: '' },
  captain:     { type: String, default: '' },
  viceCaptain: { type: String, default: '' },
  location:    { type: String, default: '' },
  createdBy:   { type: String, default: '' },
  players:     { type: Array, default: [] },
  createdAt:   { type: Date, default: Date.now }
});

const tournamentSchema = new mongoose.Schema({
  name:            { type: String, required: true },
  logo:            { type: String, default: '' },
  location:        { type: String, default: '' },
  startDate:       { type: String, default: '' },
  endDate:         { type: String, default: '' },
  format:          { type: String, default: 'T20' },
  oversPerInnings: { type: Number, default: 20 },
  numTeams:        { type: Number, default: 0 },
  numMatches:      { type: Number, default: 0 },
  createdBy:       { type: String, default: '' },
  teams:           { type: Array, default: [] },
  status:          { type: String, default: 'Upcoming' },
  createdAt:       { type: Date, default: Date.now }
});

const User       = mongoose.model('User', userSchema);
const Match      = mongoose.model('Match', matchSchema);
const Team       = mongoose.model('Team', teamSchema);
const Tournament = mongoose.model('Tournament', tournamentSchema);

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
app.use(compression());
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
//  TEAMS API
// ─────────────────────────────────────────────────────────────
app.get('/api/teams', async (req, res) => {
  try {
    const teams = await Team.find().sort({ createdAt: -1 });
    res.json(teams);
  } catch (err) {
    console.error('[DB] Error fetching teams:', err);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

app.post('/api/teams', async (req, res) => {
  const { name, logo, captain, viceCaptain, location, createdBy, players } = req.body;
  if (!name) return res.status(400).json({ error: 'Team name is required' });
  try {
    const team = await Team.create({
      name,
      logo: logo || '',
      captain: captain || '',
      viceCaptain: viceCaptain || '',
      location: location || '',
      createdBy: createdBy || '',
      players: players || []
    });
    console.log(`[DB] Team created: ${team.name}`);
    res.json({ success: true, team });
  } catch (err) {
    console.error('[DB] Error creating team:', err);
    res.status(500).json({ error: err.message || 'Failed to create team' });
  }
});

app.put('/api/teams/:id', async (req, res) => {
  try {
    const team = await Team.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    res.json({ success: true, team });
  } catch (err) {
    console.error('[DB] Error updating team:', err);
    res.status(500).json({ error: 'Failed to update team' });
  }
});

app.delete('/api/teams/:id', async (req, res) => {
  try {
    await Team.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[DB] Error deleting team:', err);
    res.status(500).json({ error: 'Failed to delete team' });
  }
});

// ─────────────────────────────────────────────────────────────
//  TOURNAMENTS API
// ─────────────────────────────────────────────────────────────
app.get('/api/tournaments', async (req, res) => {
  try {
    const tournaments = await Tournament.find().sort({ createdAt: -1 });
    res.json(tournaments);
  } catch (err) {
    console.error('[DB] Error fetching tournaments:', err);
    res.status(500).json({ error: 'Failed to fetch tournaments' });
  }
});

app.post('/api/tournaments', async (req, res) => {
  const { name, logo, location, startDate, endDate, format, oversPerInnings, numTeams, createdBy, teams, status } = req.body;
  if (!name) return res.status(400).json({ error: 'Tournament name is required' });
  try {
    const tournament = await Tournament.create({
      name,
      logo: logo || '',
      location: location || '',
      startDate: startDate || '',
      endDate: endDate || '',
      format: format || 'T20',
      oversPerInnings: oversPerInnings || 20,
      numTeams: numTeams || (teams ? teams.length : 0),
      createdBy: createdBy || '',
      teams: teams || [],
      status: status || 'Upcoming'
    });
    console.log(`[DB] Tournament created: ${tournament.name}`);
    res.json({ success: true, tournament });
  } catch (err) {
    console.error('[DB] Error creating tournament:', err);
    res.status(500).json({ error: err.message || 'Failed to create tournament' });
  }
});

app.put('/api/tournaments/:id', async (req, res) => {
  try {
    const tournament = await Tournament.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
    res.json({ success: true, tournament });
  } catch (err) {
    console.error('[DB] Error updating tournament:', err);
    res.status(500).json({ error: 'Failed to update tournament' });
  }
});

app.delete('/api/tournaments/:id', async (req, res) => {
  try {
    await Tournament.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[DB] Error deleting tournament:', err);
    res.status(500).json({ error: 'Failed to delete tournament' });
  }
});

// ── Twilio Client Setup (Optional Production SMS Gateway) ──
let twilioClient = null;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;

if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log('✅ Twilio SMS Gateway initialized successfully');
  } catch (err) {
    console.warn('⚠️ Twilio SDK initialization failed:', err.message);
  }
} else {
  console.log('ℹ️ Twilio credentials not set in .env — using mock OTP mode for local development');
}

// Helper to format E.164 phone numbers (defaults to +91 for 10-digit Indian mobile numbers if no country code)
function formatE164Phone(rawPhone) {
  let cleaned = rawPhone.replace(/[\s\-\(\)]/g, '');
  if (!cleaned.startsWith('+')) {
    if (cleaned.length === 10) {
      cleaned = '+91' + cleaned;
    } else {
      cleaned = '+' + cleaned;
    }
  }
  return cleaned;
}

// ── Nodemailer Transporter (Email OTP Gateway) ──
let mailTransporter = null;
const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.gmail.com';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || '587');
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || (EMAIL_USER ? `"CricScore" <${EMAIL_USER}>` : '"CricScore" <no-reply@cricscore.local>');

if (EMAIL_USER && EMAIL_PASS) {
  try {
    const nodemailer = require('nodemailer');
    mailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
      }
    });
    console.log(`✅ Nodemailer initialized with account: ${EMAIL_USER}`);
  } catch (err) {
    console.warn('⚠️ Nodemailer initialization failed:', err.message);
  }
} else {
  console.log('ℹ️ EMAIL_USER / EMAIL_PASS not set in .env — using mock Email OTP mode for local development');
}

// ─────────────────────────────────────────────────────────────
//  AUTH API
// ─────────────────────────────────────────────────────────────

// In-memory OTP store (with expiration timestamp)
const otps = {};

// Send OTP (supports Mobile number or Email)
app.post('/api/send-otp', async (req, res) => {
  let { phone, type } = req.body;
  if (!phone) return res.status(400).json({ error: 'Mobile number or Email address is required' });
  
  const rawId = phone.trim();
  const normalizedKey = rawId.toLowerCase().replace(/[\s\-\(\)]/g, '');

  try {
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes TTL
    
    // Store OTP in memory
    otps[normalizedKey] = { code: otpCode, expiresAt };
    otps[rawId] = { code: otpCode, expiresAt };

    console.log(`[AUTH] OTP generated for ${rawId}: ${otpCode}`);

    const isEmail = rawId.includes('@') && rawId.includes('.');
    const isMobile = /^\+?[0-9]{10,15}$/.test(normalizedKey);

    // 1. Send via Real Email if it's an email address
    if (isEmail) {
      if (!mailTransporter) {
        console.warn(`[AUTH] Email OTP requested for ${rawId} but mailTransporter is not configured`);
        return res.status(400).json({
          error: 'Unable to send OTP. Please try again.'
        });
      }

      try {
        await mailTransporter.sendMail({
          from: `"CricScore App" <${EMAIL_USER}>`,
          to: rawId,
          subject: `CricScore Login OTP: ${otpCode}`,
          text: `Your CricScore login OTP code is ${otpCode}. Valid for 10 minutes. Do not share this code with anyone.`,
          html: `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #cbd5e1; border-radius: 16px; background-color: #ffffff;">
              <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #00a896; margin: 0; font-size: 26px; font-weight: 800;">CricScore</h1>
                <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Live Ball-by-Ball Cricket Scoring</p>
              </div>
              <div style="background-color: #f8fafc; border-radius: 12px; padding: 24px; text-align: center; border: 1px solid #e2e8f0; margin-bottom: 20px;">
                <p style="color: #475569; font-size: 14px; margin-bottom: 12px; font-weight: 600;">Your One-Time Password (OTP) for Login:</p>
                <div style="font-size: 34px; font-weight: 900; letter-spacing: 6px; color: #0284c7; background: #ffffff; padding: 12px 20px; border-radius: 10px; border: 2px dashed #0284c7; display: inline-block; box-shadow: 0 2px 8px rgba(2, 132, 199, 0.15);">
                  ${otpCode}
                </div>
                <p style="color: #94a3b8; font-size: 12px; margin-top: 14px; margin-bottom: 0;">This OTP code is valid for 10 minutes. Do not share this code.</p>
              </div>
              <p style="color: #94a3b8; font-size: 11px; text-align: center;">If you did not request this OTP, please ignore this email.</p>
            </div>
          `
        });
        console.log(`[AUTH] Real email OTP sent to ${rawId}`);
        return res.json({
          success: true,
          message: `OTP email sent successfully to ${rawId}! Check your inbox.`,
          realEmail: true
        });
      } catch (mailErr) {
        console.error('❌ Nodemailer email error:', mailErr.message);
        return res.status(400).json({
          error: 'Unable to send OTP. Please try again.'
        });
      }
    }

    // 2. Send via Twilio SMS if it's a phone number and Twilio is configured
    if (isMobile && twilioClient && (TWILIO_PHONE_NUMBER || TWILIO_VERIFY_SERVICE_SID)) {
      try {
        const formattedPhone = formatE164Phone(rawId);
        if (TWILIO_VERIFY_SERVICE_SID) {
          await twilioClient.verify.v2.services(TWILIO_VERIFY_SERVICE_SID)
            .verifications.create({ to: formattedPhone, channel: 'sms' });
          console.log(`[AUTH] Twilio Verify OTP sent to ${formattedPhone}`);
        } else {
          await twilioClient.messages.create({
            body: `Your CricScore OTP is ${otpCode}. Valid for 10 minutes. Do not share this code.`,
            from: TWILIO_PHONE_NUMBER,
            to: formattedPhone
          });
          console.log(`[AUTH] Twilio SMS OTP sent to ${formattedPhone}`);
        }

        return res.json({
          success: true,
          message: `SMS OTP sent successfully to ${formattedPhone}`,
          realSMS: true,
          otp: otpCode
        });
      } catch (smsErr) {
        console.error('❌ Twilio SMS error:', smsErr.message);
      }
    }

    // 3. Fallback / Mock Mode
    res.json({
      success: true,
      message: `OTP sent to ${rawId}`,
      otp: otpCode,
      realEmail: false,
      realSMS: false
    });
  } catch (err) {
    console.error('[AUTH] send-otp error:', err);
    res.status(500).json({ error: 'Server error sending OTP' });
  }
});

// Verify OTP API
app.post('/api/verify-otp', async (req, res) => {
  let { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'Mobile/Email and OTP are required' });
  
  const rawId = phone.trim();
  const normalizedKey = rawId.toLowerCase().replace(/[\s\-\(\)]/g, '');
  const stored = otps[normalizedKey] || otps[rawId];

  if (twilioClient && TWILIO_VERIFY_SERVICE_SID && /^\+?[0-9]{10,15}$/.test(normalizedKey)) {
    try {
      const formattedPhone = formatE164Phone(rawId);
      const check = await twilioClient.verify.v2.services(TWILIO_VERIFY_SERVICE_SID)
        .verificationChecks.create({ to: formattedPhone, code: otp });

      if (check.status === 'approved') {
        delete otps[normalizedKey];
        delete otps[rawId];
        return res.json({ success: true, message: 'OTP verified successfully' });
      }
    } catch (err) {
      console.warn('Twilio Verify check failed, checking local store:', err.message);
    }
  }

  if (!stored) {
    return res.status(400).json({ error: 'No OTP requested for this mobile number or email' });
  }

  const codeMatch = (typeof stored === 'object') ? stored.code === otp.trim() : stored === otp.trim();
  const isExpired = (typeof stored === 'object') ? (Date.now() > stored.expiresAt) : false;

  if (!codeMatch || isExpired) {
    return res.status(400).json({ error: 'Invalid or expired OTP code' });
  }

  delete otps[normalizedKey];
  delete otps[rawId];
  res.json({ success: true, message: 'OTP verified successfully' });
});

// OTP Login & Auto-register API
app.post('/api/otp-login', async (req, res) => {
  let { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'Mobile/Email and OTP are required' });
  
  const rawId = phone.trim();
  const normalizedKey = rawId.toLowerCase().replace(/[\s\-\(\)]/g, '');
  const stored = otps[normalizedKey] || otps[rawId];

  if (!stored && !(twilioClient && TWILIO_VERIFY_SERVICE_SID)) {
    return res.status(400).json({ error: 'No OTP requested for this mobile number or email' });
  }

  if (stored) {
    const codeMatch = (typeof stored === 'object') ? stored.code === otp.trim() : stored === otp.trim();
    const isExpired = (typeof stored === 'object') ? (Date.now() > stored.expiresAt) : false;

    if (!codeMatch || isExpired) {
      return res.status(400).json({ error: 'Invalid or expired OTP code' });
    }
    delete otps[normalizedKey];
    delete otps[rawId];
  }

  try {
    let user = null;
    if (mongoose.connection.readyState === 1) {
      user = await User.findOne({
        $or: [
          { phone: normalizedKey },
          { phone: rawId },
          { username: new RegExp(`^${rawId.split('@')[0]}$`, 'i') },
          { email: rawId.toLowerCase() }
        ]
      });

      if (!user) {
        const cleanName = rawId.includes('@') ? rawId.split('@')[0] : rawId;
        user = await User.create({
          phone: normalizedKey || rawId,
          username: cleanName,
          email: rawId.includes('@') ? rawId.toLowerCase() : `${cleanName}@cricscore.local`,
          password: 'otp_auth_' + Math.random().toString(36).substring(2),
          profile: { matchName: cleanName, battingHand: 'Right Hand', bowlingType: 'Right-arm Fast' }
        });
        console.log(`[AUTH] Auto-created user via OTP login: ${cleanName}`);
      } else {
        console.log(`[AUTH] OTP login successful for: ${user.username || user.phone}`);
      }

      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      if (!user.logins) user.logins = [];
      user.logins.push({ timestamp: new Date().toISOString(), ip });
      if (user.logins.length > 10) user.logins.shift();
      await user.save();
    }

    const userProfile = (user && user.profile && Object.keys(user.profile).length > 0) 
      ? user.profile 
      : { matchName: (rawId.includes('@') ? rawId.split('@')[0] : rawId), battingHand: 'Right Hand', bowlingType: 'Right-arm Fast' };
    const returnPhone = (user && user.phone) ? user.phone : rawId;

    res.json({
      success: true,
      user: {
        phone: returnPhone,
        profile: userProfile
      }
    });
  } catch (err) {
    console.warn('[DB] otp-login fallback:', err.message);
    const cleanName = rawId.includes('@') ? rawId.split('@')[0] : rawId;
    res.json({
      success: true,
      user: {
        phone: rawId,
        profile: { matchName: cleanName, battingHand: 'Right Hand', bowlingType: 'Right-arm Fast' }
      }
    });
  }
});

// GET user profile endpoint for profile sync
app.get('/api/profile', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'Phone or Login ID required' });
  try {
    const user = await User.findOne({
      $or: [
        { phone },
        { username: new RegExp(`^${phone}$`, 'i') },
        { email: phone.toLowerCase() }
      ]
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, profile: user.profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  const stored = otps[phone];
  const codeMatch = (typeof stored === 'object') ? stored.code === otp : stored === otp;
  const isExpired = (typeof stored === 'object') ? (Date.now() > stored.expiresAt) : false;

  if (!codeMatch || isExpired) return res.status(400).json({ error: 'Invalid or expired OTP' });

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
