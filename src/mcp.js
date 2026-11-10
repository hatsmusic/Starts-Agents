// MCP client (v0.15, item 58): user-configured remote MCP servers
// over Streamable HTTP, plus the platform Simular Box channel.
//
// One module owns the whole client side of the protocol:
//   - server CRUD in the mcp_servers table (migration v5) — secrets
//     live ONLY as vault ciphertext in secret_enc: the bare token
//     for auth_type 'token', a JSON blob ({access, refresh,
//     expiresAt, clientSecret?}) for 'oauth'. Nothing public ever
//     carries the plaintext (see publicMcpServer).
//   - a minimal JSON-RPC client: initialize handshake per session,
//     Mcp-Session-Id passthrough, SSE or plain-JSON responses,
//     server-initiated requests refused with -32601 (ping answered),
//     OAuth 401 -> one forced refresh + one retry.
//   - the OAuth flow (discovery via WWW-Authenticate / resource
//     metadata, dynamic client registration, PKCE S256) — every
//     endpoint comes from discovery documents, none is hardcoded.
//   - materializeMcpResult: folds a tools/call result into text,
//     spilling image/audio payloads into the bot workspace.
// SSRF: every connection is vetted by the tools.js guard
// (assertPublicUrl: scheme, DNS resolution, private-range refusal)
// before a byte leaves the box; create-time validation can only
// judge the LITERAL host, so the full check lives at connect time.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { encrypt, decrypt } from './vault.js';
import { assertPublicUrl, isPrivateIp, workspaceUsage, adjustWorkspaceUsage } from './tools.js';
import { getKv, setKv } from './store.js';
import { config } from './config.js';
import { resolveOAuthApp } from './oauth-apps.js';

const db = () => getDb();

/* ------------------------------ errors ----------------------------- */
// Callers branch on .code (the i18n key family errMcp*), so every
// failure this module raises deliberately carries one.
function mcpError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* --------------------------- url guard ----------------------------- */
// Indirection exists ONLY for tests: the real guard refuses
// 127.0.0.1, which is exactly where a fake MCP server has to live.
// Production always runs assertPublicUrl; the coordinator never
// touches this hook.
let urlGuard = assertPublicUrl;
export function __setUrlGuardForTest(fn) {
  urlGuard = typeof fn === 'function' ? fn : assertPublicUrl;
}

/* ------------------------------ slug ------------------------------- */
export function slugifyMcp(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return s || 'srv';
}

/* ------------------------- exec-class tools ------------------------ */
// Tools that drive a machine (shells, computer use, raw clicking /
// typing) are exec-class wherever they came from: the harness maps
// them onto its highest approval tier, no matter what a remote
// server calls its own risk level. Judged on the RAW remote name.
//
// INVERTED DEFAULT (item 156 E-08): the name regex used to be the
// whole judgement, so a remote server could walk a real execution
// tool past every exec-keyed defence (owner-only deciding, taint
// marking, the high risk band) by naming it `bash`, `eval_js`,
// `fs_write` or `key_press` — none of which the word list knew.
// The judgement is now default-deny: a tool is NON-exec only when
// its name matches a known read-only shape (a read verb prefix, a
// read-only suffix, or a small exact list of inert utilities);
// anything else — writes, actions, machine driving, the simply
// unknown — is exec-class. The old regex survives as an override
// in the other direction: a machine-driving name is exec even if
// it happens to start with a read verb (`get_shell_history` is
// not a lookup, it is a shell).
const EXEC_CLASS_RE = /shell|exec|computer|gui|terminal|command|desktop|click|type_text|keyboard|mouse|run_/i;
const READONLY_PREFIX_RE = /^(?:get|list|search|find|read|fetch|query|lookup|describe|show|view|check|stat|info|count|exists|is|has|can|ping|health|whoami|preview|print|head|echo)(?:_|-|$)/i;
const READONLY_EXACT_RE = /^(?:search|query|list|get|read|fetch|find|status|info|ping|health|whoami|echo|version|time|now|date|calculator|convert_units|screenshot|take_screenshot|capture_screen|screen_capture)$/i;
const READONLY_SUFFIX_RE = /(?:_search|_query|_list|_info|_status|_read|_lookup|_count|_exists|_preview)$/i;
export function isMcpExecClass(toolName) {
  const n = String(toolName || '');
  if (EXEC_CLASS_RE.test(n)) return true;
  if (/read[-_]?only/i.test(n)) return false;
  if (READONLY_PREFIX_RE.test(n) || READONLY_EXACT_RE.test(n) || READONLY_SUFFIX_RE.test(n)) return false;
  return true;
}

/* --------------------- dynamic tool naming -------------------------
 * The chat catalog names a remote tool `mcp__<slug>__<remoteName>`
 * capped at 64 chars. Two collisions used to hide inside that
 * shape (item 156 E-10): plain truncation made two long remote
 * names on one server identical, and the slug is only unique PER
 * USER while the platform Box row's slug is always 'box' — a user
 * row slugged 'box' produced byte-identical names to the platform
 * row's, so getTool / approvals / grants keyed by name could not
 * tell the servers apart. The naming policy therefore lives HERE
 * (the wiring in server.js buildMcpToolDefs is the coordinator's
 * one-line adoption, recorded in the batch report):
 *   - mcpToolNameFor: the legacy name when it fits; when it would
 *     overflow, a name carrying a hash of (server id + remote
 *     name) instead of a plain truncation — same inputs, same
 *     name, different servers/tools, different names.
 *   - uniqueMcpToolNames: given one turn's full entry list,
 *     disambiguates any remaining exact duplicates (the cross-row
 *     slug collision) with a server-id hash suffix fitted into
 *     the 64-char cap. First occurrence keeps the plain name, so
 *     existing names stay stable wherever no collision exists. */
