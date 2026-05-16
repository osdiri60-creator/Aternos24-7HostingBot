const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { plugin: pvpPlugin } = require('mineflayer-pvp');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const configData = JSON.parse(fs.readFileSync('config.json'));
const host = configData.ip;
const port = configData.port;

function loadSettings() {
  return JSON.parse(fs.readFileSync('settings.json'));
}

let settingsData = loadSettings();
let username = settingsData.name;
let password = settingsData.password || '';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

let bot = null;
let botRunning = false;
let reconnecting = false;
let userStopped = false;
let currentMode = settingsData.mode || 'anti-afk';
let startTime = null;
let consoleHistory = [];
let intervals = [];

// ── Logger ────────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleTimeString('en-GB');
  const entry = `[${ts}] ${msg}`;
  console.log(entry);
  consoleHistory.push(entry);
  if (consoleHistory.length > 400) consoleHistory.shift();
  io.emit('console', entry);
}

// ── Status broadcast ──────────────────────────────────────────────────────────
function getStatus() {
  const uptime = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  const pos = bot && bot.entity ? bot.entity.position : null;
  let statusStr = 'stopped';
  if (botRunning) statusStr = 'online';
  else if (reconnecting && !userStopped) statusStr = 'reconnecting';
  return {
    running: botRunning,
    status: statusStr,
    uptime,
    position: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null,
    mode: currentMode,
    server: host
  };
}

setInterval(() => io.emit('status', getStatus()), 2000);

// ── Interval management ───────────────────────────────────────────────────────
function clearIntervals() {
  intervals.forEach(i => clearInterval(i));
  intervals = [];
}

// ── AuthMe support ────────────────────────────────────────────────────────────
function setupAuthMe(b) {
  if (!password) return;
  let loggedIn = false;

  b.on('messagestr', (msg) => {
    const lower = msg.toLowerCase();
    if (!loggedIn && (lower.includes('login') || lower.includes('log in'))) {
      setTimeout(() => {
        try { b.chat(`/login ${password}`); log(`AuthMe: Sent /login`); } catch (_) {}
      }, 600);
    }
    if (!loggedIn && (lower.includes('register'))) {
      setTimeout(() => {
        try { b.chat(`/register ${password} ${password}`); log(`AuthMe: Sent /register`); } catch (_) {}
      }, 600);
    }
    if (lower.includes('logged in') || lower.includes('welcome back') || lower.includes('successfully')) {
      loggedIn = true;
      log('AuthMe: Logged in successfully!');
    }
  });

  // Force login attempt on spawn after delay
  setTimeout(() => {
    try { b.chat(`/login ${password}`); log('AuthMe: Auto /login attempt'); } catch (_) {}
  }, 2500);
}

// ── AFK Mode ──────────────────────────────────────────────────────────────────
function startAFKMode(b) {
  log('[AFK Mode] Minimal movement — just enough to stay active');
  const i1 = setInterval(() => {
    if (!b || !b.entity) return;
    try {
      b.look(Math.random() * Math.PI * 2 - Math.PI, (Math.random() - 0.5) * 0.3, false);
    } catch (_) {}
  }, 20000);
  const i2 = setInterval(() => {
    if (!b || !b.entity) return;
    try {
      b.setControlState('jump', true);
      setTimeout(() => { try { b.setControlState('jump', false); } catch (_) {} }, 300);
    } catch (_) {}
  }, 30000);
  intervals.push(i1, i2);
}

// ── Anti-AFK Mode ─────────────────────────────────────────────────────────────
function startAntiAFKMode(b) {
  log('[Anti-AFK Mode] Active movement, jumping, sneaking');
  const actions = ['forward', 'back', 'left', 'right'];

  const i1 = setInterval(() => {
    if (!b || !b.entity) return;
    try {
      const action = actions[Math.floor(Math.random() * actions.length)];
      b.clearControlStates();
      b.look(Math.random() * Math.PI * 2 - Math.PI, (Math.random() - 0.5) * 0.4, false);
      b.setControlState(action, true);
      setTimeout(() => { try { b.setControlState(action, false); } catch (_) {} }, 900 + Math.random() * 700);
      b.activateItem();
    } catch (_) {}
  }, 3500 + Math.random() * 3000);

  const i2 = setInterval(() => {
    if (!b || !b.entity) return;
    try {
      b.setControlState('jump', true);
      setTimeout(() => { try { b.setControlState('jump', false); } catch (_) {} }, 300);
    } catch (_) {}
  }, 10000 + Math.random() * 5000);

  const i3 = setInterval(() => {
    if (!b || !b.entity) return;
    try {
      b.setControlState('sneak', true);
      setTimeout(() => { try { b.setControlState('sneak', false); } catch (_) {} }, 700);
    } catch (_) {}
  }, 18000);

  intervals.push(i1, i2, i3);
}

