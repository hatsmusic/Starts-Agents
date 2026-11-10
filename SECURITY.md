# Security model

Starts-Agents is a self-hosted harness that lets AI models propose
actions and lets humans approve them. Read this before exposing it
beyond your own machine.

## The trust boundaries that exist

- **Accounts first.** The first account is created via the setup
  screen; when `START_AGENTS_ACCESS_TOKEN` is set, setup additionally
  requires that token. Once accounts exist, registration is closed.
- **The server refuses unsafe postures.** Binding a non-loopback
  address with no accounts and no access token exits at startup —
  that combination would hand an implicit owner to whoever finds
  the port. Corrupt data also fails closed: on the first boot after
  the SQLite migration, a legacy `data/auth.json` or `data/state.json`
  that cannot be parsed aborts the import and the boot (verbatim
  copies are kept under `data/backups/legacy-*`); nothing silently
  resets to empty.
- **Roles.** Owners administer accounts, providers and bots. Members
  can chat with bots. Shell approvals are site-owner-only. Since
  v0.14 batch 1, approval decisions carry an ownership dimension:
  on a bot that has an owner, a card is decided by the bot's owner
  or a site owner — the person who started a run on someone else's
  bot can NOT approve their own card. The bot's owner (or a site
  owner) running their own bot needs no card for `write_file` /
  `edit_file`; `delete_file` / `rename_file` still card and the
  owner decides them. Main-site SSO role mapping never downgrades an
  existing owner shadow account (a member-mapped payload keeps the
  owner role and the block is audit-logged as
  `sso_role_downgrade_blocked`), every SSO exchange is audit-logged
  with the received and mapped roles, and owner-gate 403 responses
  name the caller's account and current role so a lockout is
  self-diagnosing.
- **Sign-in surface (v0.14 batch 1).** With main-site SSO enabled,
  local password sign-in, public registration, Google/Telegram
  sign-in and registration codes do not exist (those routes answer
  404): accounts live on the main site, and a local door would
  bypass its bans and role control. Two channels remain: the SSO
  handoff, and the legacy `START_AGENTS_ACCESS_TOKEN` as a
  break-glass token sign-in (unset the env var to close it). With
  SSO off, local accounts work in full, unchanged. Sessions are
  device-style: 180-day TTL with sliding renewal (activity past the
  half-life extends the session). SSO shadow accounts re-verify:
  sessions die 72h after the last successful handoff exchange, so a
  main-site ban lands here within that window. A password change
  revokes the account's other sessions (the current one survives);
  a code-based reset revokes all of them. An email change takes
  effect only after a 6-digit code mailed to the NEW address is
  confirmed — until then the old address remains the login/reset
  address.
- **"Allow all this session"** is scoped to the granting user + bot +
  tool and expires after 30 minutes; it never survives a restart.
- **"Always allow" (v0.12, explicit product direction)** supersedes
  the v0.8 session-only stance: a persistent grant scoped to the
  granting user + bot + tool, stored in `data/app.db`, audited
  when granted and when used, listed and revocable under Settings.
  It IS available for `run_shell` — the operator accepted that trade
  deliberately; the grant still only ever covers one user's own bot,
  and shell approvals remain owner-only to DECIDE. Since v0.14
  batch 1 a persistent grant only ever SKIPS the card when the grant
  holder is the bot's owner or a site owner — a grant row naming
  anyone else (e.g. self-approved before the ownership rule landed)
  is inert on a bot that isn't theirs.