export const MCP_TOOL_NAME_MAX = 64;
function shortHash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 10); }
export function mcpToolNameFor(row, toolName) {
  const slug = String(row?.slug || 'srv');
  const clean = String(toolName || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const base = `mcp__${slug}__${clean}`;
  if (base.length <= MCP_TOOL_NAME_MAX) return base;
  const suffix = `__h${shortHash(`${row?.id || row?.url || ''}:${toolName}`)}`;
  return base.slice(0, MCP_TOOL_NAME_MAX - suffix.length) + suffix;
}
export function uniqueMcpToolNames(entries) {
  const seen = new Map(); // name -> count
  return (Array.isArray(entries) ? entries : []).map((e) => {
    const row = e?.row || e;
    const toolName = e?.toolName ?? e?.name ?? '';
    let name = mcpToolNameFor(row, toolName);
    const n = seen.get(name) || 0;
    seen.set(name, n + 1);
    if (n > 0) {
      const suffix = `__s${shortHash(`${row?.id || row?.url || ''}:${toolName}:${n}`)}`;
      name = name.slice(0, MCP_TOOL_NAME_MAX - suffix.length) + suffix;
    }
    return name;
  });
}

/* ------------------------------ CRUD ------------------------------- */
const AUTH_TYPES = ['none', 'token', 'oauth'];

export function getMcpServerRow(id) {
  if (!id) return null;
  return db().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) || null;
}

function parseSecretJson(row) {
  if (!row || !row.secret_enc) return {};
  try {
    const obj = JSON.parse(decrypt(row.secret_enc));
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

export function publicMcpServer(row) {
  if (!row) return null;
  let oauth = null;
  if ((row.auth_type || row.authType) === 'oauth') {
    const secret = parseSecretJson(row);
    oauth = {
      connected: Boolean(secret.access),
      expiresAt: secret.expiresAt ?? null,
    };
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    url: row.url,
    authType: row.auth_type || row.authType || 'none',
    enabled: Boolean(row.enabled ?? 1),
    preset: row.preset || '',
    hasSecret: Boolean(row.secret_enc),
    oauth,
    timeoutS: Number(row.timeout_s ?? row.timeoutS) || 120,
    createdAt: row.created_at || row.createdAt || '',
  };
}

export function listMcpServers(userId) {
  const rows = db().prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY created_at ASC, rowid ASC').all(userId || '');
  return rows.map(publicMcpServer);
}

function validateName(name) {
  const n = String(name ?? '').trim();
  if (n.length < 1 || n.length > 40) throw mcpError('errMcpName', 'MCP server name must be 1-40 characters');
  return n;
}

function validateCreateUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch { throw mcpError('errMcpUrl', 'MCP server URL is not a valid URL'); }
  if (u.protocol !== 'https:') throw mcpError('errMcpUrl', 'MCP server URL must use https');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw mcpError('errMcpUrl', 'MCP server URL has no host');
  // Literal hosts are judged NOW (private / loopback literals can
  // never become valid); DNS names are judged at connect time by
  // assertPublicUrl, which resolves them — a name is not an IP, and
  // isPrivateIp fails closed on anything unrecognizable, so it must
  // only ever be fed literals.
  const isLiteralIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (isLiteralIp && isPrivateIp(host)) throw mcpError('errMcpUrl', 'MCP server URL host is a private or loopback address');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw mcpError('errMcpUrl', 'MCP server URL host is a local address');
  }
  return u.toString();
}

