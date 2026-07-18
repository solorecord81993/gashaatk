// server/index.js — Express + Socket.IO + Edge TTS + settings/upload APIs
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const settingsMod = require('./settings');
const totp = require('./totp');
const game = require('./game');
const tiktok = require('./tiktok');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const page = (f) => (req, res) => res.sendFile(path.join(__dirname, '..', 'public', f));
app.get('/', page('arena.html'));
app.get('/arena', page('arena.html'));
app.get('/host', page('host.html'));
app.get('/settings', page('settings.html'));

// ---------- TOTP auth ----------
app.post('/api/totp', (req, res) => {
  if (totp.verifyCode(req.body && req.body.code)) {
    return res.json({ ok: true, token: totp.issueToken() });
  }
  res.status(401).json({ ok: false });
});

function requireAuth(req, res, next) {
  const t = req.headers['x-auth-token'];
  if (t && totp.checkToken(t)) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
}

// ---------- settings ----------
app.get('/api/config', (req, res) => {
  // อ่านอย่างเดียว — arena/host ใช้
  res.json(settingsMod.get());
});

app.post('/api/settings', requireAuth, async (req, res) => {
  const saved = await settingsMod.save(req.body || {});
  io.emit('configChanged', saved);
  res.json({ ok: true, settings: saved });
});

// ---------- uploads (Supabase Storage หรือ memory fallback) ----------
const memFiles = new Map(); // id -> {buf, mime}
const BUCKET = 'battle-assets';
let bucketReady = false;

async function ensureBucket(sb) {
  if (bucketReady) return;
  try { await sb.storage.createBucket(BUCKET, { public: true }); } catch { /* exists */ }
  bucketReady = true;
}

app.post('/api/upload', requireAuth, async (req, res) => {
  try {
    const { dataUrl, name } = req.body || {};
    if (!dataUrl || !dataUrl.startsWith('data:')) return res.status(400).json({ ok: false, error: 'bad data' });
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ ok: false, error: 'bad data url' });
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'file too large (max 8MB)' });

    const ext = (name && name.includes('.')) ? name.split('.').pop().replace(/[^a-z0-9]/gi, '') : 'bin';
    const fname = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;

    const sb = settingsMod.getSupabase();
    if (sb) {
      await ensureBucket(sb);
      let { error } = await sb.storage.from(BUCKET).upload(fname, buf, { contentType: mime, upsert: true });
      if (error && /bucket/i.test(error.message || '')) {
        // bucket ยังไม่มี → สร้างแล้วลองใหม่
        try { await sb.storage.createBucket(BUCKET, { public: true }); } catch { /* ignore */ }
        ({ error } = await sb.storage.from(BUCKET).upload(fname, buf, { contentType: mime, upsert: true }));
      }
      if (!error) {
        const { data } = sb.storage.from(BUCKET).getPublicUrl(fname);
        return res.json({ ok: true, url: data.publicUrl, persistent: true });
      }
      console.warn('[upload] supabase upload failed:', error.message);
      var sbError = error.message;
    }
    // fallback: memory (หายเมื่อ restart)
    const id = crypto.randomBytes(8).toString('hex');
    memFiles.set(id, { buf, mime });
    res.json({ ok: true, url: `/uploads/${id}`, persistent: false, sbError: sbError || 'no supabase env' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/uploads/:id', (req, res) => {
  const f = memFiles.get(req.params.id);
  if (!f) return res.status(404).end();
  res.setHeader('Content-Type', f.mime);
  res.send(f.buf);
});

// ---------- Microsoft Edge TTS ----------
const VOICES = {
  th: 'th-TH-NiwatNeural',
  en: 'en-US-GuyNeural',
  ja: 'ja-JP-KeitaNeural'
};
const ttsCache = new Map(); // key -> Buffer (LRU-ish)
const TTS_CACHE_MAX = 200;

app.get('/api/tts', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 300);
  const lang = ['th', 'en', 'ja'].includes(req.query.lang) ? req.query.lang : 'th';
  if (!text.trim()) return res.status(400).end();
  const key = lang + '|' + text;

  if (ttsCache.has(key)) {
    const buf = ttsCache.get(key);
    ttsCache.delete(key); ttsCache.set(key, buf); // touch
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.send(buf);
  }

  try {
    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
    const tts = new MsEdgeTTS();
    await tts.setMetadata(VOICES[lang], OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const result = await tts.toStream(text);
    const stream = result && result.audioStream ? result.audioStream : result;
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const buf = Buffer.concat(chunks);
      ttsCache.set(key, buf);
      while (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(buf);
    });
    stream.on('error', (e) => { console.warn('[tts] stream error:', e.message); res.status(502).end(); });
  } catch (e) {
    console.warn('[tts] failed:', e.message);
    res.status(502).end(); // client จะ fallback ไป Web Speech API เอง
  }
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  socket.on('joinArena', () => {
    socket.join('arena');
    socket.emit('init', { ...game.fullState(), config: settingsMod.get() });
  });

  socket.on('joinHost', () => {
    socket.join('host');
    socket.emit('connectionStatus', tiktok.getStatus());
    game.pushHostState();
  });

  socket.on('hostConnect', async (username, cb) => {
    const r = await tiktok.connect(username);
    if (cb) cb(r);
  });
  socket.on('hostDisconnect', async () => { await tiktok.disconnect(); });
  socket.on('hostStart', () => game.hostStart());
  socket.on('hostEnd', () => game.hostEnd());
  socket.on('hostNewRound', () => game.hostNewRound());
  socket.on('hostKick', (id) => game.hostKick(id));

  // โหมดทดสอบ (จากหน้า host) — จำลองไลค์/ของขวัญโดยไม่ต้องไลฟ์จริง
  socket.on('simLike', ({ user, count }) => game.onLike('sim_' + user, user, Number(count) || 1));
  socket.on('simGift', ({ user, diamonds }) => game.onGift('sim_' + user, user, Number(diamonds) || 1));
});

// ---------- start ----------
(async () => {
  await settingsMod.init();
  game.init(io);
  tiktok.init(io);
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log('TikTok Battle Arena running on :' + PORT));
})();
