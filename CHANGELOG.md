# Changelog

## v0.12.0 — 2026-11-08 (real-device feedback batch, 11 items)

Driven by the owner's first days of real use after the SSO launch.

- **Approval cards that can't die silently (1).** A failed or stale
  decision used to leave a dead card: buttons now disable with a
  "deciding" note, a 404 flips the card to a clear "no longer
  pending" state, other errors re-enable with an error note, and
  returning to the app re-syncs pending cards.
- **Per-account isolation (2).** Providers (and vault keys) and bots
  now carry an owner; other accounts can't see, edit, delete or
  reference them. Pre-v0.12 data is adopted by the primary owner
  (the main-site root's shadow account when present); the keyless
  Ollama provider stays shared infrastructure. Team export only
  ships your own bots.
- **Sign-in button (3).** The main-site sign-in is now a solid black
  "Sign in with Complay" button.
- **Local model catalog (4).** 95 entries, all verified against the
  Ollama registry manifests. Several requested flagships
  (DeepSeek V4 Flash, GLM-4.6/4.7/5, Kimi K2.5/Thinking, MiniMax M2)
  are RETIRED on Ollama — "No models have been pushed" — and are
  deliberately NOT listed (they would be dead download buttons);
  V4 Pro / Kimi K2.6 exist only as cloud tags. Added instead:
  Qwen3.5 family, Gemma 4 family, Qwen3-VL family, Nemotron 3
  Nano/Super, Devstral Small 2, Phi-4 Reasoning, DeepSeek-OCR.
- **Approvals, fewer and clearer (5, 8).** A third decision —
  "always allow" — persists a per user+bot+tool grant (Settings
  lists and revokes them; every use is audited). Session-allow now
  covers shell too, keeping both consistent. `package_project`
  dropped to safe (it only zips the bot's own workspace with
  secrets excluded). Every card and tool row now leads with a
  deterministic plain-words explanation, and ALL card/stream
  payloads are secret-masked server-side — the explanation line
  included.
- **Streaming that doesn't seize up (6).** Tokens append to a text
  node; Markdown renders once at the end. Auto-scroll only follows
  when you're already near the bottom.
- **A browser and previews (7).** New `browse_page` tool: launches
  headless Chromium on demand when installed, else fetch+extract;
  loopback/private addresses are refused. New `delete_file` /
  `rename_file` tools (ask-tier). Workspace HTML gets an in-app
  preview (sandboxed iframe) and signed share links with OG cards
  — previews run under a sandbox CSP with an opaque origin.
- **Bubbles finished properly (9).** Every AI bubble carries an
  "AI-generated, may be wrong" note and a copy button; Markdown
  tables render as tables (a separator-regex bug that ate the
  first body row was found by screenshot and fixed) with their
  own TSV copy button.
- **Usage that means something (10).** The bars are now a daily
  quota ladder: 500M tokens/day per user, and the tier doubles
  (500M → 1B → 2B…) whenever the day's use passes it, so the bar
  never overflows. (Display only — your own API balance is yours.)
  Deleted bots' usage rows are removed and orphans filtered; an
  undefined CSS variable (--a/--b) that left every usage fill
  invisible is fixed.
- **Notch-safe + the capsule (11).** viewport-fit=cover and
  safe-area insets across header, lock screen, views and composer.
  The bottom bar is now the main site's floating capsule: hovering
  pill, blurred, with the active tab riding in a raised gradient
  circle that springs between tabs. Roster cards stagger in; view
  switches, cards and dialogs use the shared spring language with
  reduced-motion respected. (The capsule initially floated OVER
  the chat composer on phones — stacking-context fix shipped.)

## v0.11.0 — 2026-11-08 (main-site SSO)


## v0.10.1 — 2026-11-07 (text-call leak, second shape)

The v0.9 fix held printed calls back ONLY while no structured call
existed. DeepSeek also prints the same call as text ALONGSIDE the
structured one — and the moment a structured slot existed, content
streamed raw, so the printed copy leaked into the chat as a dashed
bubble next to the approval card (production screenshot, 23:48).

- Content now ALWAYS passes through the holdback buffer.
- Round-end reconciliation: the held tail is prose, a duplicate
  print of a structured call (dropped; compared key-sorted), or an
  extra text-only call (executed alongside the structured ones).
  Stored context keeps prose only — no call text in history either.
- Verified against the incident's exact command (text + structured
  double emission): executed once via one approval, zero call text
  in the token stream or the stored messages; mixed structured+text
  rounds run both calls; prose mentioning a tool still flows.