function uniqueSlug(userId, base) {
  const taken = new Set(db().prepare('SELECT slug FROM mcp_servers WHERE user_id = ?').all(userId || '').map((r) => r.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function createMcpServer(userId, { name, url, authType, token, preset } = {}) {
  const cleanName = validateName(name);
  const cleanUrl = validateCreateUrl(url);
  const auth = authType === undefined || authType === '' ? 'none' : String(authType);
  if (!AUTH_TYPES.includes(auth)) throw mcpError('errMcpAuth', 'MCP auth type must be none, token or oauth');
  const id = 'mcp_' + crypto.randomBytes(8).toString('hex');
  const secretEnc = token ? encrypt(String(token)) : '';
  db().prepare(`INSERT INTO mcp_servers
    (id, user_id, name, slug, url, auth_type, enabled, preset, secret_enc, oauth_meta, timeout_s, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, '', 120, ?)`)
    .run(id, userId || '', cleanName, uniqueSlug(userId, slugifyMcp(cleanName)), cleanUrl, auth, preset || '', secretEnc, new Date().toISOString());
  return publicMcpServer(getMcpServerRow(id));
}

export function updateMcpServer(id, { name, enabled, timeoutS } = {}) {
  const row = getMcpServerRow(id);
  if (!row) return null;
  const sets = [];
  const vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(validateName(name)); }
  if (enabled !== undefined) { sets.push('enabled = ?'); vals.push(enabled ? 1 : 0); }
  if (timeoutS !== undefined) {
    const t = Number(timeoutS);
    const clamped = Number.isFinite(t) ? Math.min(600, Math.max(30, Math.floor(t))) : 120;
    sets.push('timeout_s = ?'); vals.push(clamped);
  }
  if (sets.length) {
    db().prepare(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    invalidateMcpTools(id);
  }
  return publicMcpServer(getMcpServerRow(id));
}

export function deleteMcpServer(id) {
  const r = db().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  invalidateMcpTools(id);
  return Number(r.changes) > 0;
}

/* ----------------------------- secrets ----------------------------- */
export function getMcpSecret(id) {
  const row = getMcpServerRow(id);
  if (!row || !row.secret_enc) return null;
  try { return decrypt(row.secret_enc); } catch { return null; }
}

export function setMcpSecret(id, value) {
  const row = getMcpServerRow(id);
  if (!row) return false;
  const plain = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  db().prepare('UPDATE mcp_servers SET secret_enc = ? WHERE id = ?').run(plain ? encrypt(plain) : '', id);
  invalidateMcpTools(id);
  return true;
}

/* Boot health (v0.15.2, audit BC P2-4): every stored MCP secret
 * — user servers AND the synthesized platform Box row — gets a
 * trial decrypt so a damaged vault key surfaces at boot for this
 * surface too, not at the first tool call. Ids only, never content. */
export function mcpSecretHealth() {
  const bad = [];
  let checked = 0;
  const rows = db().prepare('SELECT id, secret_enc FROM mcp_servers').all();
  // B-02 (audit r1): read the Box secret from STORAGE, not via
  // platformBoxRow() — that row only exists while the Box is
  // mode=global AND enabled, so a configured-but-disabled Box
  // key escaped the trial decrypt (and would escape a rotation
  // post-mortem the same way). The kv face is in
  // vault.VAULT_CIPHER_SURFACES.
  const platStored = platformBoxStored();
  if (platStored.secretEnc) rows.push({ id: '__platform_box__', secret_enc: platStored.secretEnc });
  for (const r of rows) {
    if (!r.secret_enc) continue;
    checked++;
    try { decrypt(r.secret_enc); } catch { bad.push(r.id); }
  }
  return { checked, bad };
}

// Plaintext secret straight off a row object (CRUD rows and the
// synthesized platform row both carry secret_enc). Returns '' when
// there is none or it no longer decrypts.
function secretStringFromRow(row) {
  if (!row) return '';
  if (row.secret_enc) {
    try { return decrypt(row.secret_enc); } catch { return ''; }
  }
  return typeof row.secret === 'string' ? row.secret : '';
}

function secretObjectFromRow(row) {
  const s = secretStringFromRow(row);
  if (!s) return {};
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

// Internal save: encrypts a secret object onto the row (DB + the
// caller's object, so a flow mid-flight sees its own write). Never
// invalidates sessions — the OAuth refresh path runs INSIDE rpc,
// where dropping the session under the in-flight request would
// orphan it; callers that mean "credentials changed" invalidate
// explicitly (finishOAuth, setMcpSecret).
function saveSecretObject(rowOrId, obj) {
  const enc = encrypt(JSON.stringify(obj));
  const id = typeof rowOrId === 'string' ? rowOrId : rowOrId?.id;
  if (rowOrId && typeof rowOrId === 'object') rowOrId.secret_enc = enc;
  if (id) {
    try { db().prepare('UPDATE mcp_servers SET secret_enc = ? WHERE id = ?').run(enc, id); } catch { /* synthesized rows have no DB home */ }
  }
  return enc;
}

/* ------------------------- oauth metadata -------------------------- */
function parseOAuthMeta(row) {
  const raw = row?.oauth_meta ?? row?.oauthMeta;
  if (raw) {
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (obj && typeof obj === 'object' && Object.keys(obj).length) return obj;
    } catch { /* fall through to the stored row */ }
  }
  if (row?.id) {
    const stored = getMcpServerRow(row.id);
    if (stored && stored.oauth_meta) {
      try { return JSON.parse(stored.oauth_meta); } catch { return {}; }
    }
  }
  return {};
}

function saveOAuthMeta(row, meta) {
  const text = JSON.stringify(meta);
  if (row && typeof row === 'object') row.oauth_meta = text;
  if (row?.id) {
    try { db().prepare('UPDATE mcp_servers SET oauth_meta = ? WHERE id = ?').run(text, row.id); } catch { /* synthesized row */ }
  }
}

/* --------------------------- http helpers -------------------------- */
const timeoutOf = (server, opts = {}) => {
  if (opts.timeoutMs != null && Number.isFinite(Number(opts.timeoutMs))) return Number(opts.timeoutMs);
  return (Number(server?.timeout_s ?? server?.timeoutS) || 120) * 1000;
};

/* Redirect-disciplined fetch (v0.15.2, audit B-P1-1): the SSRF
 * guard used to run ONCE on the entry URL while the global fetch
 * followed redirects blindly — a configured (or compromised)
 * server could 307 the client, Authorization header and all,
 * straight at a link-local or intranet target. Every hop is now
 * followed MANUALLY: the guard re-runs per hop, an https→http
 * downgrade is refused, Authorization is stripped when the hop
 * changes origin, and the chain is capped at 5. */
async function fetchGuarded(url, init, signal) {
  let current = String(url);
  let curInit = { ...init };
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...curInit, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const loc = res.headers.get('location');
    await readBodyCapped(res).catch(() => ''); // capped drain (audit R2-08): the body is discarded, but never buffered whole
    if (!loc || hop >= 5) throw mcpError('errMcpRemote', 'MCP server redirected too many times');
    const next = new URL(loc, current).toString();
    await urlGuard(next);
    const from = new URL(current);
    const to = new URL(next);
    if (from.protocol === 'https:' && to.protocol !== 'https:') throw mcpError('errMcpRemote', 'MCP redirect downgraded the connection to http');
    if (to.origin !== from.origin && curInit.headers) {
      if (typeof curInit.headers.delete === 'function') { const h = new Headers(curInit.headers); h.delete('authorization'); curInit = { ...curInit, headers: h }; }
      else {
        const h = { ...curInit.headers };
        for (const k of Object.keys(h)) if (k.toLowerCase() === 'authorization') delete h[k];
        curInit = { ...curInit, headers: h };
      }
    }
    const method = String(curInit.method || 'GET').toUpperCase();
    if ([301, 302, 303].includes(res.status) && method !== 'GET' && method !== 'HEAD') {
      const { body, ...rest } = curInit;
      curInit = { ...rest, method: 'GET' };
    }
    current = next;
  }
}

// fetch with a hard wall clock: aborts become errMcpTimeout, the
// rest of the network's weather becomes errMcpConnect.
async function fetchTimed(url, init, timeoutMs, { timeoutCode = 'errMcpTimeout', externalSignal = null } = {}) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onExternal = () => ctl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctl.abort();
    else externalSignal.addEventListener('abort', onExternal, { once: true });
  }
  try {
    return await fetchGuarded(url, init, ctl.signal);
  } catch (e) {
    if (timedOut) throw mcpError(timeoutCode, `MCP request timed out after ${timeoutMs}ms`);
    if (externalSignal?.aborted) throw e;
    if (e && e.name === 'AbortError') throw mcpError(timeoutCode, `MCP request timed out after ${timeoutMs}ms`);
    throw mcpError('errMcpConnect', `MCP connection failed: ${e.message || e}`);
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternal);
  }
}

// OAuth-side fetch: same guard + clock as the RPC path, so a
// hostile or broken authorization server gets no softer treatment
// than the MCP server itself.
async function oauthFetch(server, url, init, timeoutMs) {
  /* v0.15.2 (audit B-P1-2): discovery documents are server-
   * controlled data — the endpoints they name carry authorization
   * codes, PKCE verifiers and refresh tokens, so they must be
   * https, not merely public. The create-URL path enforced this
   * from the start; the discovery chain now does too. */
  let u;
  try { u = new URL(String(url)); } catch { throw mcpError('errMcpOauth', 'OAuth endpoint is not a valid URL'); }
  // https everywhere; plain http survives ONLY on loopback (the
  // same exception the server-URL rules make — a local dev AS on
  // the operator's own machine exposes nothing to the network).
  const loopbackHttp = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '::1' || u.hostname.startsWith('127.'));
  if (u.protocol !== 'https:' && !loopbackHttp) throw mcpError('errMcpOauth', 'OAuth endpoints must use https');
  await urlGuard(url);
  return fetchTimed(url, init, timeoutMs);
}

