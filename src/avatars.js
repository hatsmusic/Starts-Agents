import fs from 'node:fs';
import path from 'node:path';

// Avatars (v0.14.2, feedback item 44): one mechanism for bot and
// account avatars. An avatar is { kind, value }:
//   kind 'image'  — value is a file name under data/avatars/,
//                   uploaded through the avatar routes and sniffed
//                   by magic bytes (never trusted by extension);
//   kind 'preset' — value is one of AVATAR_PRESETS; the client
//                   renders the CSS gradient, no image is stored;
//   kind 'letter' — value is one of AVATAR_COLORS; the client
//                   renders the entity's initial on that color.
// Anything missing or malformed normalizes to a letter avatar in a
// name-derived color, so every entity always renders SOMETHING —
// the pre-v0.14.2 look (bots: the C tile; accounts: an initial
// circle) is the client's job when avatar is null, and stored rows
// from before the avatar column existed simply read as null.
export const AVATAR_PRESETS = [
  { id: 'sunset', css: 'radial-gradient(120% 120% at 20% 15%, #FF9F2E 0%, #B04FE0 48%, #2743A6 100%)' },
  { id: 'lagoon', css: 'linear-gradient(135deg, #123B2F, #0FA87A)' },
  { id: 'amber', css: 'linear-gradient(135deg, #3A2A12, #E8A33D)' },
  { id: 'ocean', css: 'linear-gradient(135deg, #12283B, #3D7BE8)' },
  { id: 'orchid', css: 'linear-gradient(135deg, #2B1230, #E84D9B)' },
  { id: 'brand', css: 'linear-gradient(135deg, #6C5CE7, #00CEC9)' },
  { id: 'slate', css: 'linear-gradient(135deg, #23272E, #5A6672)' },
  { id: 'ember', css: 'linear-gradient(135deg, #3B1410, #E85D3D)' },
];
export const AVATAR_COLORS = [
  { id: 'violet', css: '#6C5CE7' },
  { id: 'teal', css: '#0FA87A' },
  { id: 'amber', css: '#E8A33D' },
  { id: 'blue', css: '#3D7BE8' },
  { id: 'pink', css: '#E84D9B' },
  { id: 'red', css: '#D64550' },
  { id: 'gray', css: '#5A6672' },
  { id: 'lime', css: '#7A9E2E' },
];
const presetIds = new Set(AVATAR_PRESETS.map((p) => p.id));
const colorIds = new Set(AVATAR_COLORS.map((c) => c.id));

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/* Uploaded file names are server-minted: kind prefix + 16 random
 * bytes hex + the sniffed extension. This pattern is the ONLY shape
 * the serving route will read back — no user-controlled path ever
 * reaches the filesystem. */
export const AVATAR_FILE_RE = /^av_[0-9a-f]{32}\.(png|jpg|webp)$/;

/* Deterministic fallback color for a name, so an entity's letter
 * avatar looks the same on every surface and every device. */
export function colorForName(name) {
  const s = String(name || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length].id;
}
export function letterForName(name) {
  return { kind: 'letter', value: colorForName(name) };
}

/* Validate + normalize a client-supplied avatar object. Returns
 * null when the shape is unusable — callers decide whether that is
 * a 400 (explicit set) or a silent fallback (stored data). */
export function normalizeAvatar(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '');
  const value = String(raw.value || '');
  if (kind === 'preset' && presetIds.has(value)) return { kind, value };
  if (kind === 'letter' && colorIds.has(value)) return { kind, value };
  if (kind === 'image' && AVATAR_FILE_RE.test(value)) return { kind, value };
  return null;
}
export function parseStoredAvatar(json) {
  if (!json) return null;
  try { return normalizeAvatar(JSON.parse(json)); } catch { return null; }
}

/* Magic-byte sniffing for the three accepted formats. The client's
 * declared mime and the file name are never consulted — bytes only. */
export function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
export const AVATAR_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/* Delete an image avatar's file (v0.21.0, audit F-12/F-26): the
 * ONLY deletion path for avatar files — it re-validates through
 * normalizeAvatar + AVATAR_FILE_RE, so a stored value can never be
 * turned into a path traversal, and preset/letter avatars (no file)
 * are a no-op. Best-effort: returns true only when a file was
 * actually unlinked. Callers: bot deletion, account deletion, and
 * any avatar-change path that replaces an image. */
export function deleteAvatarImageFile(dataDir, avatar) {
  const av = normalizeAvatar(avatar);
  if (!av || av.kind !== 'image' || !dataDir) return false;
  try {
    fs.unlinkSync(path.join(dataDir, 'avatars', av.value));
    return true;
  } catch { return false; }
}