## v0.10.0 — 2026-11-07 (auth alignment batch, second pass)

Driven by the owner's item-by-item comparison with the main site's
auth modal; the v0.9 pass had aligned fields/flow only.

- **Registration is open** (main-site shape): the lock screen switches
  between sign-in and register; new accounts are members and must
  prove an email with a mailed code (same code discipline as resets).
  `START_AGENTS_ALLOW_REGISTER=0` closes it. First-account setup is
  unchanged and still token-gated when a token is configured.
- **The setup sentence is gone from sign-in**: the hint no longer
  tells every visitor "first time? create the admin account". Setup
  guidance renders only in the genuine zero-account state.
- **Auth errors are localized keys now**: wrong password, disabled,
  locked, captcha, mail-off, bad/expired/over-tried codes, taken
  names — the server returns stable keys and the UI renders them in
  the user's language. Internal error text (e.g. "mail is not
  configured on this server") never reaches the screen.
- **Cloudflare Turnstile** (the main site's provider): widget +
  server verification on sign-in, registration and code sending,
  active only when site key + secret are configured.
- **Social sign-in**: Google (OAuth, verified id token, account by
  identity or verified email) and Telegram (Login Widget, HMAC
  verified) — each appears only when configured. The ecosystem
  unified account (SSO) is reserved in the state payload and lands
  with that system.
- **Task strip collapses**: the chat's live task list is one line by
  default (progress + current item), tap to unfold; a finished list
  folds itself.
- **Mail alignment**: documented Resend preset sending from the main
  site's address (secret@egame.dev) in .env.example.

## v0.9.0 — 2026-11-07 (user feedback batch: nine items)

- **Text tool-call leak fixed (production report)**: DeepSeek-style
  name-prefix text calls (`run_shell{...}`) slipped past the text-call
  interception and streamed raw JSON into the chat. The parser now
  recognizes the prefix form (real tool + one balanced JSON object +
  nothing after), and streaming holds content per line: a line that
  could still become a call is buffered until the round decides, prose
  streams the moment it is classified. Prose quoting tool names or
  example JSON is not swallowed (regression-tested both ways).
- **Local models "never reply"**: the wait for a local endpoint's
  first byte is now 180s (cold Ollama loads on small boxes routinely
  exceed the old 30s and died silently), plus a 120s mid-stream idle
  cutoff so a wedged provider fails loudly instead of hanging.
- **Thinking models**: `reasoning_content` / `reasoning` deltas are
  forwarded as their own event and shown in one folded "Thinking"
  block per turn — never mixed into the reply; a reasoning-only turn
  still produces a visible reply.
- **Model catalog**: 8 verified flagships added (74 total): DeepSeek
  V3.1 671B, R1 671B, Qwen3 235B, Qwen3-Next 80B, Qwen3-Coder already
  there, Devstral 2 123B, Llama 3.1 405B, Cogito 2.1 671B, Magistral
  24B — every tag checked against the Ollama registry with real
  sizes. Kimi K2 / GLM flagships are not in Ollama's official library
  yet and were honestly left out.
- **Settings page collected**: all seven cards are collapsible
  sections (account + providers open by default); token usage gained
  progress bars (today vs all-time, per-bot share).
- **Login aligned with the main site's auth**: labeled fields,
  show-password eye, password strength bar on setup, two-step reset
  (email -> code + new password + confirm), username-or-email sign-in.
- **Chat declutter**: the working protocol now forbids pasting full
  code into the chat (files via write_file, prose = conclusions);
  package cards became deliverable cards with a folded file list and
  the excluded-for-safety note.
- **Multi-bot collaboration (was: did not exist)**: new
  `ask_teammate` tool — a bot delegates a self-contained task to a
  teammate by name; the teammate runs a real turn in its own
  workspace (its transcript records the delegation), its approvals
  surface in the delegating chat, usage is billed to the teammate,
  and delegation is one level deep. Verified end-to-end.

## 0.8.1 — 2026-11-07

- Local-model catalog grows 25 → **66 models**, every tag verified
  against the official Ollama registry with real download sizes.
- The settings model picker is now a single dropdown + detail card
  (was: a page-long grouped list).
- Workspace files preview **inside the app**: text and images open in
  a viewer sheet; only the Save button downloads.

## 0.8.0 — 2026-11-07

A hardening + alignment release driven by two external security
audits and the v0.8 plan (36-item merged checklist).

Security (P0):
- First-account registration requires the access token when one is
  set; public bind with no authentication at all refuses to start.
- Members can no longer edit bots or approve shell commands;
  approvals are decidable only by the run's owner or an owner, and
  the audit log records who decided.
- "Allow all this session" is per-user, 30-minute TTL, and never
  applies to run_shell. Stopping a run now cancels its pending
  approvals and cannot be raced into executing afterwards.
- run_shell environment is a whitelist; the vault master key moved
  out of data/ to ~/.starts-agents/vault.key (auto-migrated).
- Workspace files: active content types are no longer served inline
  (sandbox CSP + nosniff + attachment). API gains Host allowlist,
  Origin and JSON content-type checks.

Correctness (P1):
- Tool results are structured ({ ok, output }) — shell exit codes and
  file contents no longer confuse failure tracking/meltdown.
- Login rate limiting counts per account globally and ignores
  spoofed X-Forwarded-For unless TRUST_PROXY is set; the legacy
  /api/login is limited too. Legacy token sessions die with the token.
- A provider's key is never replaced by the environment key; the env
  provider applies only to providerless bots (as documented). Broken
  keys surface an explicit error. Master-key rotation ships as
  scripts/rekey.mjs.
- search_text no longer follows symlinks out of the workspace;
  packages exclude secrets (.env, keys, credentials) and report it;
  package_project and write_note are approval-gated.
- Team Markdown round-trips losslessly (persona lines that look like
  structure stay text); the configured default engine is honored.

Product:
- Approval cards are restorable: reload / switch views and the
  pending card is re-fetched and re-rendered (id-deduped); SSE sends
  a 15s heartbeat so proxies stop killing waiting streams; the task
  center links straight to a waiting approval.
- Roster no longer flashes on refresh (signature-skipped rebuilds,
  first-appearance-only entrance animation, swipe actions hidden
  until touched).
- Providers own model lists: fetch from /models, test connection,
  edit in place; bots pick provider → model by tap. Presets updated
  (Kimi K2 lineup).
- Accounts reach the main site's standard: email (login + recovery),
  display names, session list with per-session revoke, admin disable,
  email-code password reset (SMTP or log transport, anti-enumeration).
- Signed share links with OG preview cards for bots and packages;
  a package link grants its one download until expiry.
- UI: bottom-sheet dialogs on mobile, self-built dropdowns (no
  native <select>), capsule primaries, tab bar and motion aligned
  with the main site; native-select ban is now project policy.
- Docs: SECURITY.md, .env.example, backup/restore guide; corrupt
  state/auth files fail closed instead of resetting empty; audit log
  redacts secret-shaped strings; zip packages carry unix permissions;
  Ollama installs set OLLAMA_CONTEXT_LENGTH=32768; CI + node:test
  suite added. package.json version finally matches reality.

Policy: this application does no region-based blocking, by design.

## 0.7.2 — 2026-11-07
Hand-drawn SVG icon set (no emoji UI), live token usage display,
visible per-card ⋯ menu with two-step delete.

## 0.7.0 — 2026-11-07
Accounts (scrypt, revocable sessions, owner/member), task lifecycle
with real stop, card roster with live status, workspace card, quick
actions, bottom tab bar, task center, 25 local models in collapsible
groups, volunteer program groundwork.

## 0.6.x and earlier
PWA shell, access-token gate, agent work protocol, attachments,
package downloads, 15-language UI. See git history.
