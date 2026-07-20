// server/game.js — Boss Raid mode: ทุกคนรุมบอสกลางจอ (authoritative on server)
const settingsMod = require('./settings');
const { ITEM_DEFS } = require('./settings');

const W = 1000, H = 1600;
const FIELD = { x1: 70, x2: 930, y1: 950, y2: 1470 }; // พื้นที่เดินของฮีโร่ (ใต้บอส)
const BOSS_POS = { x: 500, y: 780 };                   // บอสยืนกลางค่อนบน
const TICK_MS = 100;

let io = null;
let players = new Map();
let nextIdx = 0;
let gameActive = true; // เกมเปิดตลอด
let boss = null;
let stage = 1;
let loopTimer = null;

function now() { return Date.now(); }
function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }

// ---------- เลเวล/ค่าพลังฮีโร่ ----------
function expNeed(level) { return 150 + (level - 1) * 120; }       // exp ที่ต้องใช้ไปเลเวลถัดไป
function perLikeDmg(level) { return 1 + Math.floor(level / 2); }  // ดาเมจต่อ 1 ไลค์
function hitChance(level) { return Math.min(0.95, 0.55 + level * 0.04); } // โอกาสโจมตีโดน
function walkSpeed(level) { return Math.min(2.2, 1 + level * 0.04); }     // ตัวคูณความเร็วเดิน/หลบ

// ---------- บอส ----------
const BOSS_PREFIX = ['อสูร', 'ราชัน', 'จอมมาร', 'ปีศาจ', 'มังกร', 'ยักษ์', 'เจ้าแม่', 'ภูตพราย', 'อสรพิษ', 'เทพสงคราม'];
const BOSS_SUFFIX = ['เพลิงนรก', 'เงามืด', 'สายฟ้า', 'น้ำแข็งดำ', 'พายุคลั่ง', 'โลหิต', 'หมื่นปี', 'ดวงดาวดับ', 'เหวลึก', 'ทมิฬ'];

function spawnBoss() {
  const s = settingsMod.get();
  const maxHp = Math.round(s.bossBaseHP * Math.pow(s.bossHpMult, stage - 1));
  const bgs = ((s.assets && s.assets.backgrounds) || []).filter(Boolean);
  const bg = bgs.length ? bgs[randInt(0, bgs.length - 1)] : ((s.assets && s.assets.background) || null);
  boss = {
    bg,
    name: BOSS_PREFIX[randInt(0, BOSS_PREFIX.length - 1)] + BOSS_SUFFIX[randInt(0, BOSS_SUFFIX.length - 1)],
    level: stage,
    hp: maxHp, maxHp,
    mp: 50, maxMp: 100,
    dmg: Math.round(s.bossBaseDmg * (1 + 0.25 * (stage - 1))),
    cooldown: [s.bossCooldownMin, s.bossCooldownMax],
    nextAttackAt: now() + 5000,
    stunnedUntil: 0,
    alive: true,
    x: BOSS_POS.x, y: BOSS_POS.y
  };
  io.to('arena').emit('bossSpawn', pubBoss());
  io.to('arena').emit('mc', { key: 'bossSpawn', params: { name: boss.name, level: boss.level }, priority: true });
  pushHostState();
}

function pubBoss() {
  return boss && {
    name: boss.name, level: boss.level, seed: boss.name + '-' + boss.level, bg: boss.bg,
    hp: Math.max(0, boss.hp), maxHp: boss.maxHp,
    mp: Math.round(boss.mp), maxMp: boss.maxMp, alive: boss.alive,
    x: boss.x, y: boss.y, stunned: boss.stunnedUntil > now()
  };
}

function damageBoss(dmg, byName) {
  if (!boss || !boss.alive || dmg <= 0) return;
  boss.hp -= dmg;
  if (boss.hp <= 0) defeatBoss();
}

function defeatBoss() {
  boss.alive = false;
  boss.hp = 0;
  const s = settingsMod.get();
  const defeated = { name: boss.name, level: boss.level };
  // รางวัล: exp ทุกคนที่ยังรอด + ฮีลครึ่งหนึ่ง
  for (const p of players.values()) {
    if (p.alive) {
      addExp(p, 60 * boss.level);
      p.hp = Math.min(s.startHP, p.hp + Math.ceil(s.startHP / 2));
    }
  }
  io.to('arena').emit('bossDefeated', defeated); // arena โชว์ค้าง 5 วิ
  io.to('arena').emit('mc', { key: 'bossDefeated', params: defeated, priority: true });
  stage++;
  setTimeout(() => { if (gameActive) spawnBoss(); }, 5500);
  pushHostState();
}