// ── Full Active Mode ──────────────────────────────────────────────────────────
function startFullActiveMode(b) {
  startAntiAFKMode(b);
  log('[Full Active Mode] Max activity + chat + mob combat');

  const chatMessages = ['.', 'gg', 'hi', 'hello', ':)', 'playing!', 'active!'];
  const i4 = setInterval(() => {
    if (!b || !b.entity) return;
    const msg = chatMessages[Math.floor(Math.random() * chatMessages.length)];
    try { b.chat(msg); log(`[Chat] ${msg}`); } catch (_) {}
  }, 6 * 60 * 1000);

  const i5 = setInterval(() => {
    if (!b || !b.entity) return;
    try {
      const mob = b.nearestEntity(e =>
        e.type === 'mob' && b.entity.position.distanceTo(e.position) < 4
      );
      if (mob) b.attack(mob);
    } catch (_) {}
  }, 1000);

  const i6 = setInterval(() => {
    if (!b || !b.entity) return;
    try { b.activateItem(); } catch (_) {}
  }, 5000);

  intervals.push(i4, i5, i6);
}

// ── Apply mode ────────────────────────────────────────────────────────────────
function applyMode(b) {
  clearIntervals();
  if (currentMode === 'afk') startAFKMode(b);
  else if (currentMode === 'full-active') startFullActiveMode(b);
  else startAntiAFKMode(b);
}

// ── Create bot ────────────────────────────────────────────────────────────────
function createBot() {
  userStopped = false;
  reconnecting = false;
  log(`Connecting to ${host}:${port} as ${username}...`);

  bot = mineflayer.createBot({ host, port, username, version: false });
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvpPlugin);

  setupAuthMe(bot);

  bot.on('login', () => {
    botRunning = true;
    startTime = Date.now();
    log('Logged in successfully!');
  });

  bot.on('spawn', () => {
    log('Spawned in world!');
    try {
      const mcData = require('minecraft-data')(bot.version);
      bot.pathfinder.setMovements(new Movements(bot, mcData));
    } catch (_) {}
    applyMode(bot);
  });

  // Fight back when attacked
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    let closest = null, closestDist = Infinity;
    for (const e of Object.values(bot.entities)) {
      if (e.type === 'player' && e.username !== bot.username) {
        const d = bot.entity.position.distanceTo(e.position);
        if (d < closestDist) { closestDist = d; closest = e; }
      }
    }
    if (closest) {
      log(`Attacked by ${closest.username}! Fighting back.`);
      try { bot.pvp.attack(closest); } catch (_) {}
    }
  });

  bot.on('kicked', (reason) => {
    const r = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
    log(`Kicked: ${r}`);
    cleanup();
    if (!userStopped) {
      const delay = (r.includes('throttled') || r.includes('already playing')) ? 90000 : 60000;
      scheduleReconnect(delay);
    }
  });

  bot.on('error', (err) => {
    log(`Error: ${err.message}`);
    cleanup();
    if (!userStopped) scheduleReconnect(60000);
  });

  bot.on('end', () => {
    log('Disconnected.');
    cleanup();
    if (!userStopped) scheduleReconnect(60000);
  });
}

function cleanup() {
  botRunning = false;
  clearIntervals();
  try { if (bot) bot.clearControlStates(); } catch (_) {}
}

function scheduleReconnect(delay) {
  if (reconnecting) return;
  reconnecting = true;
  log(`Reconnecting in ${delay / 1000}s...`);
  setTimeout(createBot, delay);
}

function stopBot() {
  userStopped = true;
  reconnecting = false;
  botRunning = false;
  clearIntervals();
  startTime = null;
  if (bot) {
    try { bot.quit('Stopped by user'); } catch (_) {}
    bot = null;
  }
  log('Bot stopped by user.');
}

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ ...getStatus(), logs: consoleHistory.slice(-80) });
});

app.post('/api/start', (req, res) => {
  if (botRunning) return res.json({ success: false, message: 'Already running' });
  if (reconnecting && !userStopped) return res.json({ success: false, message: 'Reconnecting...' });
  createBot();
  res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
  stopBot();
  res.json({ success: true });
});

app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (!['afk', 'anti-afk', 'full-active'].includes(mode)) {
    return res.json({ success: false, message: 'Invalid mode' });
  }
  currentMode = mode;
  const s = loadSettings();
  s.mode = mode;
  fs.writeFileSync('settings.json', JSON.stringify(s, null, 2));
  if (bot && bot.entity) applyMode(bot);
  log(`Mode changed to: ${mode}`);
  res.json({ success: true, mode });
});

app.get('/api/settings', (req, res) => {
  const s = loadSettings();
  res.json({ name: s.name, password: s.password || '', mode: s.mode || 'anti-afk' });
});

app.post('/api/settings', (req, res) => {
  const { name, password } = req.body;
  if (!name || name.trim() === '') return res.json({ success: false, message: 'Name cannot be empty' });
  const s = loadSettings();
  s.name = name.trim();
  if (password !== undefined) s.password = password;
  fs.writeFileSync('settings.json', JSON.stringify(s, null, 2));
  username = s.name;
  password = s.password || '';
  log(`Settings saved — name: ${s.name}`);
  res.json({ success: true });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  consoleHistory.slice(-100).forEach(line => socket.emit('console', line));
  socket.emit('status', getStatus());
});

// ── Error handling ────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => log(`Uncaught: ${err.message}`));
process.on('unhandledRejection', (reason) => log(`Unhandled: ${reason}`));

// ── Start ─────────────────────────────────────────────────────────────────────
const EXPRESS_PORT = process.env.PORT || 3000;
server.listen(EXPRESS_PORT, () => log(`Dashboard running on port ${EXPRESS_PORT}`));
createBot();
