// server/game.js — core game state & loop (authoritative on server)
const settingsMod = require('./settings');
const { ITEM_DEFS } = require('./settings');

const W = 1000, H = 1600;                 // โลกเกม (แนวตั้ง 9:16)
const FIELD = { x1: 70, x2: 930, y1: 860, y2: 1470 }; // พื้นที่เดิน
const TICK_MS = 100;

let io = null;
let players = new Map();   // uniqueId -> player
let nextIdx = 0;           // ลำดับการเกิด (ใช้เลือก sprite วน 20)
let gameActive = false;
let roundOver = false;
let everSpawned = 0;
let loopTimer = null;

function now() { return Date.now(); }
function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }

function ensurePlayer(uniqueId, nickname) {
  let p = players.get(uniqueId);
  if (!p) {
    p = {
      id: uniqueId,
      name: nickname || uniqueId,
      spawned: false, alive: false,
      hp: 0, mp: 0,
      likeTotal: 0, nextGachaAt: Infinity,
      lastLikeAt: now(),
      spriteIndex: 0,
      x: rand(FIELD.x1, FIELD.x2), y: rand(FIELD.y1, FIELD.y2),
      tx: 0, ty: 0, moving: false, facing: 1,
      nextWanderAt: 0, nextAttackAt: 0,
      shields: 0, reflectUntil: 0
    };
    players.set(uniqueId, p);
  }
  if (nickname && p.name !== nickname) p.name = nickname;
  return p;
}

function spawn(p) {
  const s = settingsMod.get();
  p.spawned = true;
  p.alive = true;
  p.hp = s.startHP;
  p.spriteIndex = nextIdx % 20;
  nextIdx++;
  everSpawned++;
  p.lastLikeAt = now();
  p.nextGachaAt = p.likeTotal + s.likesPerGacha;
  p.x = rand(FIELD.x1 + 100, FIELD.x2 - 100);
  p.y = rand(FIELD.y1 + 50, FIELD.y2 - 50);
  p.nextAttackAt = now() + randInt(3000, 8000);
  io.to('arena').emit('spawn', pub(p));
  io.to('arena').emit('mc', { key: 'welcome', params: { name: p.name }, priority: true });
  pushHostState();
}

function aliveList(excludeId) {
  return [...players.values()].filter(p => p.alive && p.id !== excludeId);
}

function pub(p) {
  return {
    id: p.id, name: p.name, sprite: p.spriteIndex,
    x: Math.round(p.x), y: Math.round(p.y), facing: p.facing,
    hp: p.hp, maxHp: settingsMod.get().startHP, mp: p.mp,
    shields: p.shields, reflecting: p.reflectUntil > now()
  };
}

// ---------- damage & death ----------
function applyDamage(target, dmg, attacker, type) {
  if (!target.alive) return;
  if (target.shields > 0) {
    target.shields--;
    io.to('arena').emit('blocked', { id: target.id });
    return;
  }
  if (target.reflectUntil > now() && attacker && attacker.alive && type !== 'reflect') {
    io.to('arena').emit('reflected', { from: target.id, to: attacker.id });
    applyDamage(attacker, dmg, target, 'reflect');
    return;
  }
  target.hp -= dmg;
  io.to('arena').emit('hit', { id: target.id, dmg, hp: Math.max(0, target.hp) });
  if (target.hp <= 0) death(target, 'hp', attacker);
}

function death(p, cause, by) {
  p.alive = false;
  p.hp = 0;
  io.to('arena').emit('death', { id: p.id, cause });
  if (cause === 'inactive') {
    io.to('arena').emit('mc', { key: 'inactiveDeath', params: { name: p.name }, priority: true });
  } else {
    io.to('arena').emit('mc', { key: 'ko', params: { name: p.name, by: by ? by.name : '' }, priority: true });
  }
  pushHostState();
  checkWinner();
}

