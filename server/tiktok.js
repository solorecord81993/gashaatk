// server/tiktok.js — TikTok Live connection wrapper (unofficial tiktok-live-connector)
const { WebcastPushConnection } = require('tiktok-live-connector');
const game = require('./game');

let io = null;
let conn = null;
let currentUser = null;
let status = { connected: false, username: null, message: 'idle' };
let reconnectTimer = null;
let wantConnected = false;

function setStatus(patch) {
  status = { ...status, ...patch };
  if (io) io.to('host').emit('connectionStatus', status);
}

async function connect(username) {
  username = String(username || '').trim().replace(/^@/, '');
  if (!username) return { ok: false, error: 'empty username' };
  await disconnect();
  currentUser = username;
  wantConnected = true;
  return tryConnect();
}

async function tryConnect() {
  setStatus({ username: currentUser, message: 'connecting' });
  conn = new WebcastPushConnection(currentUser, {
    enableExtendedGiftInfo: false,
    requestPollingIntervalMs: 2000
  });

  conn.on('like', (d) => {
    try {
      const id = d.uniqueId || d.userId;
      if (!id) return;
      game.onLike(String(id), d.nickname || d.uniqueId, Number(d.likeCount || 1));
    } catch (e) { console.error('[tiktok] like handler:', e.message); }
  });

  conn.on('gift', (d) => {
    try {
      const id = d.uniqueId || d.userId;
      if (!id) return;
      // gift แบบ streak/combo (giftType === 1): นับเมื่อจบ combo เท่านั้น
      if (d.giftType === 1 && !d.repeatEnd) return;
      const per = Number(d.diamondCount || 0);
      const repeat = Number(d.repeatCount || 1);
      const total = d.giftType === 1 ? per * repeat : per;
      if (total <= 0) return;
      game.onGift(String(id), d.nickname || d.uniqueId, total);
    } catch (e) { console.error('[tiktok] gift handler:', e.message); }
  });

  conn.on('disconnected', () => {
    setStatus({ connected: false, message: 'disconnected' });
    scheduleReconnect();
  });

  conn.on('streamEnd', () => {
    wantConnected = false;
    setStatus({ connected: false, message: 'streamEnd' });
  });

  conn.on('error', (err) => {
    console.warn('[tiktok] error:', err && err.message ? err.message : err);
  });

  try {
    const state = await conn.connect();
    setStatus({ connected: true, message: 'connected', roomId: state.roomId });
    return { ok: true };
  } catch (e) {
    setStatus({ connected: false, message: 'failed: ' + (e.message || e) });
    scheduleReconnect();
    return { ok: false, error: String(e.message || e) };
  }
}

function scheduleReconnect() {
  if (!wantConnected || reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (wantConnected) await tryConnect();
  }, 5000);
}

async function disconnect() {
  wantConnected = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (conn) {
    try { conn.disconnect(); } catch { /* ignore */ }
    conn = null;
  }
  setStatus({ connected: false, message: 'idle' });
}

function getStatus() { return status; }
function init(ioInstance) { io = ioInstance; }

module.exports = { init, connect, disconnect, getStatus };
