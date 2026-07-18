// server/totp.js — TOTP gate for /settings
const { authenticator } = require('otplib');
const crypto = require('crypto');

// ตั้งค่าใน env: TOTP_SECRET (base32). ถ้าไม่ตั้ง จะใช้ค่า default ด้านล่าง — ควรเปลี่ยนก่อนใช้จริง
const SECRET = process.env.TOTP_SECRET || 'KJZGC5DUNRSSAYJSGAZDMQ2PMRSQ';
authenticator.options = { window: 1 };

const tokens = new Set(); // session tokens (หายเมื่อ server restart)

function verifyCode(code) {
  try { return authenticator.check(String(code || '').trim(), SECRET); }
  catch { return false; }
}

function issueToken() {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.add(t);
  return t;
}

function checkToken(t) { return tokens.has(t); }

module.exports = { verifyCode, issueToken, checkToken, SECRET };