let lastStandingId = null;
function checkWinner() {
  if (!gameActive) return;
  const alive = aliveList();
  if (alive.length > 1) { lastStandingId = null; return; }
  // เหลือคนเดียว = ครองสนาม รอผู้ท้าชิงต่อ (ไม่มีหน้าจบเกม)
  if (everSpawned >= 2 && alive.length === 1 && lastStandingId !== alive[0].id) {
    lastStandingId = alive[0].id;
    io.to('arena').emit('mc', { key: 'lastStanding', params: { name: alive[0].name }, priority: true });
    pushHostState();
  }
}

// ---------- gacha ----------
function weightedPick(weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
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

  // ใช้ไอเทมอัตโนมัติ (หน่วงเล็กน้อยให้อนิเมชันไข่แตกก่อน)
  setTimeout(() => applyItem(p, itemKey, item, tier), 2600);
}

function applyItem(p, itemKey, item, tier) {
  const s = settingsMod.get();
  switch (item.kind) {
    case 'shield': if (p.alive) p.shields += item.n; break;
    case 'heal': if (p.alive) p.hp = Math.min(s.startHP, p.hp + item.amount); break;
    case 'reflect': if (p.alive) p.reflectUntil = now() + item.seconds * 1000; break;
    case 'revive':
      if (!p.alive && p.spawned) {
        p.alive = true; p.hp = Math.ceil(s.startHP / 2);
        p.lastLikeAt = now();
        p.x = rand(FIELD.x1 + 100, FIELD.x2 - 100); p.y = rand(FIELD.y1 + 50, FIELD.y2 - 50);
        roundOver = false;
        io.to('arena').emit('spawn', pub(p));
        io.to('arena').emit('mc', { key: 'revive', params: { name: p.name }, priority: true });
      } else if (p.alive) { p.hp = s.startHP; }
      break;
    case 'special': {
      if (!p.alive) break;
      const targets = aliveList(p.id);
      if (!targets.length) break;
      const t = targets[randInt(0, targets.length - 1)];
      p.facing = t.x > p.x ? 1 : -1;
      io.to('arena').emit('attack', { from: p.id, to: t.id, type: 'special', tier, dmg: item.dmg });
      io.to('arena').emit('mc', { key: 'special', params: { name: p.name, target: t.name, tier }, priority: true });
      setTimeout(() => applyDamage(t, item.dmg, p, 'special'), 900);
      break;
    }
    case 'aoe': {
      if (!p.alive) break;
      const targets = aliveList(p.id);
      if (!targets.length) break;
      io.to('arena').emit('attack', { from: p.id, to: null, type: 'aoe', tier, dmg: item.dmg });
      io.to('arena').emit('mc', { key: 'aoe', params: { name: p.name }, priority: true });
      setTimeout(() => targets.forEach(t => applyDamage(t, item.dmg, p, 'special')), 1100);
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

// ---------- TikTok event handlers ----------
function onLike(uniqueId, nickname, count) {
  const s = settingsMod.get();
  const p = ensurePlayer(uniqueId, nickname);
  p.likeTotal += count;
  p.mp += count;
  p.lastLikeAt = now();
  io.to('arena').emit('likeFeed', { name: p.name, count, kind: 'like' });

  if (!p.spawned && p.likeTotal >= s.likesToSpawn) {
    spawn(p);
    p.nextGachaAt = p.likeTotal + s.likesPerGacha;
    return;
  }
  if (p.spawned && p.alive) {
    while (p.likeTotal >= p.nextGachaAt) {
      p.nextGachaAt += s.likesPerGacha;
      doGacha(p, 'common');
    }
  }
}

function onGift(uniqueId, nickname, diamonds) {
  const p = ensurePlayer(uniqueId, nickname);
  p.lastLikeAt = now();
  io.to('arena').emit('likeFeed', { name: p.name, count: diamonds, kind: 'gift' });
  if (!p.spawned) {
    spawn(p);
    p.nextGachaAt = p.likeTotal + settingsMod.get().likesPerGacha;
  }
  doGacha(p, giftTier(diamonds));
}

// ---------- host controls ----------
function hostStart() { gameActive = true; roundOver = false; io.to('arena').emit('gameState', { active: true }); pushHostState(); }
function hostEnd() { gameActive = false; io.to('arena').emit('gameState', { active: false }); pushHostState(); }
function hostNewRound() {
  players.clear(); nextIdx = 0; everSpawned = 0; roundOver = false; gameActive = true;
  io.to('arena').emit('reset');
  io.to('arena').emit('gameState', { active: true });
  pushHostState();
}
function hostKick(id) {
  const p = players.get(id);
  if (p && p.alive) death(p, 'hp', null);
  players.delete(id);
  io.to('arena').emit('remove', { id });
  pushHostState();
}

// ---------- loop ----------
function tick() {
  const s = settingsMod.get();
  const t = now();
  const alive = aliveList();

  for (const p of players.values()) {
    if (!p.alive) continue;

    // ตายเพราะไม่ active (เฉพาะตอนเกมกำลังเล่นและยังไม่จบรอบ)
    if (gameActive && t - p.lastLikeAt > s.inactivitySeconds * 1000) {
      death(p, 'inactive', null);
      continue;
    }

    // เดินสุ่ม
    if (t >= p.nextWanderAt) {
      if (Math.random() < 0.75) {
        p.tx = rand(FIELD.x1, FIELD.x2);
        p.ty = rand(FIELD.y1, FIELD.y2);
        p.moving = true;
      } else {
        p.moving = false; // ยืนพัก
      }
      p.nextWanderAt = t + randInt(1500, 4500);
    }
    if (p.moving) {
      const dx = p.tx - p.x, dy = p.ty - p.y;
      const d = Math.hypot(dx, dy);
      const speed = 1.6; // px ต่อ tick (world units)
      if (d < speed * 2) { p.moving = false; }
      else {
        p.x += (dx / d) * speed * (TICK_MS / 16.7) * 1.6;
        p.y += (dy / d) * speed * (TICK_MS / 16.7) * 1.6;
        p.facing = dx >= 0 ? 1 : -1;
      }
    }

    // โจมตีธรรมดาอัตโนมัติ
    if (gameActive && t >= p.nextAttackAt) {
      p.nextAttackAt = t + randInt(3000, 8000);
      if (p.mp >= s.basicAttackCost) {
        const targets = alive.filter(o => o.id !== p.id);
        if (targets.length) {
          const target = targets[randInt(0, targets.length - 1)];
          p.mp -= s.basicAttackCost;
          p.facing = target.x > p.x ? 1 : -1;
          const dmg = randInt(s.basicAttackMin, s.basicAttackMax);
          io.to('arena').emit('attack', { from: p.id, to: target.id, type: 'basic', dmg });
          setTimeout(() => applyDamage(target, dmg, p, 'basic'), 500);
        }
      }
    }
  }

  // broadcast snapshot
  const snapshot = [...players.values()].filter(p => p.spawned && p.alive).map(pub);
  io.to('arena').emit('state', snapshot);
}

function pushHostState() {
  const s = settingsMod.get();
  io.to('host').emit('hostState', {
    gameActive, roundOver,
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, spawned: p.spawned, alive: p.alive,
      hp: p.hp, mp: p.mp, likeTotal: p.likeTotal, sprite: p.spriteIndex
    })),
    likesToSpawn: s.likesToSpawn
  });
}

function fullState() {
  return {
    gameActive, roundOver,
    players: [...players.values()].filter(p => p.spawned && p.alive).map(pub)
  };
}

function init(ioInstance) {
  io = ioInstance;
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = setInterval(tick, TICK_MS);
}

module.exports = { init, onLike, onGift, hostStart, hostEnd, hostNewRound, hostKick, fullState, pushHostState };
