// Central configuration. Everything is an environment variable with a
// local-first default: no account, no cloud, no key required to boot.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* Integer env knob with a floor: unset / unparsable / below the floor
 * falls back to the default, so a typo can never disable a safety cap
 * by accident. Caps that may be turned OFF document 0 as their off
 * switch and use min 0. */
function envInt(name, dflt, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
}
/* One rate-limit pair: SA_RL_<NAME> hits per SA_RL_<NAME>_WINDOW_MS. */
function rlPair(name, limit, windowMs) {
  return {
    limit: envInt(`SA_RL_${name}`, limit),
    windowMs: envInt(`SA_RL_${name}_WINDOW_MS`, windowMs, 1),
  };
}

/* SSO trust base validation (v0.15.7, item 118-4): the handoff
 * redeem target is the root of trust for every SSO sign-in, so an
 * env override must be a bare ORIGIN over https — no path, query,
 * fragment or embedded credentials — or plain http to a LOOPBACK
 * host only (the test seam: suites point the flow at a local mock
 * main site). Anything else is refused and the default stands,
 * with a boot-time error line so the misconfiguration is loud,
 * not silent. */
export function isValidSsoBase(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.pathname !== '/' || u.search || u.hash) return false;
  if (u.protocol === 'https:') return Boolean(u.hostname);
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  return false;
}
function ssoBase() {
  const raw = process.env.START_AGENTS_SSO_BASE;
  if (!raw) return 'https://egame.dev';
  const clean = raw.replace(/\/$/, '');
  if (isValidSsoBase(clean)) return clean;
  console.error(`[config] START_AGENTS_SSO_BASE ${JSON.stringify(raw)} is not a bare https origin (http allowed for loopback only); ignoring it and using https://egame.dev`);
  return 'https://egame.dev';
}