/* ------------------------------ OAuth ------------------------------ */
export async function discoverOAuth(server) {
  const timeoutMs = timeoutOf(server);
  let resourceMetadataUrl = null;
  let resource = null;
  let resourceScopes = [];
  let authServer = null;
  // Probe: an unauthenticated initialize. A spec-shaped 401 points
  // at the protected-resource metadata; anything else (including a
  // server that just answers) falls back to the origin well-known.
  try {
    const probe = await oauthFetch(server, server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'starts-agents', version: '0.21.0' } },
      }),
    }, timeoutMs);
    const www = probe.headers.get('www-authenticate') || '';
    await readBodyCapped(probe).catch(() => ''); // R2-08 family (delta audit R2B-01): discard reads are capped too
    const m = www.match(/resource_metadata=(?:"([^"]+)"|([^,\s]+))/);
    if (m) resourceMetadataUrl = m[1] || m[2];
  } catch (e) {
    if (e && e.code === 'errMcpTimeout') throw e;
    // A failed probe is not yet a failed discovery — the fallback
    // below gets its chance; only its failure is final.
  }
  if (resourceMetadataUrl) {
    try {
      const r = await oauthFetch(server, resourceMetadataUrl, { headers: { Accept: 'application/json' } }, timeoutMs);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      resource = j.resource || null;
      authServer = Array.isArray(j.authorization_servers) ? j.authorization_servers[0] : null;
      // The resource document also names the scopes the resource
      // server understands (item 129): for authorization servers
      // that publish no metadata document of their own this is the
      // ONLY scope source, so it is kept as the fallback below.
      if (Array.isArray(j.scopes_supported)) resourceScopes = j.scopes_supported;
    } catch (e) {
      throw mcpError('errMcpOauth', `OAuth resource metadata fetch failed: ${String(e.message || e).slice(0, 200)}`);
    }
  }
  if (!authServer) {
    try { authServer = new URL(server.url).origin; } catch { throw mcpError('errMcpOauth', 'MCP server URL is not a valid URL'); }
  }
  let metadata = null;
  try {
    const r = await oauthFetch(server, authServer.replace(/\/$/, '') + '/.well-known/oauth-authorization-server', { headers: { Accept: 'application/json' } }, timeoutMs);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    metadata = await r.json();
  } catch (e) {
    if (e && e.code === 'errMcpOauth') throw e;
    /* Platform short-circuit (v0.15.8, item 129): GitHub's
     * authorization server publishes NO RFC 8414 metadata document
     * at all (every well-known path 404s), so the generic discovery
     * above can never succeed for the GitHub connector — and until
     * now it threw BEFORE ensureOAuthClient could seed the
     * platform-registered client, leaving the connector dead. When
     * this server has a platform OAuth client, its endpoints are
     * a matter of public record: synthesize them from the
     * discovered authorization-server base (GitHub's resource
     * metadata names https://github.com/login/oauth) instead of
     * failing. No registration endpoint exists there — the
     * platform client replaces DCR by design (item 102). Any
     * server WITHOUT a platform client keeps the hard failure. */
    if (!platformOAuthClientFor(server)) {
      throw mcpError('errMcpOauth', `OAuth discovery failed: ${String(e.message || e).slice(0, 200)}`);
    }
    const base = authServer.replace(/\/$/, '');
    metadata = {
      authorization_endpoint: base + '/authorize',
      token_endpoint: base + '/access_token',
      registration_endpoint: '',
      revocation_endpoint: '',
      scopes_supported: resourceScopes,
      synthesized: true,
    };
  }
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw mcpError('errMcpOauth', 'OAuth metadata is missing authorization or token endpoints');
  }
  const existing = parseOAuthMeta(server);
  const meta = {
    resource: resource || server.url,
    authServer,
    endpoints: {
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
      registration_endpoint: metadata.registration_endpoint || '',
      revocation_endpoint: metadata.revocation_endpoint || '',
    },
    scopes_supported: Array.isArray(metadata.scopes_supported) && metadata.scopes_supported.length
      ? metadata.scopes_supported : resourceScopes,
  };
  // Rediscovery must not orphan a client registered against the
  // same authorization server.
  if (existing.clientId && existing.authServer === authServer) meta.clientId = existing.clientId;
  saveOAuthMeta(server, meta);
  return meta;
}

/* Platform-registered OAuth client (v0.15.5, item 102): the
 * GitHub connector is special — GitHub's authorization server
 * does not offer dynamic registration to this client class, so
 * the operator pre-registers an OAuth app (Settings → OAuth apps,
 * or the SA_GITHUB_* env pair) and its client_id/secret are used
 * INSTEAD of DCR whenever this exact server is connected. Any
 * other server keeps the DCR flow untouched. Identified ONLY by
 * the canonical endpoint URL — a user typing the GitHub MCP
 * address by hand gets the platform client too. (Item 156 E-01:
 * this used to also trust a `preset === 'github'` flag, but preset
 * was user-writable at the create route — a self-declared
 * "github" row on an attacker URL got the platform client_secret
 * seeded into it and POSTed to the attacker's own token endpoint.
 * A display label must never be a credential-routing decision.) */
const GITHUB_MCP_HOST = 'api.githubcopilot.com';
function isGithubMcpServer(server) {
  if (!server) return false;
  try {
    const u = new URL(server.url || '');
    return u.hostname === GITHUB_MCP_HOST && u.pathname.replace(/\/+$/, '') === '/mcp';
  } catch { return false; }
}
function platformOAuthClientFor(server) {
  if (!isGithubMcpServer(server)) return null;
  try { return resolveOAuthApp('github'); } catch { return null; }
}