- **Provider isolation (v0.12).** Providers (and the API keys sealed
  in the vault) belong to the account that created them: other
  accounts cannot list, edit, delete or reference them, and a bot
  can only resolve a provider owned by the bot's own account. The
  local Ollama provider is shared infrastructure (no key). Pre-v0.12
  ownerless providers/bots were adopted by the primary owner account
  (the main-site root's shadow account when present).
- **Approval display.** Card arguments and previews are secret-masked
  before they leave the server, and every card carries a deterministic
  plain-language explanation of what the tool will do.
- **Untrusted content (v0.14 batch 3).** Text the model did not write
  is kept visibly data. Web-page, screenshot, file-read and
  search-hit tool results — and summaries returned by a delegated
  teammate — reach the model wrapped in
  `<untrusted-content source="…">…</untrusted-content>`, with any
  literal boundary tags inside the content defused, and the system
  prompt declares the boundary's meaning (data, never instructions;
  steering attempts inside it are to be ignored and reported). When
  a turn has read such content, a later shell / Python / delete
  approval card in the same turn carries an extra taint warning.
  Names are a channel too: bot names, display names and attachment
  filenames are normalized to a single line without control
  characters at write time, and the workspace tree re-flattens every
  name before it enters a system message, so no name can print a
  forged line into a prompt. Shared transcripts attribute every
  stored user message (`by` / `delegated` markers, rendered as
  author prefixes), and notes / task items written inside a
  delegated sub-turn are stamped with their delegation source.
- **Team files are supply chain (v0.14 batch 3).** Importing a team
  file whose bots carry persona or shared-instruction text requires
  an explicit second, confirmed POST — the first returns the exact
  instruction blocks (`pendingPersona`) and creates nothing, and the
  client shows them in a confirmation dialog. Persona-free files
  import in one shot.
- **Preview.** Workspace web projects can be previewed (and shared
  via signed links) only under a sandbox CSP without
  `allow-same-origin`: previewed pages get an opaque origin and can
  never reach the app's session or APIs. Since v0.13 the CSP also
  sets `connect-src 'none'`, so a previewed page's script cannot
  fetch/XHR the app's `/api` with the viewer's session either;
  static assets (css/js/img/fonts) still load, as they are
  subresource loads, not connect-src. Stated plainly: a previewed
  project cannot `fetch()` at all — not even same-origin URLs. The
  preview is for looking at a page, not for running an app against
  an API; a project that needs live requests must be packaged and
  deployed for real. Preview SHARE links are narrower still: a link
  serves only the directory subtree of the file it was minted for,
  sensitive files (`.env`, keys, credential stores) are never served
  through one, and only the bot's owner (or a site owner) can mint
  one.
- **Workspaces.** File tools are confined to `data/projects/<botId>/`
  with symlink (realpath) checks on every path, including search and
  packaging. Since v0.14 batch 1 the HTTP file surface — workspace
  listing, file viewer, raw file route, preview, packages — belongs
  to the bot's owner (or a site owner); everyone else gets the same
  404 as a nonexistent bot (chat and message history stay shared).
  Sensitive files (`.env`, keys, credential stores) follow one
  written policy: the bot's owner / a site owner may read them
  through the files and file-view routes only; preview never serves
  them to anyone; members are refused everywhere; and agents never
  read them at all — `read_file` refuses them outright and
  `search_text` skips them, so their contents cannot leak into a
  transcript or a tool result. Deployment packages automatically exclude `.env*`, key
  material, credential stores and similar files, and report what was
  excluded. Since v0.13 each workspace also has a size quota
  (default 500 MB, `START_AGENTS_WORKSPACE_QUOTA_MB`, 0 = unlimited)
  enforced by the write tools; usage and cap are visible on the
  workspace API. `run_shell` is deliberately not pre-blocked by the
  quota (builds spike temp files), so the quota is a write-tool
  guardrail, not a hard disk partition.
- **The shell is a host shell.** `run_shell` runs as the OS user of
  the server process. Its environment is a whitelist (PATH/HOME/
  locale only — server secrets are not inherited), it has a 120s
  timeout, its process group is killed on Stop, and since v0.13 the
  invocation sets generous `ulimit` soft caps (process count,
  virtual memory) as a speed bump against fork bombs and runaway
  allocators. The ulimits are accident guards, not a security
  boundary. It is NOT a
  sandbox or a container: anyone who can get a shell command approved
  can do anything that OS user can do. Run the service as a dedicated
  unprivileged user, and treat owner accounts accordingly.