// ---------- ผู้เล่น ----------
function ensurePlayer(uniqueId, nickname) {
  let p = players.get(uniqueId);
  if (!p) {
    p = {
      id: uniqueId, name: nickname || uniqueId,
      spawned: false, alive: false,
      hp: 0, exp: 0, level: 1,
      likeTotal: 0, respawnTarget: 0,
      lastLikeAt: now(),
      spriteIndex: 0,
      x: rand(FIELD.x1, FIELD.x2), y: rand(FIELD.y1, FIELD.y2),
      tx: 0, ty: 0, moving: false, facing: 1,
      nextWanderAt: 0,
      shields: 0, reflectUntil: 0
    };
    players.set(uniqueId, p);
  }
  if (nickname && p.name !== nickname) p.name = nickname;
  return p;
}

function pub(p) {
  return {
    id: p.id, name: p.name, sprite: p.spriteIndex,
    x: Math.round(p.x), y: Math.round(p.y), facing: p.facing,
    hp: p.hp, maxHp: settingsMod.get().startHP,
    level: p.level, exp: p.exp, expNeed: expNeed(p.level),
    shields: p.shields, reflecting: p.reflectUntil > now()
  };
}

function spawn(p) {
  const s = settingsMod.get();
  p.spawned = true; p.alive = true;
  p.hp = s.startHP;
  p.spriteIndex = nextIdx % 20; nextIdx++;
  p.lastLikeAt = now();
  p.x = rand(FIELD.x1 + 80, FIELD.x2 - 80);
  p.y = rand(FIELD.y1 + 40, FIELD.y2 - 40);
  io.to('arena').emit('spawn', pub(p));
  io.to('arena').emit('mc', { key: 'welcome', params: { name: p.name }, priority: true });
  pushHostState();
}

function respawn(p) {
  const s = settingsMod.get();
  p.alive = true;
  p.hp = s.startHP;
  p.shields = 0; p.reflectUntil = 0;
  p.lastLikeAt = now();
  p.x = rand(FIELD.x1 + 80, FIELD.x2 - 80);
  p.y = rand(FIELD.y1 + 40, FIELD.y2 - 40);
  io.to('arena').emit('spawn', pub(p));
  io.to('arena').emit('mc', { key: 'welcome', params: { name: p.name }, priority: true });
  pushHostState();
}

function addExp(p, amount) {
  p.exp += amount;
  let leveled = false;
  while (p.exp >= expNeed(p.level)) {
    p.exp -= expNeed(p.level);
    p.level++;
    leveled = true;
  }
  if (leveled) {
    io.to('arena').emit('levelUp', { id: p.id, level: p.level });
    io.to('arena').emit('mc', { key: 'levelUp', params: { name: p.name, level: p.level }, priority: true });
  }
}

function damageHero(p, dmg) {
  if (!p.alive) return null;
  if (p.shields > 0) {
    p.shields--;
    io.to('arena').emit('blocked', { id: p.id });
    return { id: p.id, dmg: 0, blocked: true };
  }
  if (p.reflectUntil > now() && boss && boss.alive) {
    io.to('arena').emit('reflected', { from: p.id, to: 'boss' });
    damageBoss(dmg, p.name);
    return { id: p.id, dmg: 0, reflected: true };
  }
  p.hp -= dmg;
  if (p.hp <= 0) death(p, 'hp');
  return { id: p.id, dmg, hp: Math.max(0, p.hp) };
}

function death(p, cause) {
  p.alive = false;
  p.hp = 0;
  p.respawnTarget = p.likeTotal + settingsMod.get().likesToSpawn;
  io.to('arena').emit('death', { id: p.id, cause });
  io.to('arena').emit('mc', {
    key: cause === 'inactive' ? 'inactiveDeath' : 'koByBoss',
    params: { name: p.name, boss: boss ? boss.name : '' }, priority: true
  });
  pushHostState();
}

function aliveList() { return [...players.values()].filter(p => p.alive); }

// ---------- กาชา ----------
function weightedPick(weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
  return entries[0][0];
}

