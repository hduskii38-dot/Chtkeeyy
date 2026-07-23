// Chtkeey — backend server
// Express serves the static frontend + a couple of location-check APIs.
// Socket.io handles the anonymous random-matching chat itself.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const { cleanText } = require('./filter');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const CENTER_LAT = parseFloat(process.env.CENTER_LAT || '36.8642');
const CENTER_LNG = parseFloat(process.env.CENTER_LNG || '42.9903');
const ALLOWED_RADIUS_KM = parseFloat(process.env.ALLOWED_RADIUS_KM || '100');
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-before-deploy';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- basic rate limiting on the API endpoints ----
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

// ---- Haversine distance in km ----
function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- 1. Device GPS check (accurate, requires the visitor to allow it) ----
app.post('/api/verify-location', (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ allowed: false, reason: 'missing-coordinates' });
  }
  const d = distanceKm(lat, lng, CENTER_LAT, CENTER_LNG);
  return res.json({
    allowed: d <= ALLOWED_RADIUS_KM,
    distanceKm: Math.round(d * 10) / 10,
    radiusKm: ALLOWED_RADIUS_KM
  });
});

// ---- 2. IP-based fallback check (used when GPS is denied/unavailable) ----
app.get('/api/ip-check', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    // Local/dev IPs can't be geolocated — let them through in dev only.
    if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return res.json({ allowed: true, dev: true, city: 'local-dev' });
    }
    const r = await fetch(`https://ipapi.co/${ip}/json/`);
    const data = await r.json();
    const country = (data.country_name || '').toLowerCase();
    const region = (data.region || '').toLowerCase();
    const city = (data.city || '').toLowerCase();
    const isIraq = country === 'iraq';
    const isNearDuhok = ['duhok', 'dohuk', 'zakho', 'amedi', 'amadiya', 'sumel', 'akre', 'shekhan', 'kurdistan'].some(
      (k) => region.includes(k) || city.includes(k)
    );
    return res.json({ allowed: isIraq && isNearDuhok, country: data.country_name, region: data.region, city: data.city });
  } catch (err) {
    console.error('ip-check failed', err.message);
    return res.json({ allowed: false, error: true });
  }
});

// ---- Admin: recent reports (very light protection, see README) ----
const REPORTS_FILE = path.join(__dirname, 'reports.log');
function logReport(entry) {
  fs.appendFile(REPORTS_FILE, JSON.stringify(entry) + '\n', () => {});
}
app.get('/api/admin/reports', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  if (!fs.existsSync(REPORTS_FILE)) return res.json({ reports: [] });
  const lines = fs.readFileSync(REPORTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const reports = lines.slice(-200).map((l) => JSON.parse(l)).reverse();
  res.json({ reports });
});

// ================= Socket.io matching + chat =================
const waitingQueue = [];
const rooms = new Map();
const socketMeta = new Map();
const bannedFingerprints = new Set();

function pairWaiting() {
  while (waitingQueue.length >= 2) {
    const a = waitingQueue.shift();
    const b = waitingQueue.shift();
    const sa = io.sockets.sockets.get(a);
    const sb = io.sockets.sockets.get(b);
    if (!sa || !sb) {
      if (sa) waitingQueue.unshift(a);
      if (sb) waitingQueue.unshift(b);
      continue;
    }
    const roomId = `room-${a}-${b}`;
    sa.join(roomId);
    sb.join(roomId);
    socketMeta.get(a).roomId = roomId;
    socketMeta.get(b).roomId = roomId;
    rooms.set(roomId, [a, b]);
    sa.emit('matched', { partnerNickname: socketMeta.get(b).nickname });
    sb.emit('matched', { partnerNickname: socketMeta.get(a).nickname });
  }
}

function leaveRoom(socketId, { notifyPartner = true, reason = 'left' } = {}) {
  const meta = socketMeta.get(socketId);
  if (!meta || !meta.roomId) return;
  const pair = rooms.get(meta.roomId);
  rooms.delete(meta.roomId);
  if (pair) {
    const otherId = pair.find((id) => id !== socketId);
    const otherSocket = otherId && io.sockets.sockets.get(otherId);
    if (otherSocket) {
      if (otherId && socketMeta.has(otherId)) socketMeta.get(otherId).roomId = null;
      otherSocket.leave(meta.roomId);
      if (notifyPartner) otherSocket.emit('partner-left', { reason });
    }
  }
  const s = io.sockets.sockets.get(socketId);
  if (s) s.leave(meta.roomId);
  meta.roomId = null;
}

function removeFromQueue(socketId) {
  const idx = waitingQueue.indexOf(socketId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

io.on('connection', (socket) => {
  const nickname = (socket.handshake.query.nickname || 'Stranger').toString().slice(0, 20);
  socketMeta.set(socket.id, { nickname, reportCount: 0, roomId: null });

  socket.on('find-partner', () => {
    if (bannedFingerprints.has(socket.handshake.address)) {
      socket.emit('banned');
      return;
    }
    leaveRoom(socket.id, { notifyPartner: true, reason: 'requeued' });
    removeFromQueue(socket.id);
    waitingQueue.push(socket.id);
    socket.emit('searching');
    pairWaiting();
  });

  socket.on('chat-message', (text) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !meta.roomId) return;
    const clean = cleanText(String(text || '').slice(0, 1000));
    socket.to(meta.roomId).emit('chat-message', { text: clean, from: 'stranger' });
    socket.emit('chat-message', { text: clean, from: 'me' });
  });

  socket.on('typing', (isTyping) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !meta.roomId) return;
    socket.to(meta.roomId).emit('typing', isTyping);
  });

  socket.on('report', ({ reason } = {}) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !meta.roomId) return;
    const pair = rooms.get(meta.roomId) || [];
    const otherId = pair.find((id) => id !== socket.id);
    const otherMeta = otherId && socketMeta.get(otherId);
    if (otherMeta) {
      otherMeta.reportCount += 1;
      logReport({
        time: new Date().toISOString(),
        reportedNickname: otherMeta.nickname,
        reporterNickname: meta.nickname,
        reason: (reason || 'unspecified').toString().slice(0, 200)
      });
      if (otherMeta.reportCount >= 3) {
        const otherSocket = otherId && io.sockets.sockets.get(otherId);
        if (otherSocket) {
          bannedFingerprints.add(otherSocket.handshake.address);
          otherSocket.emit('banned');
          otherSocket.disconnect(true);
        }
      }
    }
    leaveRoom(socket.id, { notifyPartner: true, reason: 'reported' });
    socket.emit('report-received');
  });

  socket.on('leave-chat', () => {
    leaveRoom(socket.id, { notifyPartner: true, re
