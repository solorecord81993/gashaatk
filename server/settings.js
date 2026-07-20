// server/settings.js — game settings with Supabase persistence (falls back to memory)
const { createClient } = require('@supabase/supabase-js');

const DEFAULTS = {
  likesToSpawn: 50,        // ไลค์เพื่อเกิดตัวละคร
  likesPerGacha: 50,       // ไลค์ต่อกาชา 1 ครั้ง (หลังเกิด)
  inactivitySeconds: 60,   // ไม่กดไลค์เกินนี้ = ตาย
  startHP: 100,
  basicAttackCost: 10,
  basicAttackMin: 5,
  basicAttackMax: 10,
  // ช่วงเหรียญของขวัญ → ระดับกาชา
  rareMin: 1, epicMin: 100, legendaryMin: 1000,
  // บอส
  bossBaseHP: 500,        // HP บอสด่านแรก
  bossHpMult: 1.5,        // ตัวคูณ HP ต่อด่าน
  bossBaseDmg: 12,        // ดาเมจบอสด่านแรก (โตขึ้นตามด่าน)
  bossCooldownMin: 8,     // วินาที cooldown ต่ำสุดของท่าบอส
  bossCooldownMax: 15,
  // อัตราดรอป (น้ำหนักสุ่ม) ต่อระดับ
  drops: {
    common:    { shield1: 30, healSmall: 30, specLight: 40 },
    rare:      { shield3: 30, healBig: 30, specMid: 40 },
    epic:      { reflect: 40, specHeavy: 60 },
    legendary: { meteor: 35, revive: 25, ultimate: 40 }
  },
  // ไฟล์ asset ที่อัปโหลด (URL) — null = ใช้ default ในตัว
  assets: {
    background: null,               // (เก่า) ฉากเดี่ยว — ใช้เป็น fallback
    backgrounds: Array(20).fill(null), // สนามประลองสูงสุด 20 — สุ่มทุกด่านบอส
    boss: null,
    bgm: null,
    sfx: { basic: null, gacha: null, spec_common: null, spec_rare: null, spec_epic: null, spec_legendary: null },
    sprites: Array(20).fill(null)
  }
};

// special = โจมตีบอส (ดาเมจ x ด่าน), meteor = ดาเมจหนัก + สตันบอส
const ITEM_DEFS = {
  shield1:  { kind: 'shield', n: 1 },
  shield3:  { kind: 'shield', n: 3 },
  healSmall:{ kind: 'heal', amount: 10 },
  healBig:  { kind: 'heal', amount: 30 },
  specLight:{ kind: 'special', dmg: 30, tier: 'common' },
  specMid:  { kind: 'special', dmg: 60, tier: 'rare' },
  specHeavy:{ kind: 'special', dmg: 120, tier: 'epic' },
  reflect:  { kind: 'reflect', seconds: 10 },
  meteor:   { kind: 'meteor', dmg: 150, stunSec: 4, tier: 'legendary' },
  revive:   { kind: 'revive' },
  ultimate: { kind: 'special', dmg: 250, tier: 'legendary' }
};

let settings = JSON.parse(JSON.stringify(DEFAULTS));
let supabase = null;
let supabaseReady = false;

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base)) return Array.isArray(patch) ? patch : base;
  if (typeof base === 'object' && typeof patch === 'object') {
    const out = { ...base };
    for (const k of Object.keys(patch)) {
      out[k] = k in base ? deepMerge(base[k], patch[k]) : patch[k];
    }
    return out;
  }
  return patch;
}

async function init() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (url && key) {
    try {
      supabase = createClient(url, key);
      // ตาราง: create table if not exists app_settings (id int primary key, data jsonb)
      const { data, error } = await supabase.from('app_settings').select('data').eq('id', 1).maybeSingle();
      if (!error && data && data.data) settings = deepMerge(DEFAULTS, data.data);
      if (error) console.warn('[settings] Supabase read warning:', error.message);
      supabaseReady = !error;
    } catch (e) {
      console.warn('[settings] Supabase unavailable, using in-memory settings:', e.message);
    }
  } else {
    console.warn('[settings] SUPABASE_URL/SUPABASE_SERVICE_KEY not set — settings & uploads are in-memory only (lost on restart)');
  }
}

async function save(patch) {
  settings = deepMerge(settings, patch);
  if (supabase) {
    try {
      const { error } = await supabase.from('app_settings').upsert({ id: 1, data: settings });
      if (error) console.warn('[settings] Supabase save warning:', error.message);
    } catch (e) {
      console.warn('[settings] Supabase save failed:', e.message);
    }
  }
  return settings;
}

function get() { return settings; }
function hasSupabase() { return !!supabase; }
function getSupabase() { return supabase; }

module.exports = { init, get, save, DEFAULTS, ITEM_DEFS, hasSupabase, getSupabase };