function doGacha(p, tier) {
  const s = settingsMod.get();
  const itemKey = weightedPick(s.drops[tier]);
  const item = ITEM_DEFS[itemKey];
  io.to('arena').emit('gacha', { id: p.id, name: p.name, tier, item: itemKey });
  io.to('arena').emit('mc', { key: 'gachaItem', params: { name: p.name, item: itemKey, tier }, priority: true });
  setTimeout(() => applyItem(p, itemKey, item, tier), 2600);
}

function applyItem(p, itemKey, item, tier) {
  const s = settingsMod.get();
  switch (item.kind) {
    case 'shield': if (p.alive) p.shields += item.n; break;
    case 'heal': if (p.alive) p.hp = Math.min(s.startHP, p.hp + item.amount); break;
    case 'reflect': if (p.alive) p.reflectUntil = now() + item.seconds * 1000; break;
    case 'revive':
      if (!p.alive && p.spawned) { respawn(p); io.to('arena').emit('mc', { key: 'revive', params: { name: p.name }, priority: true }); }
      else if (p.alive) p.hp = s.startHP;
      break;
    case 'special': {
      if (!p.alive || !boss || !boss.alive) break;
      const dmg = item.dmg * stage; // สเกลตามด่าน
      p.facing = 1;
      io.to('arena').emit('attack', { from: p.id, to: 'boss', type: 'special', tier, dmg });
      io.to('arena').emit('mc', { key: 'special', params: { name: p.name, boss: boss.name, tier }, priority: true });
      setTimeout(() => damageBoss(dmg, p.name), 900);
      break;
    }
    case 'meteor': {
      if (!p.alive || !boss || !boss.alive) break;
      const dmg = item.dmg * stage;
      io.to('arena').emit('attack', { from: p.id, to: 'boss', type: 'meteor', tier, dmg });
      io.to('arena').emit('mc', { key: 'meteor', params: { name: p.name, boss: boss.name }, priority: true });
      setTimeout(() => {
        damageBoss(dmg, p.name);
        if (boss && boss.alive) boss.stunnedUntil = now() + item.stunSec * 1000;
      }, 1100);
      break;
    }
  }
  pushHostState();
}

function giftTier(diamonds) {
  const s = settingsMod.get();
  if (diamonds >= s.legendaryMin) return 'legendary';
  if (diamonds >= s.epicMin) return 'epic';
  if (diamonds >= s.rareMin) return 'rare';
  return 'common';
}

// ---------- TikTok events ----------
function onLike(uniqueId, nickname, count) {
  const s = settingsMod.get();
  const p = ensurePlayer(uniqueId, nickname);
  p.likeTotal += count;
  p.lastLikeAt = now();
  io.to('arena').emit('likeFeed', { name: p.name, count, kind: 'like' });

  if (!p.spawned && p.likeTotal >= s.likesToSpawn) { spawn(p); return; }
  if (p.spawned && !p.alive && p.respawnTarget && p.likeTotal >= p.respawnTarget) { respawn(p); return; }
  if (!p.alive || !p.spawned) return;

  // ไลค์ = โจมตีบอส: 1 ไลค์ = 1 ครั้ง มีโอกาสพลาดตามเลเวล
  if (boss && boss.alive) {
    const chance = hitChance(p.level);
    let hits = 0;
    for (let i = 0; i < count; i++) if (Math.random() < chance) hits++;
    const misses = count - hits;
    const dmg = hits * perLikeDmg(p.level);
    io.to('arena').emit('heroAttack', { from: p.id, dmg, hits, misses });
    damageBoss(dmg, p.name);
  }
  addExp(p, count); // exp จากการโจมตี (1 ไลค์ = 1 exp)

}

function onGift(uniqueId, nickname, diamonds) {
  const p = ensurePlayer(uniqueId, nickname);
  p.lastLikeAt = now();
  io.to('arena').emit('likeFeed', { name: p.name, count: diamonds, kind: 'gift' });
  if (!p.spawned) spawn(p);
  addExp(p, Math.min(150, diamonds)); // ของขวัญให้ exp ด้วย (จำกัดเพดานกันเลเวลพุ่ง)
  doGacha(p, giftTier(diamonds));
}

// ---------- บอสโจมตี (โซนเตือน → ฟาด, หลบได้ด้วยตำแหน่ง) ----------
const ZONE_RX = 165, ZONE_RY = 75, WARN_MS = 1300, PULSES = 3, PULSE_GAP = 450; // วงรีแนวนอน (มุมมอง 3 มิติ)

