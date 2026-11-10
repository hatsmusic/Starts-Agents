// TOTP (RFC 6238) over HOTP (RFC 4226), HMAC-SHA1 — the second
// factor for vault site-login entries (v0.15.5, item 97). The seed
// is stored inside the entry's encrypted secret blob and never
// leaves the server: the CDP fill computes the current code here
// and types it straight into the page, so the model never sees the
// seed or the code.
//
// Only node:crypto is needed: a ~20-line base32 decoder (RFC 4648),
// an 8-byte big-endian counter (BigInt — the 2^53-safe way to write
// it), HMAC-SHA1, and the standard dynamic truncation. Correctness
// is pinned by the RFC 6238 Appendix B vectors in
// test/v0155-be2.test.mjs.
import crypto from 'node:crypto';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/* RFC 4648 base32 decode: case-insensitive, ignores spaces and
 * dashes (the shapes authenticator apps print seeds in), tolerates
 * missing '=' padding. Throws on any character outside the
 * alphabet — callers validate user-entered seeds with this. */
export function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[\s=-]+/g, '');
  if (!clean) throw new Error('base32 seed is empty');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`base32 seed contains an invalid character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* HOTP: counter as 8-byte big-endian, HMAC-SHA1, dynamic
 * truncation (RFC 4226 §5.3), zero-padded to `digits`. */
export function hotp(secretBytes, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secretBytes).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

/* TOTP for a moment in time. `atMs` is milliseconds since the Unix
 * epoch (the RFC vectors are quoted in seconds — tests multiply). */
export function totp(secretBase32, { atMs = Date.now(), digits = 6, stepS = 30 } = {}) {
  const seed = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1000 / stepS);
  return hotp(seed, counter, digits);
}

/* The current window plus its neighbours, current first: a fill
 * that raced a window boundary (or a slightly skewed server clock)
 * gets honest retries without ever widening the window further. */
export function totpCandidates(secretBase32, { atMs = Date.now(), digits = 6, stepS = 30 } = {}) {
  const seed = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1000 / stepS);
  const codes = [];
  for (const c of [counter, counter - 1, counter + 1]) {
    const code = hotp(seed, c, digits);
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/* Verification-side helper (kept for completeness / future local
 * checks): does `code` match any of the ±1 window candidates? */
export function totpVerify(secretBase32, code, opts = {}) {
  const want = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6,8}$/.test(want)) return false;
  return totpCandidates(secretBase32, { ...opts, digits: want.length }).includes(want);
}
