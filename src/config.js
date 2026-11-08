// Central configuration. Everything is an environment variable with a
// local-first default: no account, no cloud, no key required to boot.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
  // Main-site accounts (2026-11-07 decision): sign-in goes through
  // egame.dev's one-time handoff; local accounts remain only as a
  // bootstrap/break-glass fallback. START_AGENTS_SSO=0 disables,
  // START_AGENTS_SSO_BASE overrides the main site's origin.
  ssoEnabled: process.env.START_AGENTS_SSO !== '0',
  ssoBase: (process.env.START_AGENTS_SSO_BASE || 'https://egame.dev').replace(/\/$/, ''),
  // Canonical origin for OAuth callbacks; derived from the request
  // when unset.
  publicUrl: (process.env.START_AGENTS_PUBLIC_URL || '').replace(/\/$/, ''),
  // OpenAI-compatible endpoint (works for OpenAI, OpenRouter, DeepSeek,
  // a local llama.cpp / Ollama server, ...). Used by the 'openai' engine.
  ai: {
    baseUrl: (process.env.START_AGENTS_AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: process.env.START_AGENTS_AI_API_KEY || '',
    model: process.env.START_AGENTS_AI_MODEL || 'gpt-4o-mini',
  },
};