export async function ensureOAuthClient(server, redirectUri) {
  let meta = parseOAuthMeta(server);
  if (!meta.endpoints?.token_endpoint) meta = await discoverOAuth(server);
  const platform = platformOAuthClientFor(server);
  if (platform) {
    // Seed the pre-registered pair through the same two stores
    // DCR uses (oauth_meta for the id, the encrypted blob for the
    // secret) so finishOAuth / refresh read them unchanged.
    if (meta.clientId !== platform.clientId) {
      meta = { ...meta, clientId: platform.clientId };
      saveOAuthMeta(server, meta);
    }
    const secret = secretObjectFromRow(server);
    if (secret.clientSecret !== platform.clientSecret) {
      secret.clientSecret = platform.clientSecret;
      saveSecretObject(server, secret);
    }
    return meta;
  }
  if (meta.clientId) return meta;
  if (!meta.endpoints.registration_endpoint) {
    throw mcpError('errMcpOauth', 'OAuth server offers no dynamic client registration and no client is registered');
  }
  const timeoutMs = timeoutOf(server);
  let j;
  try {
    const r = await oauthFetch(server, meta.endpoints.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Starts-Agents',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    }, timeoutMs);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    j = await r.json();
  } catch (e) {
    if (e && (e.code === 'errMcpOauth' || e.code === 'errMcpTimeout')) throw e;
    throw mcpError('errMcpOauth', `OAuth client registration failed: ${String(e.message || e).slice(0, 200)}`);
  }
  if (!j.client_id) throw mcpError('errMcpOauth', 'OAuth client registration returned no client_id');
  meta = { ...meta, clientId: j.client_id };
  saveOAuthMeta(server, meta);
  if (j.client_secret) {
    const secret = secretObjectFromRow(server);
    secret.clientSecret = j.client_secret;
    saveSecretObject(server, secret);
  }
  return meta;
}

const base64url = (buf) => Buffer.from(buf).toString('base64url');

/* OAuth entry guard (item 156 E-31): the flow rewrites the row's
 * secret blob as a JSON token object, which silently DESTROYS a
 * token-type row's bare-string secret. Starting (or finishing) an
 * OAuth flow on a non-oauth row is therefore refused up front
 * with a stable code instead of corrupting a working connector. */
function assertOAuthRow(server) {
  const t = server?.auth_type || server?.authType;
  if (t !== 'oauth') throw mcpError('errMcpAuth', 'this MCP server is not an OAuth server — reconnect is only for auth type oauth');
}

export async function buildOAuthStart(server, redirectUri) {
  assertOAuthRow(server);
  await discoverOAuth(server);
  const meta = await ensureOAuthClient(server, redirectUri);
  const state = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  const verifier = base64url(crypto.randomBytes(48)); // 64 url-safe chars
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const supported = Array.isArray(meta.scopes_supported) ? meta.scopes_supported : [];
  let scope;
  if (platformOAuthClientFor(server)) {
    /* Scope policy for platform clients (v0.15.8, item 129,
     * recorded decision): GitHub is asked for the identity
     * baseline ONLY — read:user + user:email. When the resource
     * metadata's scopes_supported is known, the request narrows
     * to the supported subset of that baseline; when it is
     * unknown (or names neither), the baseline goes out whole —
     * GitHub grants per the operator's app registration and the
     * baseline is what the connector's identity needs. Broader
     * grants (repo & friends) are a product decision for the
     * operator's app registration, never something this client
     * escalates on its own. */
    const baseline = ['read:user', 'user:email'];
    const picked = supported.length ? baseline.filter((s) => supported.includes(s)) : baseline;
    scope = (picked.length ? picked : baseline).join(' ');
  } else {
    const wanted = ['boxes', 'connect'].filter((s) => supported.includes(s));
    scope = supported.length ? wanted.join(' ') : 'boxes connect';
  }
  const authUrl = new URL(meta.endpoints.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', meta.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  if (scope) authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', server.url);
  return { authUrl: authUrl.toString(), state, verifier };
}

async function postTokenForm(server, meta, form) {
  const secret = secretObjectFromRow(server);
  if (meta.clientId && !form.has('client_id')) form.set('client_id', meta.clientId);
  if (secret.clientSecret && !form.has('client_secret')) form.set('client_secret', secret.clientSecret);
  const timeoutMs = timeoutOf(server);
  let r;
  try {
    r = await oauthFetch(server, meta.endpoints.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    }, timeoutMs);
  } catch (e) {
    if (e && (e.code === 'errMcpOauth' || e.code === 'errMcpTimeout')) throw e;
    throw mcpError('errMcpOauth', `OAuth token request failed: ${String(e.message || e).slice(0, 200)}`);
  }
  if (!r.ok) throw mcpError('errMcpOauth', `OAuth token endpoint returned HTTP ${r.status}`);
  return r.json();
}

function storeTokenResponse(server, j) {
  const secret = secretObjectFromRow(server);
  secret.access = j.access_token;
  if (j.refresh_token) secret.refresh = j.refresh_token;
  secret.expiresAt = Date.now() + (Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600) * 1000;
  saveSecretObject(server, secret);
  return secret;
}

export async function finishOAuth(server, { code, verifier, redirectUri } = {}) {
  assertOAuthRow(server);
  let meta = parseOAuthMeta(server);
  if (!meta.endpoints?.token_endpoint) meta = await discoverOAuth(server);
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('code', String(code || ''));
  form.set('redirect_uri', String(redirectUri || ''));
  form.set('code_verifier', String(verifier || ''));
  const saved = storeTokenResponse(server, await postTokenForm(server, meta, form));
  invalidateMcpTools(server.id);
  return { connected: true, expiresAt: saved.expiresAt };
}

async function refreshOAuthToken(server) {
  let meta = parseOAuthMeta(server);
  if (!meta.endpoints?.token_endpoint) meta = await discoverOAuth(server);
  const secret = secretObjectFromRow(server);
  if (!secret.refresh) throw mcpError('errMcpOauth', 'OAuth connection has no refresh token — reconnect the server');
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', secret.refresh);
  const saved = storeTokenResponse(server, await postTokenForm(server, meta, form));
  return saved.access;
}