function bossTryAttack() {
  const s = settingsMod.get();
  const t = now();
  if (!boss || !boss.alive || boss.stunnedUntil > t || t < boss.nextAttackAt || boss.mp < 30) return;
  const targets = aliveList();
  if (!targets.length) return;
  const target = targets[randInt(0, targets.length - 1)];
  boss.mp -= 30;
  boss.nextAttackAt = t + randInt(boss.cooldown[0] * 1000, boss.cooldown[1] * 1000);
  const zone = { x: target.x, y: target.y, rx: ZONE_RX, ry: ZONE_RY };
  io.to('arena').emit('bossTelegraph', { ...zone, warnMs: WARN_MS, targetId: target.id });

  for (let i = 0; i < PULSES; i++) {
    setTimeout(() => {
      if (!boss || !boss.alive) return;
      const victims = [];
      for (const p of aliveList()) {
        const nx = (p.x - zone.x) / zone.rx, ny = (p.y - zone.y) / zone.ry;
        if (nx * nx + ny * ny <= 1) { // อยู่ในวงรี
          const r = damageHero(p, boss.dmg);
          if (r) victims.push(r);
        }
      }
      io.to('arena').emit('bossStrike', { x: zone.x, y: zone.y, rx: zone.rx, ry: zone.ry, victims });
    }, WARN_MS + i * PULSE_GAP);
  }
}

// ---------- host controls ----------
function hostStart() { gameActive = true; if (!boss || !boss.alive) spawnBoss(); io.to('arena').emit('gameState', { active: true }); pushHostState(); }
function hostEnd() { gameActive = false; io.to('arena').emit('gameState', { active: false }); pushHostState(); }
function hostNewRound() {
  players.clear(); nextIdx = 0; stage = 1; gameActive = true;
  io.to('arena').emit('reset');
  spawnBoss();
  pushHostState();
}
function hostKick(id) {
  const p = players.get(id);
  if (p && p.alive) death(p, 'hp');
  players.delete(id);
  io.to('arena').emit('remove', { id });
  pushHostState();
}

// ---------- game loop ----------
function tick() {
  const s = settingsMod.get();
  const t = now();

  if (gameActive && boss && boss.alive) {
    boss.mp = Math.min(boss.maxMp, boss.mp + 0.25); // ฟื้น MP ~2.5/วินาที
    bossTryAttack();
  }

  for (const p of players.values()) {
    if (!p.alive) continue;

    if (gameActive && t - p.lastLikeAt > s.inactivitySeconds * 1000) { death(p, 'inactive'); continue; }

    // เดินสุ่ม — เลเวลสูงเดินไว (หลบไวขึ้นเองตามธรรมชาติ)
    if (t >= p.nextWanderAt) {
      if (Math.random() < 0.78) {
        p.tx = rand(FIELD.x1, FIELD.x2);
        p.ty = rand(FIELD.y1, FIELD.y2);
        p.moving = true;
      } else p.moving = false;
      p.nextWanderAt = t + randInt(1200, 4000);
    }
    if (p.moving) {
      const dx = p.tx - p.x, dy = p.ty - p.y;
      const d = Math.hypot(dx, dy);
      const speed = 1.6 * walkSpeed(p.level) * (TICK_MS / 16.7) * 1.6;
      if (d < speed * 2) p.moving = false;
      else {
        p.x += (dx / d) * speed;
        p.y += (dy / d) * speed;
        p.facing = dx >= 0 ? 1 : -1;
      }
    }
  }

  const snapshot = {
    players: [...players.values()].filter(p => p.spawned && p.alive).map(pub),
    boss: pubBoss()
  };
  io.to('arena').emit('state', snapshot);
}

function pushHostState() {
  io.to('host').emit('hostState', {
    gameActive, stage,
    boss: pubBoss(),
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, spawned: p.spawned, alive: p.alive,
      hp: p.hp, level: p.level, likeTotal: p.likeTotal, sprite: p.spriteIndex
    })),
    likesToSpawn: settingsMod.get().likesToSpawn
  });
}

function fullState() {
  return {
    gameActive,
    players: [...players.values()].filter(p => p.spawned && p.alive).map(pub),
    boss: pubBoss()
  };
}

function init(ioInstance) {
  io = ioInstance;
  if (!boss) spawnBoss();
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = setInterval(tick, TICK_MS);
}

module.exports = { init, onLike, onGift, hostStart, hostEnd, hostNewRound, hostKick, fullState, pushHostState };