- **Optional modules (v0.13).** Owners can install five pinned
  toolchains (Chromium headless shell from the official
  Chrome-for-Testing bucket, a Python venv, static ffmpeg, pandoc,
  ripgrep + jq) from Settings.
  The trust model: install steps are FIXED argv arrays in
  `src/modules.js` — never user input; downloads come only from the
  official sources pinned there (Chrome-for-Testing / PyPI / johnvansickle /
  GitHub releases); installs are owner-only, are audit-logged
  (start/done/fail), and land in `sandbox-modules/` (`SANDBOX_MODULES_DIR`)
  — outside `data/`, outside every bot workspace, and never inside a
  deployment package. Since v0.14 batch 4 an install is built in a
  staging directory and atomically renamed into place only after
  every step, checksum gate and artifact check passes; a failed
  install discards staging and leaves the previous directory
  untouched. A module's tools appear in the bots' tool
  lists only while the module is actually installed. You are
  trusting those upstream projects once installed: the binaries run
  with the same OS-user powers as the shell whenever a bot invokes
  them (behind the usual approval gates for the write/exec tools).
  Supply chain (audit fixes): every download is version-pinned —
  the browser build (`chrome-headless-shell` 141.0.7390.65) is
  downloaded directly from the official Chrome-for-Testing bucket
  and sha256-verified before unpacking (v0.14 batch 4: the earlier
  `@puppeteer/browsers` installer fetched opaquely and could not be
  hash-gated; Chrome for Testing publishes no `.sha256` sidecar, so
  the pinned hash was computed from the official archive on
  2026-11-08 and cross-checked by running the extracted binary);
  pip packages are exact pins
  (`requests==2.32.3`, `numpy==2.1.3`, `pandas==2.2.3`, verified on
  PyPI) installed from the forced official index
  (`--index-url https://pypi.org/simple`), and npm is forced to
  `registry.npmjs.org`. Installs run with a controlled, empty HOME
  (`sandbox-modules/.home`) so package-manager user config
  (`~/.npmrc`, pip.conf) cannot redirect or credential an install.
  Downloaded tarballs/binaries are sha256-verified before use: the
  ripgrep and jq hashes are the publishers' own (their release
  `sha256sum.txt` / checksums); pandoc publishes no checksum file
  and johnvansickle publishes only MD5s, so the pandoc 3.5 and
  ffmpeg 7.0.2 hashes were computed from the official release
  artifacts at pin time — the residual there is trusting that the
  pin-time download was genuine (HTTPS from the official host).
  Readiness is honest: a module counts as installed only when its
  artifacts are present AND the `.install-complete` marker written
  by the installer exists, and a failed install deletes its partial
  artifacts. Modules are Linux-only; other platforms report them
  `unsupported` and refuse installs.
- **The vault.** Provider API keys are AES-256-GCM encrypted. The
  master key is a RING (v0.14 batch 5b): `SA_VAULT_KEYS`
  (comma-separated, first = primary) → `SA_VAULT_KEY` →
  `START_AGENTS_MASTER_KEY` → `~/.starts-agents/vault.key` (0600) —
  deliberately outside `data/`, so a workspace escape cannot read
  it. Sealing always uses the primary key; opening tries every ring
  key. Rotate with `npm run vault:rotate` (server stopped): it
  re-seals every stored key under the primary, verifying each
  replacement before writing anything, and aborts untouched if any
  entry cannot be opened by the ring. (`scripts/rekey.mjs` remains
  for the simple two-key case.) A key that no longer decrypts
  surfaces as an explicit error in chat; it is never silently replaced
  by a fallback key. The environment-configured key
  (`START_AGENTS_AI_API_KEY`) is used ONLY for bots with no provider
  of their own. Verification codes (password reset / registration /
  email change) are stored as HMAC-SHA-256 under a pepper derived
  from the primary vault key, and password hashes are scrypt with
  the cost stored in the hash string (`v2:<N>:<hex>`, N=32768),
  upgraded silently on login — a leaked database alone yields
  neither live codes nor cheap password guesses.
- **Uploaded/generated files** are served with a sandbox CSP and
  `nosniff`; active types (HTML/SVG/JS/PDF…) download as plain bytes
  instead of rendering in the app's origin.
- **Share links** are HMAC-signed and expiring (secret:
  `~/.starts-agents/share-secret`). A package link grants download of
  exactly one file until expiry — treat it like the file itself.
