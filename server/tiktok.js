// server/tiktok.js — TikTok Live wrapper (tiktok-live-connector v2.x)
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');
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

// ---- ดึง field แบบกันเหนียว (รองรับได้ทั้งโครงสร้าง v1 และ v2) ----
function getUniqueId(d) {
  const u = d.user || {};
  return u.uniqueId || u.uniqueID || u.displayId || u.display_id || u.username || d.uniqueId || u.idStr || (u.id != null ? String(u.id) : null) || null;
}
function getLikeCount(d) {
  return Number(d.likeCount ?? d.count ?? 1); // v1 ใช้ likeCount, v2 (proto ดิบ) ใช้ count
}
function getNickname(d) {
  return (d.user && d.user.nickname) || d.nickname || getUniqueId(d);
}
function getDiamonds(d) {
  const v = (d.giftDetails && d.giftDetails.diamondCount)
    ?? d.diamondCount
    ?? (d.gift && (d.gift.diamondCount || d.gift.diamond_count))
    ?? (d.extendedGiftInfo && d.extendedGiftInfo.diamond_count);
  return Number(v || 0);
}
function getGiftType(d) {
  return d.giftType ?? (d.giftDetails && d.giftDetails.giftType) ?? (d.gift && (d.gift.giftType || d.gift.gift_type || d.gift.type)) ?? 0;
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
  try {
    conn = new TikTokLiveConnection(currentUser, {});

    conn.on(WebcastEvent.LIKE, (d) => {
      try {
        const id = getUniqueId(d);
        if (!id) {
          console.log('[tiktok] like without user, keys:', Object.keys(d).join(','));
          io.to('host').emit('ttEvent', { kind: 'noid', info: 'like' });
          return;
        }
        const n = getLikeCount(d);
        io.to('host').emit('ttEvent', { kind: 'like', id, name: getNickname(d), count: n });
        game.onLike(String(id), getNickname(d), n);
      } catch (e) { console.error('[tiktok] like handler:', e.message); }
    });

    conn.on(WebcastEvent.GIFT, (d) => {
      try {
        const id = getUniqueId(d);
        if (!id) {
          console.log('[tiktok] gift without user, keys:', Object.keys(d).join(','));
          io.to('host').emit('ttEvent', { kind: 'noid', info: 'gift' });
          return;
        }
        const giftType = getGiftType(d);
        // gift แบบ streak/combo: นับเมื่อจบ combo เท่านั้น
        if (giftType === 1 && !d.repeatEnd) return;
        const per = getDiamonds(d);
        const repeat = Number(d.repeatCount || 1);
        const total = giftType === 1 ? per * repeat : per;
        if (total <= 0) return;
        io.to('host').emit('ttEvent', { kind: 'gift', id, name: getNickname(d), count: total });
        game.onGift(String(id), getNickname(d), total);
      } catch (e) { console.error('[tiktok] gift handler:', e.message); }
    });

    conn.on(ControlEvent.DISCONNECTED, () => {
      setStatus({ connected: false, message: 'disconnected' });
      scheduleReconnect();
    });

    conn.on(WebcastEvent.STREAM_END, () => {
      wantConnected = false;
      setStatus({ connected: false, message: 'streamEnd' });
    });

    conn.on(ControlEvent.ERROR, (err) => {
      console.warn('[tiktok] error:', err && err.message ? err.message : err);
    });

    const state = await conn.connect();
    const roomId = state && (state.roomId || state.room_id);
    setStatus({ connected: true, message: 'connected', roomId });
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    setStatus({ connected: false, message: 'failed: ' + msg });
    scheduleReconnect();
    return { ok: false, error: msg };
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