export const config = {
  root,
  host: process.env.START_AGENTS_HOST || '127.0.0.1',
  port: Number(process.env.START_AGENTS_PORT || 8797),
  // Access token for public (subdomain) deployments. When set, every
  // page and API call requires it: visitors enter it once and get a
  // long-lived cookie. Leave unset ONLY for localhost-only use —
  // without it, anyone who finds the URL can approve shell commands.
  accessToken: process.env.START_AGENTS_ACCESS_TOKEN || '',
  dataDir: process.env.START_AGENTS_DATA || path.join(root, 'data'),
  // File tools are confined to each bot's own workspace:
  // data/projects/<botId>/ under dataDir. (A former sandboxDir setting
  // was removed in v0.8 — nothing read it; per-bot workspaces are the
  // real boundary.)
  // Default engine for new bots: 'echo' works offline with no key.
  defaultEngine: process.env.START_AGENTS_ENGINE || 'echo',
  // Public self-registration (main-site alignment, v0.10): open by
  // default; new accounts are members and must prove an email with a
  // mailed code. Set START_AGENTS_ALLOW_REGISTER=0 to close it.
  allowRegister: process.env.START_AGENTS_ALLOW_REGISTER !== '0',
  // Human verification (main site uses Cloudflare Turnstile): active
  // only when BOTH keys are configured; otherwise no widget, no gate.
  turnstile: {
    siteKey: process.env.START_AGENTS_TURNSTILE_SITE_KEY || '',
    secret: process.env.START_AGENTS_TURNSTILE_SECRET || '',
  },
  // Social sign-in: each provider appears only when fully configured.
  google: {
    clientId: process.env.START_AGENTS_GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.START_AGENTS_GOOGLE_CLIENT_SECRET || '',
  },
  telegram: {
    botUsername: process.env.START_AGENTS_TG_BOT_USERNAME || '',
    botToken: process.env.START_AGENTS_TG_BOT_TOKEN || '',
  },
  // GitHub sign-in endpoints (v0.15.5, item 103). The credentials
  // themselves do NOT live here — they resolve per request through
  // oauth-apps.js (Settings store > SA_GITHUB_*/GITHUB_* env). The
  // two base URLs are split exactly like the real service (web for
  // authorize/token, api for /user) and exist as seams so tests
  // can point the whole flow at a local mock — the same precedent
  // as SA_PLATFORM_BOX_URL.
  githubWebBase: (process.env.SA_GITHUB_WEB_BASE || 'https://github.com').replace(/\/$/, ''),
  githubApiBase: (process.env.SA_GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, ''),
  // Main-site accounts (2026-11-07 decision): sign-in goes through
  // egame.dev's one-time handoff; local accounts remain only as a
  // bootstrap/break-glass fallback. START_AGENTS_SSO=0 disables,
  // START_AGENTS_SSO_BASE overrides the main site's origin.
  ssoEnabled: process.env.START_AGENTS_SSO !== '0',
  ssoBase: ssoBase(),
  // Optional sandbox modules (v0.13): downloadable toolchains that
  // unlock extra bot tools (real Chromium, a Python data venv,
  // ffmpeg, pandoc, ripgrep+jq). They live OUTSIDE data/ and outside
  // every bot workspace; only owners can install them, from fixed
  // official sources (see src/modules.js).
  modulesDir: process.env.SANDBOX_MODULES_DIR || path.join(root, 'sandbox-modules'),
  // Platform Simular Box preset (item 76): the built-in MCP server
  // every install offers first (platformBoxRow in mcp.js + the BYO
  // connect flow in server.js both read it from HERE). Default is
  // Simular's production endpoint; SA_PLATFORM_BOX_URL points the
  // preset elsewhere (self-hosted box, staging, a test mock)
  // without a code change.
  platformBoxUrl: (process.env.SA_PLATFORM_BOX_URL || 'https://mcp.box.simular.ai/mcp').replace(/\/$/, ''),
  // Per-bot workspace quota (v0.13): write_file / edit_file refuse to
  // grow a workspace past this cap. Default 500 MB;
  // START_AGENTS_WORKSPACE_QUOTA_MB=0 means unlimited.
  workspaceQuotaBytes: (() => {
    const raw = process.env.START_AGENTS_WORKSPACE_QUOTA_MB;
    if (raw === undefined) return 500 * 1024 * 1024;
    const mb = Number(raw);
    if (!Number.isFinite(mb)) return 500 * 1024 * 1024;
    return mb > 0 ? Math.round(mb * 1024 * 1024) : 0;
  })(),
  // Canonical origin for OAuth callbacks; derived from the request
  // when unset.
  publicUrl: (process.env.START_AGENTS_PUBLIC_URL || '').replace(/\/$/, ''),
  /* Cost gates (v0.14 batch 2 — audit P1-14/P1-15/P1-17/K1 + item
   * 20). Every ceiling is an SA_* env var with a production-sane
   * default, read HERE and nowhere else. Token caps take 0 = off. */
  // Global JSON body cap for readBody (chat keeps its own larger
  // explicit cap for base64 attachments). Bytes.
  bodyLimit: envInt('SA_BODY_LIMIT', 1024 * 1024, 1),
  // Chat message text cap, in characters. 0 = off.
  chatContentMax: envInt('SA_CHAT_CONTENT_MAX', 32000),
  // Per-request output cap sent to OpenAI-compatible engines as
  // max_tokens. 0 = omit the field (provider default).
  maxTokensOut: envInt('SA_MAX_TOKENS_OUT', 8192),
  // Per-user DAILY token hard cap (owners exempt). 0 = off.
  dailyTokenCap: envInt('SA_DAILY_TOKEN_CAP', 20_000_000),
  // Volunteer program v3 (v0.14.1, item 39): how many bring-your-own
  // local endpoints one volunteer may register. Traffic through a
  // volunteer's OWN endpoint runs on their hardware, so it is not
  // charged to the daily cap above (draft decision 2).
  volunteerEndpointLimit: envInt('SA_VOLUNTEER_ENDPOINT_LIMIT', 3),
  // Per-RUN token budget, shared by the whole delegation tree. 0 = off.
  runTokenBudget: envInt('SA_RUN_TOKEN_BUDGET', 2_000_000),
  // Per-run wall clock, approval waits included.
  runWallMs: envInt('SA_RUN_WALL_MS', 15 * 60 * 1000, 1),
  // How long an approval card waits for a human before it
  // auto-denies (item 82: was a hardcoded 5 minutes inside the
  // broker; now a config cap like every other clock — the card
  // UI already counts it down).
  approvalTtlMs: envInt('SA_APPROVAL_TTL_MS', 5 * 60 * 1000, 30 * 1000),
  // Token budget for the history window handed to the model
  // (character-estimated). 0 = no token-aware trimming.
  contextTokenBudget: envInt('SA_CONTEXT_TOKEN_BUDGET', 120000),
  // After the chat client disconnects, a run gets this long to finish
  // on its own before it is aborted (runs parked on an approval card
  // are exempt — the card's own timeout governs those). The default
  // rose 60s -> 10min with item 119 (v0.15.7): runs are journaled
  // and re-attachable, so a phone locking or an app switch must not
  // burn a run the user is coming back to.
  disconnectGraceMs: envInt('SA_DISCONNECT_GRACE_MS', 600000),
  // Live activity monitor (v0.15.8, item 131): the OPTIONAL module
  // that projects a run's thinking/action stream (steps, thinking
  // presence, approvals) to its owner as a live carousel. Two
  // switches, either one kills it: this deployment flag
  // (SA_LIVE_MONITOR=0) and the per-user preference (default on,
  // stored in kv). The projection endpoint enforces run ownership
  // regardless of the switches — see src/monitor.js.
  liveMonitor: process.env.SA_LIVE_MONITOR !== '0',
  // Top-level runs ONE user may hold live at once, across all bots
  // (v0.15.5, items 91/93). Replaces the v0.14 hard rule of exactly 1,
  // which made every other bot of the same user read "busy" for the
  // whole length of any one run. Delegated sub-turns borrow their
  // parent run's slot and never count here. 0 = no per-user cap.
  maxRunsPerUser: envInt('SA_MAX_RUNS_PER_USER', 3),
  // Box-wide ceiling on live top-level runs, all users together —
  // the backstop that keeps a many-account box from melting its
  // single event loop. 0 = no global cap.
  maxRunsGlobal: envInt('SA_MAX_RUNS_GLOBAL', 8),
  // After the run watchdog aborts an over-age run that STILL does
  // not settle, the entry gets this long before the reaper removes
  // it outright (identity-checked) and closes the persisted run as
  // 'interrupted' (v0.15.5, item 93). Settlement used to be the
  // ONLY way an entry left the registry, so one wedged turn could
  // pin its bot — and, via the old per-user rule, its user — at
  // 409 until a restart.
  runReapGraceMs: envInt('SA_RUN_REAP_GRACE_MS', 60_000, 1),
  // How often the watchdog/reaper sweeps the live-run registry.
  runWatchdogMs: envInt('SA_RUN_WATCHDOG_MS', 30_000, 250),
  /* Provider request discipline (v0.15.5, item 91): the OpenAI-
   * compatible engine retries 429/5xx with exponential backoff +
   * jitter under these bounds, and at most providerInflightMax
   * requests per provider endpoint are in flight at once — extra
   * rounds queue abortably at the request layer instead of piling
   * onto a shared key and failing opaquely. */
  providerInflightMax: envInt('SA_PROVIDER_INFLIGHT_MAX', 4, 1),
  // Retries AFTER the first attempt (so 3 = up to 4 requests).
  providerRetryMax: envInt('SA_PROVIDER_RETRY_MAX', 3),
  providerRetryBaseMs: envInt('SA_PROVIDER_RETRY_BASE_MS', 1000, 1),
  providerRetryCapMs: envInt('SA_PROVIDER_RETRY_CAP_MS', 30_000, 1),
  /* Storage (v0.14 batch 5a): automatic SQLite snapshots of
   * data/app.db land in data/backups/ at startup and every 24h;
   * SA_BACKUP_KEEP bounds how many are retained. Audit rows older
   * than SA_AUDIT_KEEP_DAYS are pruned at startup. */
  backupKeep: envInt('SA_BACKUP_KEEP', 7, 1),
  auditKeepDays: envInt('SA_AUDIT_KEEP_DAYS', 90, 1),
  /* Instance timezone for usage-day boundaries (v0.15, sweep
   * P2-22): an IANA name ('Asia/Shanghai'); empty = host zone. */
  tz: process.env.SA_TZ || '',
  /* Optional SECOND backup directory (v0.15, sweep P1-3): when
   * set, every snapshot is also mirrored there — point it at a
   * different mount to survive a disk loss. Empty = off. */
  backupDir2: process.env.SA_BACKUP_DIR2 || '',
  /* Optional alert webhook (v0.15, sweep P2-15): key events
   * (watchdog-killed runs, backup failures, vault key errors) are
   * POSTed here as JSON. Empty = off. */
  alertWebhook: process.env.SA_ALERT_WEBHOOK || '',
  rateLimits: {
    sendCodeIp: rlPair('SENDCODE_IP', 10, 10 * 60 * 1000),
    sendCodeGlobal: rlPair('SENDCODE_GLOBAL', 200, 60 * 60 * 1000),
    ssoExchange: rlPair('SSO_EXCHANGE', 30, 60 * 1000),
    chatUser: rlPair('CHAT_USER', 20, 60 * 1000),
    loginIp: rlPair('LOGIN_IP', 30, 60 * 1000),
  },
  // OpenAI-compatible endpoint (works for OpenAI, OpenRouter, DeepSeek,
  // a local llama.cpp / Ollama server, ...). Used by the 'openai' engine.
  ai: {
    baseUrl: (process.env.START_AGENTS_AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: process.env.START_AGENTS_AI_API_KEY || '',
    model: process.env.START_AGENTS_AI_MODEL || 'gpt-4o-mini',
  },
};