- **Rate limits** count login failures per IP+account AND per account
  globally; `X-Forwarded-For` is only trusted when `TRUST_PROXY` is
  set. Set `START_AGENTS_ALLOWED_HOSTS` behind odd proxy setups. The
  (IP+account) pair hard-locks after 8 failures (10 minutes); the
  global per-account dimension deliberately does NOT hard-lock —
  that would let anyone lock the real owner out from anywhere — and
  instead applies a progressive delay (from the 5th failure,
  2^(n-4) seconds, capped at 60). Login attempts against unknown
  accounts cost the same password hash as known ones, so response
  timing does not enumerate accounts.
- **Browser tools (SSRF).** `browse_page` / `screenshot_page`
  refuse non-public targets: only http(s), literal private /
  loopback / link-local / reserved IPs are rejected, and hostnames
  are DNS-resolved with ANY private resolution rejecting the URL.
  The fetch reader follows redirects manually (≤5 hops) and
  re-validates every hop. The Chromium path (v0.14 batch 4) is
  driven over CDP with the Fetch domain enabled: every document
  navigation, redirect hop, XHR/fetch and script request is
  intercepted and re-validated with the same rules BEFORE it is
  sent, refused targets never reach the network, and the final
  landed URL is validated once more before the page is read. One
  residual, stated plainly: validation resolves DNS on our side
  while Chromium resolves again at connect time, so a hostile name
  could in principle rebind between validation and connect — the
  tools remain read-only page readers with no session cookies,
  which bounds the blast radius.
- **Audit.** The `audit_log` table in `data/app.db` records tool
  executions (with the executing user) and approval decisions
  (including WHO approved), plus the destructive account/asset
  actions: user deletion (with cascade counts), bot and provider
  creation / update / deletion (provider updates mark key changes),
  self-service password changes and session revocations; rows
  older than `SA_AUDIT_KEEP_DAYS` (default 90) are pruned at
  startup. Secret-shaped strings (Bearer
  tokens, `sk-…` keys, `api_key=…`, GitHub tokens, `Authorization:`
  headers of any scheme, JWTs, and credential URL parameters like
  `?token=…`) are redacted before writing. Since v0.14 batch 3 the
  shape list also covers Telegram bot tokens, PEM private-key
  blocks, AWS `AKIA…` key ids and `gho_` tokens, object keys are
  redacted as well as values, and redaction runs as a single
  combined-regex pass (the old per-shape pass could write match
  offsets into the log). Reading the audit log
  through the API is owner-only.

## Known boundaries (by design, stated plainly)

- **The `claude-cli` engine runs outside the tool/approval system.**
  It spawns the local `claude` binary with its prompt as a
  command-line argument (visible in the process list), and the
  CLI's own tools execute as the server OS user. Since v0.14
  batch 4 the blast radius is fenced: the process runs with
  `cwd` = the bot's workspace and the sandbox environment
  whitelist (server secrets — vault master key included — are NOT
  inherited), and the engine is refused at bot create, bot update
  and chat execution for any bot whose owner is not a site owner
  (`errClaudeOwnerOnly`). A determined prompt can still ask the
  CLI to walk out of its workspace — that is why the engine is
  owner-only. The API engine with approval cards is the supervised
  path.
- **Approvals protect against the model, not against a person with
  an owner account.** An owner can approve anything. Protect owner
  credentials like root passwords.
- **No region/geography blocking exists in this application, by
  design, and none will be added.** If your reverse proxy or CDN adds
  some, that is your layer, not the app's.
- The store is single-process by design and now enforces it: the
  server takes a single-instance lock (`data/app.lock`) at startup
  and a second process against the same `data/` directory refuses
  to start. Run exactly one instance (pm2 `-i 1`). Sessions are
  stored as SHA-256 hashes of the session id, so a leaked database
  does not leak usable sessions.
- **Turnstile is optional in code but mandatory in production.**
  Human verification only engages when both
  `START_AGENTS_TURNSTILE_SITE_KEY` and `START_AGENTS_TURNSTILE_SECRET`
  are set; a public multi-user deployment without them leaves login,
  registration and code-sending guarded by rate limits and failure
  lockouts alone. Configure it before exposing the instance.

## Reporting

This is a self-hosted open-source project: if you find a vulnerability
in your own deployment, fix or report it via the repository's issue
tracker. Do not post live credentials or tokens in issues.