export async function getAccessToken(server) {
  const authType = server?.auth_type || server?.authType;
  if (authType !== 'oauth') return null;
  const secret = secretObjectFromRow(server);
  if (!secret.access) throw mcpError('errMcpOauth', 'OAuth server is not connected yet');
  if (secret.expiresAt && secret.expiresAt - Date.now() < 60_000 && secret.refresh) {
    return refreshOAuthToken(server);
  }
  return secret.access;
}

/* --------------------------- Box tool gate -------------------------
 * Enforcement hook for the shared-Box entity lock (item 156
 * E-05): browser-box.js registers its policy here at load, and
 * mcpCallTool consults it before any non-internal call. The gate
 * receives the call's actor (userId/botId) when the caller passes
 * them in opts — the dyn-tool path in server.js is the caller
 * that must (coordinator wiring, see the batch report). Internal
 * card-face calls pass boxInternal and are judged by the card
 * lock itself, never by this gate. */
let boxToolGate = null;
export function setBoxToolGate(fn) { boxToolGate = typeof fn === 'function' ? fn : null; }

/* ------------------------- sessions & cache ------------------------ */
// Live protocol state per server id: the session id the server
// handed back (echoed on every later request) and whether the
// initialize handshake already ran on it.
const sessions = new Map();
function sessionFor(serverId) {
  if (!sessions.has(serverId)) sessions.set(serverId, { sessionId: '', initialized: false });
  return sessions.get(serverId);
}

const toolsCache = new Map(); // `${serverId}:${secret fingerprint}` -> { at, tools }
const TOOLS_CACHE_TTL_MS = 5 * 60 * 1000;
const secretFingerprint = (server) => crypto.createHash('sha256').update(String(server?.secret_enc || '')).digest('hex').slice(0, 16);

export function invalidateMcpTools(serverId) {
  if (!serverId) return;
  for (const key of [...toolsCache.keys()]) {
    if (key.startsWith(serverId + ':')) toolsCache.delete(key);
  }
  sessions.delete(serverId);
}

/* ------------------------------ client ----------------------------- */
let rpcSeq = 0;

async function authHeaderFor(server) {
  const authType = server?.auth_type || server?.authType || 'none';
  if (authType === 'token') {
    const s = secretStringFromRow(server);
    return s ? `Bearer ${s}` : null;
  }
  if (authType === 'oauth') {
    const tok = await getAccessToken(server);
    return tok ? `Bearer ${tok}` : null;
  }
  return null;
}

function baseHeaders(server, auth) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (auth) h.Authorization = auth;
  const sid = server?.id ? sessions.get(server.id)?.sessionId : '';
  if (sid) h['Mcp-Session-Id'] = sid;
  return h;
}

// Answer one server-initiated request: ping gets an empty result,
// everything else (sampling, elicitation, roots…) gets -32601 —
// this client accepts no server-initiated requests, per contract.
async function postServerResponse(server, auth, req) {
  const body = req.method === 'ping'
    ? { jsonrpc: '2.0', id: req.id, result: {} }
    : { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'client does not accept server-initiated requests' } };
  try {
    const res = await fetchTimed(server.url, {
      method: 'POST', headers: baseHeaders(server, auth), body: JSON.stringify(body),
    }, timeoutOf(server));
    if (server.id) {
      const sid = res.headers.get('mcp-session-id');
      if (sid) sessionFor(server.id).sessionId = sid;
    }
    await readBodyCapped(res).catch(() => ''); // capped drain (audit R2-08): the body is discarded, but never buffered whole
  } catch { /* the answer is best-effort; the original result stands */ }
}

/* Response size discipline (item 156 E-09): the RPC body used to
 * be read whole with res.text() and no bound — a hostile or
 * hijacked server could balloon process memory with one giant
 * reply before any parsing happened. The body is now streamed
 * with a hard 32 MB ceiling (a declared Content-Length over the
 * cap is refused before a byte is read). */
