#!/usr/bin/env node
/* ============================================================
   SplitFace — Pro license key generator
   Usage:  node tools/gen-key.mjs [count]
   Prints [count] keys (default 1). Send one key per buyer —
   the buyer pastes it into the "Have a license key?" box in the
   app to unlock watermark-free HD + 4K exports.

   The checksum algorithm MUST match keyChecksum() in app/app.js.
   ============================================================ */
import crypto from 'node:crypto';

const KEY_SALT = 'splitface-pro-v1';
const KEY_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function keyChecksum(body) {
  let h = 0;
  const s = body + KEY_SALT;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  let code = '', x = h;
  for (let i = 0; i < 4; i++) { code += KEY_ALPHA[x % KEY_ALPHA.length]; x = Math.floor(x / KEY_ALPHA.length); }
  return code;
}

const count = Math.max(1, parseInt(process.argv[2] || '1', 10));
for (let n = 0; n < count; n++) {
  let body = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) body += KEY_ALPHA[bytes[i] % KEY_ALPHA.length];
  const raw = body + keyChecksum(body);
  console.log(`SF-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
}
