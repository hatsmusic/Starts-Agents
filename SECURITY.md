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
  the port. A corrupt `data/auth.json` or `data/state.json` also
  fails closed (a forensic copy is kept as `*.corrupt-*`); nothing
  silently resets to empty.
- **Roles.** Owners administer accounts, providers and bots. Members
  can chat with bots. Shell approvals are owner-only, and an approval
  can be decided only by the user who started the run or by an owner.
- **"Allow all this session"** is scoped to the granting user + bot +
  tool and expires after 30 minutes; it never survives a restart.
- **"Always allow" (v0.12, explicit product direction)** supersedes
  the v0.8 session-only stance: a persistent grant scoped to the
  granting user + bot + tool, stored in `data/state.json`, audited
  when granted and when used, listed and revocable under Settings.
  It IS available for `run_shell` — the operator accepted that trade
  deliberately; the grant still only ever covers one user's own bot,
  and shell approvals remain owner-only to DECIDE.
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
- **Preview.** Workspace web projects can be previewed (and shared
  via signed links) only under a sandbox CSP without
  `allow-same-origin`: previewed pages get an opaque origin and can
  never reach the app's session or APIs.
- **Workspaces.** File tools are confined to `data/projects/<botId>/`
  with symlink (realpath) checks on every path, including search and
  packaging. Deployment packages automatically exclude `.env*`, key
  material, credential stores and similar files, and report what was
  excluded.
- **The shell is a host shell.** `run_shell` runs as the OS user of
  the server process. Its environment is a whitelist (PATH/HOME/
  locale only — server secrets are not inherited), it has a 120s
  timeout, and its process group is killed on Stop. It is NOT a
  sandbox or a container: anyone who can get a shell command approved
  can do anything that OS user can do. Run the service as a dedicated
  unprivileged user, and treat owner accounts accordingly.
- **The vault.** Provider API keys are AES-256-GCM encrypted. The
  master key comes from `START_AGENTS_MASTER_KEY` or
  `~/.starts-agents/vault.key` (0600) — deliberately outside `data/`,
  so a workspace escape cannot read it. Rotate with
  `scripts/rekey.mjs` (server stopped). A key that no longer decrypts
  surfaces as an explicit error in chat; it is never silently replaced
  by a fallback key. The environment-configured key
  (`START_AGENTS_AI_API_KEY`) is used ONLY for bots with no provider
  of their own.
- **Uploaded/generated files** are served with a sandbox CSP and
  `nosniff`; active types (HTML/SVG/JS/PDF…) download as plain bytes
  instead of rendering in the app's origin.
- **Share links** are HMAC-signed and expiring (secret:
  `~/.starts-agents/share-secret`). A package link grants download of
  exactly one file until expiry — treat it like the file itself.
- **Rate limits** count login failures per IP+account AND per account
  globally; `X-Forwarded-For` is only trusted when `TRUST_PROXY` is
  set. Set `START_AGENTS_ALLOWED_HOSTS` behind odd proxy setups.
- **Audit.** `data/audit.log` records tool executions and approval
  decisions (including WHO approved). Secret-shaped strings (Bearer
  tokens, `sk-…` keys, `api_key=…`) are redacted before writing.

## Known boundaries (by design, stated plainly)

- **The `claude-cli` engine runs outside the tool/approval system.**
  It spawns the local `claude` binary with the server user's full
  environment and its prompt as a command-line argument (visible in
  the process list). Only enable Claude Code on machines where that
  is acceptable; the API engine with approval cards is the supervised
  path.
- **Approvals protect against the model, not against a person with
  an owner account.** An owner can approve anything. Protect owner
  credentials like root passwords.
- **No region/geography blocking exists in this application, by
  design, and none will be added.** If your reverse proxy or CDN adds
  some, that is your layer, not the app's.
- The JSON file store is single-process by design. Do not run two
  instances against one `data/` directory.

## Reporting

This is a self-hosted open-source project: if you find a vulnerability
in your own deployment, fix or report it via the repository's issue
tracker. Do not post live credentials or tokens in issues.