export const RPC_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
async function readBodyCapped(res, capBytes = RPC_MAX_RESPONSE_BYTES) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > capBytes) {
    throw mcpError('errMcpRemote', `MCP response exceeds the ${capBytes}-byte limit`);
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > capBytes) {
        try { await reader.cancel(); } catch { /* already gone */ }
        throw mcpError('errMcpRemote', `MCP response exceeds the ${capBytes}-byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > capBytes) {
    throw mcpError('errMcpRemote', `MCP response exceeds the ${capBytes}-byte limit`);
  }
  return text;
}

async function rpc(server, method, params, opts = {}) {
  await urlGuard(server.url);
  const serverId = server.id || server.url;
  const timeoutMs = timeoutOf(server, opts);
  const authType = server?.auth_type || server?.authType || 'none';
  const auth = await authHeaderFor(server);
  const reqId = ++rpcSeq;
  const payload = { jsonrpc: '2.0', id: reqId, method, params: params ?? {} };

  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onExternal = () => ctl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort();
    else opts.signal.addEventListener('abort', onExternal, { once: true });
  }
  try {
    let res;
    try {
      res = await fetchGuarded(server.url, {
        method: 'POST', headers: baseHeaders(server, auth), body: JSON.stringify(payload),
      }, ctl.signal);
    } catch (e) {
      if (timedOut) throw mcpError('errMcpTimeout', `MCP request timed out after ${timeoutMs}ms`);
      if (opts.signal?.aborted) throw e;
      if (e && e.name === 'AbortError') throw mcpError('errMcpTimeout', `MCP request timed out after ${timeoutMs}ms`);
      throw mcpError('errMcpConnect', `MCP connection failed: ${e.message || e}`);
    }
    if (server.id) {
      const sid = res.headers.get('mcp-session-id');
      if (sid) sessionFor(serverId).sessionId = sid;
    }
    if (res.status === 401 && authType === 'oauth' && !opts._oauthRetried) {
      await readBodyCapped(res).catch(() => ''); // capped drain (audit R2-08): the body is discarded, but never buffered whole
      // One forced refresh + one retry of the whole request; a
      // second 401 lands in the generic non-2xx path below.
      await refreshOAuthToken(server);
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onExternal);
      return rpc(server, method, params, { ...opts, _oauthRetried: true });
    }
    let bodyText;
    try { bodyText = await readBodyCapped(res); } catch (e) {
      if (timedOut) throw mcpError('errMcpTimeout', `MCP request timed out after ${timeoutMs}ms`);
      if (e && e.code === 'errMcpRemote') throw e; // the size cap's own verdict stands
      throw mcpError('errMcpConnect', `MCP response read failed: ${e.message || e}`);
    }
    if (!res.ok) throw mcpError('errMcpConnect', `MCP server returned HTTP ${res.status}`);

    // Two wire shapes: a single JSON body (object or batch array),
    // or an SSE stream of `data:` lines. Both reduce to a message
    // list; server-initiated requests inside either are collected
    // and answered only once the stream has ended.
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const messages = [];
    if (contentType.includes('text/event-stream')) {
      for (const line of String(bodyText).split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { messages.push(JSON.parse(data)); } catch { /* keepalive / partial junk */ }
      }
    } else if (bodyText.trim()) {
      let parsed;
      try { parsed = JSON.parse(bodyText); } catch { throw mcpError('errMcpRemote', 'MCP server returned an unparseable response'); }
      if (Array.isArray(parsed)) messages.push(...parsed); else messages.push(parsed);
    }
    const pending = messages.filter((m) => m && typeof m.method === 'string' && m.id !== undefined && m.id !== null);
    for (const req of pending) await postServerResponse(server, auth, req);
    const match = messages.find((m) => m && ('result' in m || 'error' in m) && String(m.id) === String(reqId));
    if (!match) throw mcpError('errMcpRemote', 'MCP server response did not include a result for this request');
    if (match.error) {
      throw mcpError('errMcpRemote', String(match.error.message || 'MCP remote error').slice(0, 200));
    }
    return match.result;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onExternal);
  }
}

async function sendNotification(server, method, params, opts = {}) {
  await urlGuard(server.url);
  const auth = await authHeaderFor(server);
  const res = await fetchTimed(server.url, {
    method: 'POST',
    headers: baseHeaders(server, auth),
    body: JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }),
  }, timeoutOf(server, opts), { externalSignal: opts.signal || null });
  await readBodyCapped(res).catch(() => ''); // capped drain (audit R2-08): the body is discarded, but never buffered whole
}

async function ensureInitialized(server, opts = {}) {
  const serverId = server.id || server.url;
  if (sessionFor(serverId).initialized) return;
  await rpc(server, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'starts-agents', version: '0.21.0' },
  }, opts);
  sessionFor(serverId).initialized = true;
  // The initialized notification completes the handshake; a server
  // that dislikes it must not cost us the session.
  try { await sendNotification(server, 'notifications/initialized', {}, opts); } catch { /* best effort */ }
}

/* Session self-heal (item 156 E-29): a remote server restart
 * invalidates the Mcp-Session-Id this client keeps echoing, and
 * the session used to stay poisoned until the row's credentials
 * happened to change. When a call fails with the session-invalid
 * signature (an HTTP 404 on an established session, or an error
 * naming the session as unknown/expired), the session is dropped,
 * the initialize handshake re-runs, and the call is retried
 * exactly once. */
function isSessionInvalidError(e) {
  const msg = String((e && e.message) || e || '');
  return /HTTP 404/.test(msg) || /session[^.]{0,40}(not found|unknown|invalid|expired|gone)/i.test(msg);
}
async function rpcWithSessionHeal(server, method, params, opts = {}) {
  try {
    return await rpc(server, method, params, opts);
  } catch (e) {
    if (opts._sessionRetried || !isSessionInvalidError(e)) throw e;
    sessions.delete(server.id || server.url);
    await ensureInitialized(server, opts);
    return rpc(server, method, params, { ...opts, _sessionRetried: true });
  }
}

export async function mcpListTools(server, { fresh = false, timeoutMs = undefined } = {}) {
  const cacheKey = `${server.id}:${secretFingerprint(server)}`;
  if (!fresh) {
    const hit = toolsCache.get(cacheKey);
    if (hit && Date.now() - hit.at < TOOLS_CACHE_TTL_MS) return hit.tools;
  }
  // timeoutMs bounds EACH handshake/list request (v0.15 fix): a
  // dead server must never stall the caller for the full per-call
  // timeout (120s) — the chat path passes a short bound so one
  // unreachable server cannot hold a whole turn hostage.
  await ensureInitialized(server, { timeoutMs });
  const result = await rpcWithSessionHeal(server, 'tools/list', {}, { timeoutMs });
  const tools = (Array.isArray(result?.tools) ? result.tools : []).map((t) => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
  }));
  toolsCache.set(cacheKey, { at: Date.now(), tools });
  return tools;
}

export async function mcpCallTool(server, toolName, args, { signal = null, timeoutMs = undefined, actorUserId = '', actorBotId = '', boxInternal = false } = {}) {
  // Shared-Box entity gate (E-05): judged before any byte leaves —
  // a refused call costs no handshake and leaves no audit ghost.
  if (boxToolGate && !boxInternal) {
    boxToolGate({ row: server, toolName, userId: actorUserId, botId: actorBotId });
  }
  const opts = { signal, timeoutMs };
  await ensureInitialized(server, opts);
  const result = await rpcWithSessionHeal(server, 'tools/call', { name: toolName, arguments: args ?? {} }, opts);
  return {
    content: Array.isArray(result?.content) ? result.content : [],
    isError: Boolean(result?.isError ?? result?.is_error ?? false),
  };
}

/* --------------------------- materialize --------------------------- */
const MIME_EXT = {
  // NB: 'image/svg+xml' is deliberately ABSENT (item 156 E-28):
  // an SVG is script-capable markup, and MCP output is untrusted —
  // it lands as .bin (download-only material), never as a .svg a
  // preview face might one day serve inline. Item 148's rule.
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf', 'application/json': 'json', 'text/plain': 'txt',
};
function extForMime(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (MIME_EXT[m]) return MIME_EXT[m];
  const sub = m.split('/')[1]?.replace(/[^a-z0-9]/g, '') || '';
  return sub && sub.length <= 5 ? sub : 'bin';
}
function stampOf(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Fold a tools/call result into { text, files, images }: text parts
// join in order, binary parts are written under <workspace>/mcp/
// <slug>/ and leave a relative-path placeholder line in the text
// (files[] lists those same relative paths). Image parts ALSO ride
// back in `images` (v0.15.1, item 70 A1: { mime, data, rel }, capped
// at 4 images / ~6 MB each) so the engine can show them to a
// vision-capable model — the saved-file placeholder stays as the
// text-only model's explicit degradation path. Synchronous on
// purpose — callers use it inline while rendering a tool result.
/* Materialize bounds (item 156 E-09): a tools/call result is
 * remote-controlled input, and this path used to decode and write
 * EVERY data item at ANY size with no quota consultation — one
 * call could fill the disk for the whole deployment. The bounds
 * now mirror the native tools' discipline: per-item and per-call
 * byte caps, an item-count cap, and the workspace quota checked
 * BEFORE each write (usage adjusted after, like screenshot_page).
 * Over-limit items degrade to a placeholder line; the text of the
 * result still flows. */
export const MCP_MATERIALIZE_LIMITS = { maxItems: 32, maxItemBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 };
export function materializeMcpResult(result, { workspace, slug } = {}) {
  const safeSlug = String(slug || 'srv').replace(/[^\w.-]+/g, '-').replace(/^\.+/, '') || 'srv';
  const parts = [];
  const files = [];
  const images = [];
  let n = 0;
  let savedBytes = 0;
  const quotaCap = workspace ? Number(config.workspaceQuotaBytes) || 0 : 0;
  let quotaBase = null; // workspace usage, walked lazily on first save
  const saveData = (data, mime, isImage) => {
    const raw = String(data);
    // Decoded size from the base64 length (padding-aware) — judged
    // BEFORE decoding, so an oversized item costs no allocation.
    const approxBytes = Math.max(0, Math.floor(raw.length * 3 / 4) - (raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0));
    if (n >= MCP_MATERIALIZE_LIMITS.maxItems
      || approxBytes > MCP_MATERIALIZE_LIMITS.maxItemBytes
      || savedBytes + approxBytes > MCP_MATERIALIZE_LIMITS.maxTotalBytes) {
      parts.push('[skipped oversized content from the MCP server: item/count/size limit]');
      return;
    }
    if (quotaCap > 0) {
      if (quotaBase === null) { try { quotaBase = workspaceUsage(workspace); } catch { quotaBase = 0; } }
      if (quotaBase + savedBytes + approxBytes > quotaCap) {
        parts.push('[skipped content from the MCP server: the workspace quota is full]');
        return;
      }
    }
    n += 1;
    const ext = extForMime(mime || (isImage ? 'image/png' : ''));
    const file = `${isImage ? 'img' : 'file'}-${stampOf()}-${n}.${ext}`;
    const dir = path.join(workspace, 'mcp', safeSlug);
    fs.mkdirSync(dir, { recursive: true });
    const buf = Buffer.from(raw, 'base64');
    fs.writeFileSync(path.join(dir, file), buf);
    savedBytes += buf.length;
    if (quotaCap > 0) { try { adjustWorkspaceUsage(workspace, buf.length); } catch { /* counter is advisory */ } }
    const rel = `mcp/${safeSlug}/${file}`;
    files.push(rel);
    parts.push(isImage ? `[screenshot saved: ${rel}]` : `[file saved: ${rel}]`);
    const isSvg = String(mime || '').toLowerCase().split(';')[0].trim() === 'image/svg+xml';
    if (isImage && !isSvg && images.length < 4 && raw.length <= 8 * 1024 * 1024) {
      images.push({ mime: mime || 'image/png', data: raw, rel });
    }
  };
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text') {
      parts.push(String(item.text ?? ''));
    } else if (item.type === 'image') {
      if (item.data) saveData(item.data, item.mimeType || item.mime_type, true);
    } else if (item.type === 'resource') {
      const r = item.resource || {};
      if (r.text != null && r.text !== '') parts.push(String(r.text));
      else if (r.blob) saveData(r.blob, r.mimeType || r.mime_type, false);
      else if (r.uri || item.uri) parts.push(String(r.uri || item.uri));
    } else if (item.data) {
      // audio and every other data-carrying shape
      saveData(item.data, item.mimeType || item.mime_type, false);
    } else if (item.type === 'audio') {
      parts.push('[audio content without data]');
    }
  }
  return { text: parts.join('\n').slice(0, 20000), files, images };
}

/* --------------------------- platform Box -------------------------- */
// The platform Box channel (item 65): ONE key, configured by root,
// effective for everyone; usage is metered per user elsewhere. The
// record lives in kv ('platform:mcp_box') as
// { mode, secretEnc, enabled } — secretEnc is vault ciphertext and
// never leaves through getPlatformBox.
const PLATFORM_BOX_KV = 'platform:mcp_box';
const BOX_MODES = ['off', 'global', 'byo'];

function platformBoxStored() {
  try {
    const raw = getKv(PLATFORM_BOX_KV);
    if (!raw) return { mode: 'off', secretEnc: '', enabled: false };
    const j = JSON.parse(raw);
    return {
      mode: BOX_MODES.includes(j.mode) ? j.mode : 'off',
      secretEnc: j.secretEnc || '',
      enabled: Boolean(j.enabled),
    };
  } catch { return { mode: 'off', secretEnc: '', enabled: false }; }
}

export function getPlatformBox() {
  const s = platformBoxStored();
  return { mode: s.mode, configured: Boolean(s.secretEnc), enabled: s.enabled };
}

export function setPlatformBox({ mode, key, enabled } = {}) {
  const cur = platformBoxStored();
  if (mode !== undefined) {
    if (!BOX_MODES.includes(mode)) throw mcpError('errMcpAuth', "Box mode must be 'off', 'global' or 'byo'");
    cur.mode = mode;
  }
  if (key !== undefined) cur.secretEnc = key === '' ? '' : encrypt(String(key));
  if (enabled !== undefined) cur.enabled = Boolean(enabled);
  setKv(PLATFORM_BOX_KV, JSON.stringify(cur));
  return getPlatformBox();
}

export function platformBoxRow() {
  const s = platformBoxStored();
  if (s.mode !== 'global' || !s.secretEnc || !s.enabled) return null;
  return {
    id: '__platform_box__',
    user_id: '',
    name: 'Simular Box',
    slug: 'box',
    url: config.platformBoxUrl,
    auth_type: 'token',
    enabled: 1,
    preset: 'box',
    secret_enc: s.secretEnc,
    oauth_meta: '',
    timeout_s: 120,
    created_at: '',
  };
}
