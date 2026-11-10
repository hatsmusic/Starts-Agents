# Changelog

## v0.19.3 — 2026-11-10 (item 151: the product is renamed — Complay Ai is now Bot Work)

- **Every user-facing product name now reads "Bot Work".** The
  PWA manifest (name / short_name / description), the page title
  and apple-mobile-web-app-title, the lock-screen name, the top
  brand line, the settings-sheet version footer ("Bot Work
  v0.19.3"), the shared-link landing pages (title, description,
  og:site_name, "Open in Bot Work"), the verification-code email
  subjects and the example SMTP sender name. The fallback
  assistant avatar now initials "Bot Work" too.
- **What deliberately did not change.** "Sign in with Complay"
  (all 15 languages) names the egame.dev account system you sign
  in *with*, not this product — like "Sign in with Google" — so
  it stays. Historical changelog/readme entries keep the old
  name, as history. Existing home-screen icons keep their old
  label — iOS snapshots the name at install time; delete and
  re-add the icon to pick up "Bot Work".
- **New logo (item 152, same release).** The supplied black-tile
  ribbon mark replaces the "C" tile everywhere the Agent logo
  appears: the app icon (PWA manifest 512/192 + padded maskable,
  apple-touch-icon, favicons), the lock screen, the default bot
  avatar, and the share-landing card. complay-c.svg is retired
  from this product; the main site's own "C" brand assets are a
  different surface and are untouched.

## v0.19.2 — 2026-11-10 (item 150: model capabilities are measured, and upstream errors speak plainly)

- **A model that cannot call tools now chats instead of dying.**
  The agent loop sent the full tool set to every model on every
  round, so a bot switched to a tool-less local model (codegemma
  being the reported case) failed the whole turn with a raw 400.
  Capabilities are now measured where they live — Ollama's
  `/api/show`, cached — and drive the whole chain: picking such a
  model warns at bind time and on every switch surface ("chat
  only"), and a turn on it runs as plain chat with a one-line
  disclosure in the conversation. If a model's capabilities were
  never measured (any OpenAI-compatible endpoint), a tools-shaped
  400 makes the engine strip the tools and retry that request
  once — no other 400 is retried, and the degradation is always
  announced, never silent.
- **Embedding models can no longer be picked as chat models.**
  They are filtered out of the bot-editor and volunteer pickers,
  refused at "Use" and before a turn starts, in plain words —
  previously they could be set in three places and then failed
  every conversation, provider-wide.
- **Upstream errors are mapped, not dumped.** The engine used to
  paste the provider's raw response body into the error card
  ("AI endpoint returned 400: {…}"). Every upstream failure now
  carries a stable code — key rejected, model not found, context
  too long, bad request, provider fault, timeout, unreachable —
  rendered as a localized sentence in all 15 languages, with at
  most a short scrubbed technical tail. Retry exhaustion no
  longer calls a 500 a "rate limit", a local 500 is retried at
  most once (no more hammering an out-of-memory Ollama), LAN
  endpoints without a key are no longer refused, and the delete /
  pull / provider-test surfaces report failures the same way.

## v0.19.1 — 2026-11-10 (hotfix, item 149: a bound provider outranks the demo engine)

- **Bots bound to a provider no longer answer with the offline demo
  engine.** A bot's engine and its provider binding were separate
  fields and could diverge — most easily on a NEW bot, whose engine
  dropdown defaulted to echo while its provider dropdown preselected
  the account's default provider (for many, the local Ollama). The
  header chip advertised the provider's model; every turn silently
  ran echo. The rule now, enforced at every read and write: a
  provider binding outranks the demo engine (`effectiveEngine`) —
  bot create/update normalize the stored pair, and turn resolution
  repairs stock diverged records in place, no rebuild needed. Echo
  remains reachable only for providerless bots. The bot editor
  flips the engine visibly when a provider is bound.
- **Local providers fail out loud, never sideways.** A turn bound to
  a local provider (the system Ollama above all) now probes the
  endpoint once before running: unreachable, or the wanted model
  not downloaded, produces a plain in-chat explanation in the UI
  language — what is broken and where to fix it — instead of a raw
  upstream error (or, in the diverged state, silence). Bot
  create/update run the same check at bind time and return a
  `providerWarning` the client toasts on the spot; the save itself
  still succeeds.

## v0.19.0 — 2026-11-10 (items 147 + 148: our own attach menu, nearly every format)

- **The paperclip opens our menu now (item 147).** The clip used to
  be the file input's label — one tap went straight to the OS picker
  sheet in the system's own dress. It is a button now and opens a
  house sheet with three rows — Photo library / Take photo or video /
  Choose files — each configuring the one shared input for its
  source and clicking it inside the same tap (the input stays
  visually-hidden-but-alive; what the OS shows after the row tap is
  still the platform's own picker, unchanged and unskinned).
- **Attachments take nearly every format (item 148).** The picker's
  extension whitelist (the thing that refused .html) is gone: the
  Files entry passes any type, and the server intake was already
  format-agnostic. Safety moved to the exit, where it belongs —
  scriptable types (html/svg and kin, now including shtml/hta/mht/
  mhtml/svgz/xht) are only ever served as attachment downloads of
  plain bytes with nosniff, images and other safe types keep their
  inline preview, executables are stored as opaque binaries and
  nothing on the server ever runs an upload. Size (10 MB) and count
  (6) limits are unchanged.

## v0.18.0 — 2026-11-10 (item 144: the live browser card + Box seat)

- **The browser card is alive.** The item-130 card (a folded row plus a
  separate screenshot-polling viewer sheet) is replaced by the stage
  card from the 2026-11-10 sketch: expand it in place and the page
  streams in over a WebSocket screencast (CDP frames, adaptive quality
  ladder — frame rate steps down before resolution, with a hard
  legibility floor; fullscreen raises the top tier). Latency and fps
  sit in the card's URL bar.
- **Takeover is the same page, the same connection.** Taking over
  flips a single server-side control fact: the agent's tool calls
  park at a real gate until control is handed back (10-minute honest
  timeout), the agent drives the very page you are watching while it
  holds control, and a dropped connection never steals control back.
  Ended sessions collapse into a history row with a keyframe strip
  (sampled frames only — no full video is recorded).
- **Box is a browser seat.** Bots gain a `browserSeat` setting
  (auto / this machine / Box): cards are stamped with the seat that
  ran them, Box `browser_*` work raises cards too, and a Box card
  watches through the Box live view (read-only token embedded in the
  card, renewed before expiry, with an honest "waking the Box" state
  and a stills fallback when no view tool answers). One active Box
  card session at a time — a second card says who holds it and offers
  to open the page on this machine instead.

## v0.15.5 — 2026-11-09 (items 91–103: concurrency, uploads, vault site logins, connectors, GitHub)

- **Items 91/93 — several bots can work at once, and "busy" tells the truth.**
  The old second gate ("one top-level run per user", a v0.14 anti-abuse
  rule) made a second bot look busy with the *first* bot's run, and the
  busy card's stop-and-resend stopped the wrong run and looped. Run caps
  are now explicit and configurable (SA_MAX_RUNS_PER_USER=3,
  SA_MAX_RUNS_GLOBAL=8; delegated sub-turns borrow the parent's slot),
  the 409 names its scope (bot/user/global) and the run actually
  blocking you, and the busy card stops *that* run. A watchdog reaper
  closes the zombie-lock hole: past 1.5× the wall clock a run is
  aborted, and if the abort still does not settle it, the registry
  entry is identity-checked and removed, the run record ended as
  interrupted, and the reap is audited. Provider 429/5xx now retry
  with exponential backoff (Retry-After honoured) and the wait is
  shown in the turn instead of looking like a hang.
- **Item 92 — attachments upload first, then send.** Files are staged
  through a streaming endpoint (10 MB per file, honest 413, 30-minute
  reusable upload ids) instead of base64-in-JSON, so multi-MB files
  stop dying on body limits; the chat body keeps a legacy path for
  small inline attachments. NOTE: a proxy in front still needs its
  own body limit raised (client_max_body_size) — see README.
- **Item 95 — no more phantom duplicates, no more blanket "network
  error".** Sends carry a client message id end to end (outbox,
  retries, error-card resend); the server dedupes inside a 10-minute
  window and a deduped send never opens a second bubble. The stream
  has a 35 s watchdog: a half-open connection shows a "stalled —
  re-syncing" note and converges from the stored transcript instead
  of falling straight to a network-error card.
- **Item 94 — one turn, one container.** A reply's text, reasoning,
  tool groups, task panel and receipts now live inside a single turn
  container, so process UI can't split the answer or swallow the
  screen; the task panel only auto-folds on real open→closed
  transitions, and the composer measures its height without the
  one-frame collapse that made the caret jump.
- **Item 97 — website logins in the vault.** The vault gains a
  "Website logins" section: site, account, password and an optional
  TOTP seed, stored as one encrypted blob, visible to the bots you
  grant. A granted bot can sign in with the new site_login tool —
  the server fills the form inside a persistent per-bot browser
  profile, checks the domain before navigating and again after
  landing, computes TOTP itself, and asks you for one-time codes
  through an input approval card whose value is never stored or
  logged. Passwords never enter the chat, the model context, or the
  audit trail. Reveal reuses the vault unlock window and is audited.
- **Items 98/99/100 — lists that scale.** The task center groups runs
  by bot (collapsible, remembered); the workspace is a collapsible
  directory tree with basename rows; a provider's model list is a
  searchable combobox on the card, and picking a model makes it the
  default.
- **Items 101/102/103 — connectors & GitHub.** The MCP settings face
  is now called "Connectors" in all 15 languages, and the platform
  Simular Box block is owner-only (the API no longer describes it to
  anyone else). Root can register the platform's GitHub OAuth app in
  Settings → Official connectors (secret is write-only, encrypted;
  SA_GITHUB_CLIENT_ID / SA_GITHUB_CLIENT_SECRET env vars are the
  fallback); with it, the GitHub connector authorizes against the
  pre-registered app instead of dynamic registration, and "Continue
  with GitHub" appears next to Google sign-in under the same gates.
- **Item 96 — test Chromium must actually start.** The CDP test
  harness now smoke-launches each candidate browser before trusting
  it, so a sandbox that kills debug protocols reads as a skip with a
  reason instead of mysterious failures.

## v0.15.4 — 2026-11-09 (items 88 + 89: display hotfix, motion feel)

- **Item 88 — three display defects from production screenshots.**
  (1) In a long transcript, overflow:hidden children of the
  #messages flex column (tool groups, approval cards and their
  receipts) were flex-shrunk to slits — tool groups measured 2px,
  a dismissed-approval receipt 24px with its text outside the
  box. Flex items with non-visible overflow have an automatic
  minimum size of zero; the column now forbids shrinking outright
  (`#messages > * { flex-shrink: 0 }`) and scrolls instead.
  (2) The task strip sat flush on the stream's clip edge and read
  as covering the text — it now keeps an 8px gap below it.
  (3) The roster awaiting-approval card's border doubled on the
  left edge (1px tinted border + an inset 3px band); state cards
  now read from the single tinted border alone.
- **Item 89 — motion feel: one clock per gesture, iOS-paced
  springs, a lighter tap path.** The FLIP roster fade ran on
  #roster's own CSS transition (200/320ms) against the spring —
  renderFlip now drives roster opacity/scale from the same p,
  with the roster frozen as a static layer mid-flight. The sheet
  scrim's CSS fade is gone: --scrim-k from the spring is the only
  driver. View entrances lost their competing CSS animation
  (WAAPI spring samples only). Springs retuned with the solver:
  FLIP 210/27.5 → 360/35.7 with an earlier settle call (0.533s →
  0.371s, t90 0.254s → 0.192s), sheet 380/33 → 520/40 (0.475s →
  ~0.31s full-height), view samples 0.50s → 0.367s. On tap, the
  roster rebuild and the transcript paint defer to the FLIP
  settle frame instead of stalling the spring's rAF mid-flight;
  measured tap → first transformed frame ≈ 6–11ms in the
  acceptance fixture. Frame budgets re-verified at the v0.15.3
  caliber: all five linked motions p95 ≤ 16.8ms, no dropped
  frames beyond a pre-existing single 33ms settings-switch frame
  that reproduces identically on v0.15.3.

## v0.15.3 — 2026-11-09 (item 86: linked-motion polish)

- **Item 86 — the linked motions get real inertia.** v0.15.2's
  sheet, drawer drag, FLIP container transform and swipe cards
  each ran on their own fixed CSS clock: a drag release restarted
  its snap-back from zero velocity, mid-flight reversals jumped,
  and pointermove wrote styles per event. All physically-linked
  motion now runs on ONE damped-spring integrator
  (`SPRING_PARAMS` in `public/ui-utils.js`, a single shared rAF
  driver in `app.js`): the release spring starts at the finger's
  actual frame-EMA velocity, the FLIP spring retargets in place
  when the back button lands mid-flight, sheet entry/exit share
  the drag's spring state, drag writes are rAF-batched (one
  style write per frame, transform and scrim in the same frame),
  and view entrances are the same spring sampled into WAAPI
  keyframes. Small feedback (press, ripple, badge) keeps its
  short CSS curves. No layout, copy or behaviour changes.

## v0.15.2 — 2026-11-09 (items 75/76 display + MCP fixes, items 78/79/80, full-platform OA sweep)

- **Item 75 — toolchain display truth**: python-data now declares
  and exposes `pip3`, so the settings probe sees the venv's pip
  (installed → "ready · via module"; not installed → "Module
  download" instead of the misleading "Not installed"). The Zip
  row is gone: packaging is the pure-JS zip writer, the system
  binary was never used.
- **Item 76**: `package.json` gains a `files` whitelist (npm pack
  can no longer sweep `data/` into a tarball); the Simular Box
  endpoint is `config.platformBoxUrl` (env `SA_PLATFORM_BOX_URL`,
  same default), referenced by both the MCP preset and the
  auto-created platform server; UI tests share one Chromium
  discovery helper (`test/chromium.mjs`, incl. PATH lookup) and
  the README documents how to run the suite.
- **Item 78 — tool rows**: consecutive tool calls collapse into
  one grouped frame with a count header (receipts stay standalone,
  groups never span intervening text), and `run_shell` rows now
  carry a concrete human summary ("List uploads folder",
  "Run tests", …) derived client-side; bare commands and absolute
  paths never reach the row face.
- **Item 79 — account Sheet & bot profile re-aligned to the
  re-issued frames**: bare icons (no tiles), circular identity
  avatar, muted switch link, usage block rebuilt to the frame
  (inline icon + numbers line + policy line, big % at the right,
  thin tier bar), a "Notifications & appearance" section caption,
  font-size row as a text value, logout as bare red text; profile
  regains its notification hint line and the sandbox row loses
  its stray chevron.
- **Item 80 — motion**: the three-site motion language lands on
  SA (spring curve + duration tokens): sheet exit animation,
  view-enter rises, receipt pop, press feedback, roster skeleton
  shimmer, animated tool-detail expansion. Transform/opacity
  only, no animated numbers, full reduced-motion coverage.
- **Item 80 revision — the v7 motion sketch**: tokens converge
  to one set (--e-out/--e-spring/--e-inout, --t-fast/base/slow/
  page). Card-to-chat container transform (FLIP out of the
  tapped card, back along the same path); approval decisions
  ripple from the tap point, collapse in height, and slide the
  receipt in; tool rows run with a light sweep + live elapsed
  timer and settle with a check pop; streamed text fades in per
  chunk behind a blinking cursor; send/stop swap in one slot;
  dock icons lift with a travelling glow bar; a slash-command
  panel (/model /mcp /clear /stop) rises from the composer and
  stages a removable chip; sheets follow the drag handle with
  rubber-band resistance and velocity-aware dismissal.
  Elevation tiers (--ele1/2/3), panel top highlight, gradient
  discipline, tabular numerals throughout.
- **Item 82 — tool kills, classified and fixed**: exec timeouts
  were indistinguishable silent deaths (`exit -1`). Command
  termination is now a ladder (SIGTERM, grace, SIGKILL) with a
  /proc descendant snapshot swept alongside the process group
  (in-process setsid escapees included), results name their
  cause (timed out after Ns / stopped by user / wall-clock
  limit / killed by SIGNAL), backgrounded pipe-holders no
  longer stall a call past its leader's exit, run_python gets
  the same ulimit discipline as run_shell, the run's abort
  signal reaches in-flight MCP calls, LAN inference endpoints
  get the local cold-start budget, module installs get a
  20-minute phase-labelled budget, and the approval TTL is a
  config value whose timeout no longer reports as a user
  denial. Six repro-paired tests pin the classes.
- **Item 83 — de-sensitization for sharing**: one scrub module
  (src/scrub.js) serves every output surface — tool results
  are scrubbed before the model feed for everyone; stored
  replies are scrubbed at rest; live views, history reads,
  exports, run errors and error text are scrubbed for every
  non-site-owner viewer (paths relativized or tokenized,
  internal hosts, stack frames, id tokens, config names),
  while the site owner keeps full fidelity live. Seed corpus
  pins both directions (sensitive strings scrubbed, legitimate
  content untouched), profile/roster/provider serializers drop
  wiring identifiers for strangers, and the client mirrors the
  light rules on legacy surfaces.
- **Item 84 — external-audit residue, verified live**: a
  member-vs-owner isolation probe across every surface
  (conversation mutations, files, workspace, long-term memory,
  vault, providers, MCP servers, grants, usage, audit,
  approval decisions) confirms the fences hold; the one
  surface that looked open — reading a shared bot's history —
  is shared BY DESIGN (v0.14 batch-1 ruling, test-pinned),
  while its export/clear/truncate stay owner-gated. Per-turn
  tool-schema injection measured (<44KB worst plausible case)
  and budgeted in tests; MCP session/cache cleanup and the
  runaway caps (25 rounds, delegation depth 2, daily token
  cap) re-verified; audit rows are insert-only with no
  mutating route (hash-chain tamper evidence logged as a P2
  recommendation).
- **Item 81 — vault becomes a credential library**: the entry
  list (names, last-4, bot badges) is readable without
  unlocking — bots always used credentials server-side; only
  revealing/copying plaintext (and rotating) asks for the
  account password, opens a short window (status carries the
  expiry; the UI shows the countdown and wipes revealed text
  on relock), and is audit-logged by entry id. Encryption
  (AES-256-GCM key ring) is unchanged.
- **OA sweep (item 77)**: three-way audit (frontend / backend
  core / capability layer) — 0 P0; every P1 fixed: a cleared-chat
  crash (`renderMessages` ghost call), missing MCP error strings
  in all 15 languages (+ a dictionary closure test), MCP redirect
  SSRF re-validation with Authorization stripping, OAuth discovery
  endpoints forced to https, shell path-classifier bypasses
  (`--opt=/path` values, glob-laundered sensitive names), a
  memory-sedimentation watermark bug, toolchain probes scrubbed
  of the server environment, multimodal local models (Gemma 3/4,
  Llama 4) no longer hard-judged blind, long-conversation render
  reworked to fragment batches with poll guards, identity-column
  unique indexes (migration v6), transactional user deletion,
  upstream fetches given hard timeouts, and the error handler no
  longer double-writes or leaks internals on 5xx. Plus a P2 tail:
  SW cache restricted to the app shell, version assertions made
  parse-based, vault key-file read failures fail loud instead of
  silently rotating, boot trial-decrypt extended to MCP/Box
  secrets, ownership migration settled-flag, streaming renders
  incrementally. P2 items not taken are listed with reasons in
  the batch progress file.

## v0.15.1 — 2026-11-09 (item 71 UI re-alignment + item 70 verification + item 73 approval slimming)

- **Every screen re-aligned to the v6 eight-frame sketch set**,
  item by item (50-entry frame diff on file). Team page: cards are
  three rows again (the stray absolute-time row is gone), the
  AGENT WORKSPACE caption row is gone. Account sheet: bare form
  (no title bar), identity carries a plain 切换 link, today's-usage
  block reordered to the frame (title + big % / numbers line /
  policy note / tier bar last), no sandbox row in the sheet, logout
  without a chevron, and a centred "Complay · Ai v0.15.1" footer
  (version read from /api/health). Chat head: one single-line
  capsule (avatar + name + ▾); edit/package/export/clear moved into
  a ··· menu wired to the same handlers. Task strip is an inset
  rounded bar with a check-circle glyph and an Expand/Collapse word
  button; tasksEnded no longer carries its own {done}/{total} in
  any of the 15 languages (it double-printed next to tasksBar).
  Tool rows are full-width solid rows with the view pill at the
  right. Attachment chips show the file size; the queue strip is
  one summary line that unfolds on tap. Bot profile: outline /
  gradient action pills, raw model id in parentheses when it
  differs from the friendly name, the three stats in one divided
  card, two-line workspace/sandbox rows (module names as the sub,
  readiness in the status slot), no hint under 任务通知, and the
  page owns the screen (no app header, no tab bar). Avatar sheet:
  a "current: …" line, pure colour preset swatches, and the letter
  row as one preview tile + colour dots. Vault: key icons lead the
  entries, outline rotate pills, two equal full-width actions.
- **Composer copied from the sketch verbatim** (the one surface
  with a direct-copy mandate): a single frosted rounded bar —
  attachment button inside left, borderless input, gradient round
  send button, red round stop button in the same slot.
- **Approval cards slimmed (item 73).** Every terminal path —
  allow, session-allow, always, deny, dismiss, decided elsewhere,
  expired, run stopped — now converges to a ONE-LINE receipt
  (frame ⑧C form): tool + outcome; summary, chips and the
  still-ticking countdown chip all leave the card. Tapping the
  receipt reopens the detail read-only; its ✕ removes it for good.
  Pending cards: buttons tightened to ~44px, the ✕ is a plain
  glyph, and the deny-reason input is no longer resident — the
  first Deny tap arms the button («确认拒绝») and unfolds the
  reason row, the second submits.
- **Item 70 verified against the code, mostly NOT missing.**
  Vision input, OCR (tesseract), PDF text (pdftotext), and local
  image processing (ImageMagick/ffmpeg/PIL) all exist as
  module-gated harness tools; the bot reported them missing
  because they never appear as shell CLIs — same false negative as
  the headless browser in item 59. Production bots "can't see
  images" because the configured models (qwen2.5-coder:1.5b,
  DeepSeek) have no vision input; vision-capable models pass
  images through per engine. Real gaps fixed: the bot protocol now
  points at the workspace notes/ directory as the persistent
  cross-session memory, and ask_teammate's description now carries
  the live delegable roster (any same-site bot, depth cap 2 and
  the shared run budget unchanged). Package installs still ask —
  that is the standing approval ruling, unchanged.


## v0.15.0 — 2026-11-09 (item 58 MCP batch + items 60/62/64/67/69)

- **MCP: bots can use external tool servers.** A general MCP client
  (Streamable HTTP, JSON + SSE replies, session-id passthrough)
  connects any MCP server; its tools appear as `mcp__<slug>__<tool>`
  with their real parameter schemas. Token/header auth and full
  OAuth (authorization code + PKCE S256 + dynamic registration,
  endpoints discovered, refresh tokens vault-sealed). Server-driven
  sampling/elicitation/roots are refused (-32601). Settings gains an
  "MCP servers" card: a platform Simular Box section (owner-set
  global key, vault-sealed, per-user metering via audit) plus
  per-user servers with test/enable/delete. Box BYO mode rides the
  same OAuth flow.
- **MCP approval discipline.** External tools always ask, never get
  permanent grants; exec-class tools (shell/computer/gui…) are
  owner-only, high-risk cards, session grants at most — same tier
  as run_shell. Other MCP tools may be allowed for the session.
  Results are wrapped as untrusted data; any successful MCP call
  taints the turn. A dead server can no longer stall a turn:
  tool lists are probed in parallel with a 12s per-request cap
  (regression-tested against a blackhole server).
- **P0: the read-only shell fast lane is path-aware.** Auto-approval
  used to look only at the verb, so `cat` could read the vault key,
  the database, or another bot's workspace with no card at all, and
  the card labelled it low risk. Grading now weighs paths (sensitive
  targets force high + always ask; outside-workspace is never low),
  and the executor hard-refuses sensitive paths even when a call
  was approved.
- **Item 62: venv shebang root-cause fix.** Module installs move in
  three rollback-safe steps; after the move, every console script's
  shebang and activate's VIRTUAL_ENV are rewritten at the final
  path and verified for real (imports + running pip itself +
  sys.prefix) before the install-complete marker is written.
  Probing covers the CLI dimension; stock modules get a graded
  boot-time repair (shebang-only damage fixed in place, worse only
  flagged). Modules can now be uninstalled and upgraded.
- **Items 60/64: chat page.** Bot-switch capsule, collapsible task
  bar, tool rows show a one-line human summary (action · target;
  raw commands and absolute paths never appear — full redacted
  parameters live behind View), approval cards render the taint
  warning, deny can carry a one-line reason back to the model.
  No command preview box, per ruling.
- **Item 69: models.** The local-model catalog grew 95 → 107, each
  entry verified against the Ollama registry (dead names left out);
  provider model fields are now searchable comboboxes with manual
  entry — no native `<select>` remains anywhere.
- **Item 67: consumer-grade sweep (P0/P1 all fixed, P2 20 of 22).**
  Bounded history window with a compaction marker (450-message
  regression test); conversations can be cleared, truncated and
  exported (md/json); backups verify integrity, keep two tracks
  and can mirror to a second directory; members get a working
  first-run guide; server notices are localized in all 15
  languages; accounts can export their data and self-delete
  (typed-name confirm; the last owner cannot); shell timeout is
  adjustable; the 25-round cap now ends with a summary instead of
  silence; drafts are per-bot; opening a running bot live-refreshes;
  audit viewer filters + CSV export; optional alert webhook;
  per-device "sign out other devices"; registration follows mail
  capability; usage "today" follows the instance timezone; a UI
  main-chain smoke test joins the suite. Not done, by decision:
  off-site completion notifications (Telegram work is parked) and
  money-denominated usage (pricing is a product decision; metering
  hooks are in).
- Schema migration v5 (mcp_servers). Tests: 255 total, all green
  serially, including new MCP unit/HTTP/end-to-end suites.

## v0.14.4 — 2026-11-08 (items 55+56: chat pane P0 + frame alignment)

- **P0: the chat pane is visible again on phones.** Item 46's neutral
  chat restyle added `#chatPane { position: relative }` after the
  mobile media query's `position: fixed`; equal specificity meant the
  later rule won, so on phones the pane collapsed to a 0-wide strip —
  taps entered the chat (state switched, messages rendered) into a
  pane nobody could see. The cascade is fixed and a CDP regression
  test (pane geometry, drift taps, toxic transcripts) guards it.
- **Taps stop getting eaten.** The bot-card swipe threshold was 9px,
  so ordinary finger drift — and taps after pointercancel — were
  swallowed as swipes. Threshold is now 24px and the swiped flag only
  sets when the card truly opens or moves ≥40px.
- **Chat robustness.** A stored message with a null attachment entry
  crashed transcript rendering mid-list (now guarded per message);
  selectBot validates the current bot after its await (no more
  cross-bot message bleed); opening a bot profile from chat leaves
  chat mode so the profile is no longer trapped under the pane;
  a failed initial roster load no longer leaves the shell unbound.
- **Bottom clearance.** `#roster.view`'s padding shorthand was
  silently overriding .page-pad's tab-bar clearance (computed 12px
  instead of ~94px; last rows permanently under the floating bar).
  Restored for every roster view.
- **Frame alignment (item 55).** Top bar: account avatar + wordmark
  left, language/theme/new round buttons right. Usage numbers are
  compact everywhere (160M / 500M) with a large percentage in the
  account sheet. Bot cards: provider · friendly model name (protocol
  prefixes and raw ids no longer shown), dot + text status instead
  of pills, single-row workspace card. Account sheet gains working
  Permissions & approvals and Theme rows. Bot profile token total
  now reads the real figure (was always 0).

## v0.14.3 — 2026-11-08 (hotfix: item 54 — one account per device)

- **One signed-in account per device.** A random device-id cookie
  (`sa_did`, long-lived, httpOnly) now names the browser; sessions
  record it (migration v4). Every sign-in path — password, first
  and public registration, main-site SSO and social sign-in, the
  legacy access-token channel — mints its session through the one
  issuance point, which first revokes every other session on the
  same device, whichever account it belongs to. A second device is
  never touched; sessions that predate the cookie carry no device
  id and are never retroactively revoked — they expire on their own
  TTL. Clients arriving without the cookie are issued one on their
  sign-in response and fall under the rule from that moment.
- **The fake account switcher is gone.** The account sheet /
  settings identity row no longer opens a panel pretending other
  accounts coexist on the device. It now offers "Sign in with
  another account" (new i18n key, all 15 languages), which signs
  this device out to the lock screen behind the usual confirmation;
  the next sign-in there is the device's one session.

## v0.14.2 — 2026-11-08 (feedback-list batch: items 43–53 + Grok-borrow P1)

The site-line batch from the Grok Bot UI study: an account sheet,
a bot profile page, custom avatars, a neutral conversation with
light/dark themes, a glass composer — plus the two live bug
reports that arrived mid-batch (task checklists that never
finished, in-chat previews that showed source instead of pages).

- **Account sheet** (items 1–4). Tapping your avatar on the team
  page raises a bottom sheet — identity with the account switcher,
  one-line usage with a thin bar, the vault up front with a
  plain-words subtitle, sandbox/modules, the Bots group
  (permissions), notifications, theme, logout. The settings page
  account card renders the SAME rows from the same function
  (renderAccountRows). Management rows (vault, modules) render
  only for the owner role — absent for members, not greyed.
  Usage bars turn amber at ≥85% and red over quota, in both
  places. All bottom sheets cap at 82dvh with the page visible
  above (item 48).
- **Bot profile page** (item 5). Big avatar, provider/model,
  message/run/workspace stats, config card and action rows,
  served by GET /api/bots/:id/profile from the store's own
  numbers. Entries: chat header tap and the roster card menu.
- **Custom avatars** (item 44). One mechanism for bots and
  accounts: {kind: image|preset|letter, value} in a new SQLite
  column (migration v3). Uploads are PNG/JPEG/WebP ≤2MB,
  validated by magic bytes, stored under unguessable names in
  data/avatars/ and served only behind the session gate; 8 CSS
  gradient presets and 8 letter colours render client-side from
  GET /api/avatars/meta. Old data falls back to the C tile
  (bots) or a name-coloured initial (accounts).
- **Neutral chat + themes** (item 46). The conversation drops
  the brand: AI text sits flat on a neutral ground, the user
  bubble is neutral grey, the send button is monochrome
  (white-on-dark / black-on-light); approval cards keep their
  amber semantics on a neutral base. A full light theme joins
  the dark one behind data-theme, persisted per device,
  defaulting to the system preference; the only controls are
  the top-bar moon button and the theme row in the sheet /
  settings.
- **Glass composer** (item 47). The composer floats over the
  transcript on backdrop blur(14px) saturate(1.4); the message
  list's bottom padding tracks the dock's measured height
  + 24px, so the last card always scrolls clear.
- **Task checklists converge** (item 49). Root cause: the list
  was only ever written by the model's update_tasks call and
  the run lifecycle never reconciled it — a run ending on a
  text summary (or dying) left items open forever, and the
  strip only refreshed on 'tasks' frames. Task items now carry
  a state (done/open/cancelled); every run end closes its open
  items (done on success, cancelled otherwise), a boot sweep
  closes fossils from dead processes, untouched lists are left
  byte-identical, and the roster payload re-renders the strip.
- **In-chat previews work** (item 50). Root cause: the plumbing
  was fine (preview/files/file-view verified live); the break
  was presentational — the only in-chat "view" showed HTML as
  raw source, Markdown unrendered, zips as "no preview", and
  the rendered preview had no entry from the conversation.
  The viewer now dispatches on the server's verdict (file-view
  gained name/ext and a real zip listing): HTML renders in a
  sandboxed frame with a source toggle and fullscreen handoff,
  Markdown renders, and files a bot writes appear in the flow
  as preview cards (live thumbnail / image / excerpt / info).
- **Approval cards speak plain language** (item 51). The card
  payload is now a structured summary `{action, target, impact}`
  — action/impact are client i18n keys (17 new keys × 15
  languages), target is one plain data string (a file path, the
  workspace name) — plus a `tainted` flag. Raw arguments, diffs
  and command strings no longer ride the card at all; they stay
  in the audit log's tool rows, unchanged (`explainCall` is
  gone). And provably read-only shell calls skip the card:
  `isReadOnlyShell` in risk.js passes a single simple command
  only under a strict allowlist (unzip needs -l/-t, tar needs
  -t, `git branch` is listing-only, find carries no write
  tokens, env prefixes are re-judged; any metacharacter, pipe,
  redirect, chain or substitution still asks) and audits the
  pass as `auto_readonly`.
- **Team page to the final design** (items 52/53). The five
  status filters were already the production set (offline =
  engine unavailable / no provider, from botStatus); the roster
  gained the summary line ("{waiting} waiting · {running}
  running · {total}"), relative last-activity on the meta line,
  a live elapsed clock on running cards (from the new runSince
  roster field, refreshed on the existing 6s poll), a
  "go approve {n}" pill that lands on the first pending card,
  and the team tab badge — one count (server pendingApprovals,
  muted bots excluded) feeding pill, summary and badge. Bot
  avatars render as squircles; account avatars stay round.
- **Sheet, second pass** (items 52-8/52-9, 53). Usage gains the
  tier-ladder ticks (the ladder doubles from the 500M base, so
  the previous steps sit at 25%/50% of the bar) and a policy
  line written from the server's own config: next step, and the
  real over-quota rule — the design said "over quota switches
  to local models", the code does no such thing: owners are
  exempt, members hard-stop at the config daily cap (default
  20M, SA_DAILY_TOKEN_CAP) with a 429. The vault row opens the
  new vault page and counts the real entries; the grants row
  states the standing rule that shell is never always-allowed;
  a "More settings ›" row closes the sheet into Settings; sign
  out now asks first.
- **Approval cards, second pass** (item 53). Title + human
  summary + chips (risk band, scope, auto-deny countdown from
  the broker's 5-minute window) + a diff STAT line for file
  writes (counts only — the item-51 ruling stands: no raw
  command, no diff text) + two button rows. The shell tool
  loses the persistent grant entirely: its button renders
  disabled with the reason, and the server refuses to store
  a shell grant even if asked (run_python keeps its shipped
  grant path — the design's "shell class" is the shell). The three states are all wired: submit
  failure keeps the card with buttons restored and the real
  reason (pre-existing), a vanished card greys out as expired
  (sync + countdown), decided cards resolve as before.
- **Chat records** (item 53). Tool calls collapse to one-line
  activity rows (name · object · status dot) whose View button
  opens the full record (arguments + result, display-redacted)
  in a sheet; results join their call's row instead of piling
  up as separate blocks. The task strip's collapsed form is
  the design's "Tasks {done}/{total} · {current step}".
- **Bot profile, second pass** (item 53). Stats are now
  all-time tokens / workspace files / current checklist
  progress (em dash when no list). Rows: this bot's workspace
  with its size, the sandbox computer with module names and
  readiness, a config group — task-notification mute (new
  per-bot flag; in-site effect only: muted bots stop raising
  the roster's waiting signals; no external channel added),
  the running-model row into the bot editor, team-pack export.
  No scheduled-task row (P2, unbuilt — no fake door), and the
  avatar page offers upload/preset/letter only: avatar
  generation was cut by ruling before any code was written.
- **Vault page** (item 53, new). First UI for the vault: its
  entries are the provider credentials (the only secrets this
  system seals — stated plainly in the report), each showing
  last-4 only and the bots running on it. Unlock re-uses the
  account password check (no PIN exists here), held server-
  side per session for 5 sliding minutes with a client idle
  timer racing it; rotation re-seals through the vault and
  audits by id/label only; lock-now and add-key (into the
  provider form) complete the page.
- **Empty roster state** with its own create entry, and the
  online pill verified under both themes.

## v0.14.1 — 2026-11-08 (feedback-list batch: items 31–41)

The fix batch for the second half of the 2026-11-08 feedback
checklist — rendering and roster bugs, the account-panel
integration, the python-venv precheck, and the volunteer program
reshaped to its v3 form. Item 33 (already fixed in v0.14) was
re-verified, items 34/38 re-checked against the new tab bar.

- **Markdown tables render whole again** (item 35). The renderer
  moved to `public/ui-utils.js` and now restores lifted code/table
  placeholders iteratively — inline code inside a table cell used
  to surface as numbered squares on iOS. Tables size to content
  and scroll inside their wrapper; message columns can shrink.
- **Provider model chips are windowed** (item 31). A provider card
  shows at most 12 model chips with a show-all toggle, so a pulled
  catalog of hundreds no longer buries the edit/delete actions;
  the model editor gained a prune bar (filter, keep-default-only,
  clear, mark-and-delete).
- **Sandbox badges hold their shape** (item 40). Status badges in
  the sandbox/module rows have a fixed lane and never wrap into a
  vertical pill; long version strings ellipsize with a tooltip.
- **The roster follows live runs** (item 36). The team view polls
  bot status even while a run is parked on an approval, entering
  the team view refreshes it, and delegated sub-turns report
  awaiting_approval to the roster.
- **The floating tab bar matches the main site** (item 41). Height
  72→58px with the main site's exact geometry (4px 10px padding,
  34px radius, 12px bottom offset, 48px tabs, 24px icons, gradient
  active pill, no raised center circle). The settings occlusion
  family (items 34/38) re-verified: every view keeps the padded
  clearance under the smaller bar.
- **Account panel integration** (item 37). The account card now
  hosts, in place: my usage (today + all-time from per-account
  rows, `/api/usage` gained a `mine` field), the downloaded local
  models (use/delete in place for owners, download entry jumping
  to the full card), and module status with in-place install.
  Admin functions sit below a dashed divider with an "Admin" tag
  so personal and management surfaces never blur. Sessions record
  the real client (first X-Forwarded-For hop behind the loopback
  proxy) plus a device summary like "iPhone · Safari" — schema
  migration v2 adds `sessions.ua`.
- **python-data precheck** (item 32, follow-up). Modules may carry
  a precheck; python-data probes `import ensurepip, venv` (the
  missing python3-venv discriminator). A failing host fails the
  install immediately with a stable code, the module list surfaces
  the verdict, and the UI renders the plain-language fix
  (`sudo apt install -y python3-venv`) before and after an attempt.
- **Volunteer program v3** (item 39). Pure volunteering — no pay,
  no duties — whose one immediate unlock is developing with more
  local models. Copy red line enforced: all 15 locales' `volDesc`
  rewritten, `volJoined` shows only the join date, and no
  quota/reward wording remains in volunteer surfaces. Layer 1: a
  per-user pick over downloaded platform models, plus a per-bot
  local-model override that takes effect while the bot's owner is
  a volunteer. Layer 2: volunteers may register up to 3
  bring-your-own endpoints (flagged provider records they own,
  public addresses only) and pick one for their turns; those turns
  are served by their own hardware, accounted under `userprov`,
  and never charged to the daily token cap. Leaving — or owner
  removal from the account list — revokes the pick and deletes
  the endpoints; the account itself is untouched.
- **Item 33 re-verified** (F): the v0.14 context window (anchors +
  compression marker, not a bare slice), untrusted-content
  boundary wrapping, and the shared run budget / daily hard cap
  all still pass their regression suites.

## v0.14.0 — 2026-11-08 (full-audit fix release)

The fix release for the 2026-11-08 full audit (2 P0 + 25 P1,
graded at large-platform scale) and the feedback-checklist items
that rode along: six batches — isolation stop-loss, cost gates,
trust boundary, execution surface, the SQLite data layer, and the
UI platform pass — plus a closing batch for the four partial
fixes and the version hygiene the pre-release resweep flagged.
Zero P0/P1 remain open.

### Closing batch — resweep residuals

- **Delegated sub-turns occupy their target bot** (audit P1-19).
  `ask_teammate` now refuses with a stable `teammate_busy` tool
  error when the target already has a live run, instead of two
  turns interleaving on one transcript and workspace. A running
  sub-turn registers a delegated placeholder in the run registry:
  a direct chat to the target sees the usual 409 busy, and Stop on
  the target aborts the sub-turn (its approval cards ride the
  parent run id, so cancellation reaches them). The placeholder's
  controller is linked to the parent run's signal — stopping the
  parent stops the whole tree — and the slot is released on every
  exit path.
- **The messages API is paginated** (audit P1-20).
  `GET /api/bots/:id/messages` returns
  `{ messages, hasMore, nextBefore }`: the newest page by default
  (100, max 200), older pages via `?before=<seq>`. The client
  opens on one page and offers a localized "load earlier" row that
  prepends the next page without moving the reader's scroll
  anchor. The roster's last-activity lookup now reads one indexed
  row per bot instead of the whole transcript (NF-5).
- **Password hashing is asynchronous** (audit P1-21). scrypt runs
  through the promisified crypto API on the thread pool;
  registration, login (including the unknown-account dummy hash),
  password change, code reset and SSO shadow creation are async
  end to end, and no `scryptSync` remains. The stored format is
  unchanged (`v2:<N>:<hex>`, salt in its own column): hashes from
  the sync era — bare legacy hex and low-cost v2 alike — verify
  and silently upgrade exactly as before.
- **Provider keys are test-decrypted at boot** (audit P1-24).
  Startup opens every stored `keyEnc` once: failures are
  announced immediately — an error log line and a
  `vault_key_check_failed` audit row carrying only provider ids
  and the count, plus a `vaultKeyErrors` counter on the owner
  health detail — instead of surfacing at the first chat that
  touches the dead key. Boot is never blocked by a bad key.
- **Version markers incremented** (resweep NF-1). package.json
  reads 0.14.0, the shell assets carry `?v=140`, and the service
  worker is `starts-agents-v17` with `/ui-utils.js?v=140` added
  to its precache list — post-deploy version checks work again.

### Batch 1 — isolation stop-loss

From the 2026-11-08 full audit (P1-1..P1-7, N1..N4, S2, A2, A3) and
the item-13/14 product decisions.

- **Approval decisions gain an ownership dimension (P1-2, item 13).**
  On a bot that has an owner, a non-exec approval card is decided by
  the bot's owner or a site owner — the person who started a run on
  someone else's bot can no longer approve their own card (that hole
  handed any member standing write access to any workspace). Exec
  cards stay site-owner-only; ownerless legacy bots keep the old
  starter-or-owner rule. Running your OWN bot: `write_file` /
  `edit_file` need no card anymore; `delete_file` / `rename_file`
  still card and the owner decides them. A persistent "always allow"
  grant only skips the card when the grant holder is the bot's owner
  or a site owner — pre-existing grant rows naming anyone else are
  inert on bots that aren't theirs. Bot owners now also SEE the
  cards raised on their bots.
- **Bot file surface is owner-only (P1-3).** Workspace listing,
  file viewer, raw file route, preview (root included) and packages
  require the bot's owner or a site owner; everyone else gets the
  same 404 as a nonexistent bot. Chat and message history stay
  shared. Sensitive-file policy, written down in SECURITY.md:
  owner/site owner may read sensitive files via files / file-view
  only; preview never serves them to anyone; members are refused
  everywhere.
- **Tools refuse sensitive files (P1-4).** `read_file` rejects
  sensitive paths for every caller; `search_text` excludes them on
  both the ripgrep path (globs + hit filter) and the fallback
  walker, so secret contents cannot enter a transcript.
- **Social sign-in closes under SSO (P1-1, N1).** Google
  start/callback, Telegram sign-in and registration codes answer
  404 (`errSocialOff`) while main-site SSO is enabled — a local
  social door would mint accounts outside the main site's ban and
  role control.
- **Email changes need proof (P1-5).** Changing the profile email
  mails a 6-digit code to the NEW address (own code namespace,
  reset/registration discipline); the change lands only via
  `POST /api/auth/me/email-confirm`. The old address stays in force
  until then. Settings shows the code row while a change is pending.
- **Password change revokes other sessions (P1-6).** The session
  performing the change survives; every other session of the
  account is revoked. Code-based reset still revokes all.
- **SSO shadow accounts re-verify every 72h (P1-7).** The user row
  records the last successful exchange; sessions of a shadow
  account whose last exchange is older than 72h are refused, so a
  main-site ban lands here within the window. Shadow accounts that
  predate the field re-verify once after upgrade. Local password
  accounts are unaffected.
- **Sign-in becomes device-style (item 14).** With SSO on, local
  password sign-in and public registration answer 404; the lock
  screen offers the Complay sign-in plus the legacy access-token
  break-glass only. Sessions: 180-day TTL with sliding renewal
  (was a fixed 30 days), cookie lifetime to match. With SSO off,
  password sign-in works in full, unchanged.
- **Scoping fixes (N2/N3/N4/S2).** The system (local-model)
  provider's PATCH may change only its model list
  (`systemProviderModelsOnly` otherwise). `GET /api/usage` returns
  byBot rows for the caller's own bots only (owners: all). `GET
  /api/bots` gives non-owners a public card ({id, name, ownerId,
  ownerName, status, lastActiveAt}) instead of the full record.
  Runs record their starter; `GET /api/tasks` shows members only
  their own runs, live and history (pre-upgrade runs have no
  starter recorded and read as owner-only).
- **Login limiter (A2/A3).** The global per-account failure
  dimension no longer hard-locks (a lockout weapon against the real
  owner); it applies a progressive delay — from the 5th failure,
  2^(n-4)s, capped at 60s. The (IP+account) pair still hard-locks
  at 8 failures. Unknown-account logins now run a dummy scrypt so
  response timing does not enumerate accounts.

### Batch 2 — cost gates

From the 2026-11-08 full audit (P1-14, P1-15, P1-17, K1) and
feedback item 20. Every ceiling is an `SA_*` env var with a sane
default, all read in `src/config.js` (full table in the README).

- **Rate limits where there were none (P1-15, P1-14).** A small
  in-memory fixed-window limiter (`src/ratelimit.js`) now guards:
  send-code per IP (10 / 10 min) and globally (200 / hour) — over
  the limit the answer stays the uniform `{ ok: true }` and simply
  no code is issued and no mail sent; SSO exchange per IP
  (30 / min, 429 `errRateLimited`); chat per user (20 / min, 429);
  login per IP (30 / min, alongside — not instead of — the existing
  failure lockout).
- **One live run per user (P1-14).** A second top-level chat from
  the same user — on ANY bot — is a 409 with the live run's status,
  same busy body shape as the per-bot lock, so the client's
  stop-and-resend flow applies. Delegated sub-turns belong to the
  run tree and don't count separately.
- **Daily token hard cap (P1-14).** `SA_DAILY_TOKEN_CAP`
  (default 20M, owners exempt): checked before a chat starts
  (429 `errDailyCap` with used/cap) and re-checked as usage streams
  in — a run that crosses the line mid-flight is aborted and the
  client gets the key with the numbers, not a bare "cancelled".
- **Run budget + wall clock (K1, item 20).** Each top-level run
  carries one budget object `{ tokenCap (SA_RUN_TOKEN_BUDGET,
  default 2M), deadline (SA_RUN_WALL_MS, default 15 min) }`,
  SHARED by reference through the whole delegation tree and charged
  after every model call. Exhaustion ends the run as `errBudget`,
  the deadline as `errRunTimeout` (a route timer makes the clock
  cover approval waits too). Delegation now goes 2 levels deep
  (was 1) with a ring refusal: a bot already in the chain cannot be
  asked again.
- **Context window rebuilt (item 20).** The bare `slice(-30)` is
  gone (`src/context.js`): the window keeps the first user message
  and first assistant reply as verbatim head anchors, a sliding
  tail, and an explicit in-context marker where the middle was
  compressed — then a character-estimated token budget
  (`SA_CONTEXT_TOKEN_BUDGET`, default 120k) trims the tail further
  if needed. Opening constraints can no longer fall off silently.
- **Disconnect grace (P1-17).** When a chat client vanishes, the
  run gets `SA_DISCONNECT_GRACE_MS` (default 60s) to finish on its
  own, then is aborted — phones locking no longer leave orphan runs
  burning tokens. A run parked on an approval card is exempt (the
  card's own timeout governs). Aborts now go through one path that
  also cancels the run's pending cards (`cancelByRun` in the
  broker; cards carry their run id).
- **Request ceilings (K1 family).** `readBody`'s global default is
  now `SA_BODY_LIMIT` (1 MB) and oversize is a 413 `errTooLarge`
  (chat keeps its explicit 24 MB attachment cap; there is no
  multipart path — uploads ride the chat JSON body). Chat text is
  capped at `SA_CHAT_CONTENT_MAX` (32000 chars, 400
  `errContentTooLong`). API engines now send `max_tokens`
  (`SA_MAX_TOKENS_OUT`, default 8192) on every request.
- **Docs.** Turnstile is now stated as production-mandatory in the
  README deployment section and SECURITY.md (code unchanged: it
  still only engages when both keys are configured).

### Batch 3 — trust boundary

From the 2026-11-08 full audit (item 21, P1-11, P1-12, the P1-13
delegation tail, D1, D2, A1). New pure helper module `src/trust.js`.

- **Untrusted-content boundary (item 21).** Results of `browse_page`,
  `screenshot_page`, `read_file` and `search_text` are wrapped in
  `<untrusted-content source="…">…</untrusted-content>` before the
  model sees them; a teammate's delegated summary is wrapped the same
  way (`source="teammate:<name>"`). Literal boundary tags inside the
  content are defused with a zero-width space so planted text cannot
  "close" the boundary early. The agent protocol gains a standing
  declaration: everything inside the boundary is data, never
  instructions — ignore steering attempts inside it and warn the
  user. Deterministic harness results (paths, counts, exit codes)
  are NOT wrapped. Same-turn taint: once a turn has read outside
  content, any later `run_shell` / `run_python` / `delete_file`
  approval card in that turn carries an extra warning line
  (zh / tw / en, `taintWarn`).
- **Filename one-lining (P1-11).** Attachment intake now strips all
  control characters (the old list missed `\r\n`), folds whitespace
  and caps length; the workspace tree spliced into the system prompt
  one-lines every name again (bot-created files pass only through
  that gate), so no filename can print a forged line into a system
  message.
- **Transcript attribution (P1-12).** Stored user messages carry
  `by: { userId, name }`; delegated tasks carry
  `delegated: { fromBotId, fromBotName, byUserName }` and the brief
  itself is stored as plain text (the prose "[Teammate delegation
  from …]" prefix is gone from new records; old ones render as
  stored). `buildContext` renders `[name] …` /
  `[delegated task from <bot> via <user>] …` prefixes, and the
  client shows the author (or a delegation badge) in small print
  above user bubbles on shared transcripts. Old messages without
  the fields render exactly as before.
- **Delegation provenance (P1-13 tail).** Inside a delegated
  sub-turn, `write_note` stamps its line and `update_tasks` stamps
  every item with `source: { kind: 'delegated', from, via }`, which
  passes through the task views untouched.
- **Team import confirmation (D1).** A team file carrying persona
  or shared-instruction text no longer applies silently: the first
  `POST /api/teams/import` returns `pendingPersona` (per-bot
  previews, nothing created) and only a re-POST with
  `confirmPersona: true` imports. The client shows a confirmation
  dialog with the exact instruction text. Persona-free files still
  import in one shot. Imports are audit-logged.
- **Name normalization (D2).** Bot names (create / PATCH / team
  import — PATCH previously had no cap at all) and user display
  names (create / profile / SSO upsert) are normalized at write
  time: one line, no control characters, no angle brackets, length
  capped. Share-landing OG/title output continues to HTML-escape
  the (now also normalized) names.
- **Audit redaction shapes (A1).** `redactSecrets` now also covers
  Telegram bot tokens, PEM private-key blocks, AWS `AKIA…` ids,
  `gho_` tokens and padded Bearer values, and object KEYS are
  redacted as well as values. The implementation is a single
  combined-regex pass: the old per-shape callback wrote match
  OFFSETS into the log for group-less shapes and re-scanned
  multi-secret strings with shifted positions.

### Batch 4 — execution surface

From the 2026-11-08 full audit (P1-8, P1-10, the textcall Form A
item (audit P1-9), P1-18, the packages item (audit P1-16), T2–T8 in
the batch brief's numbering, M1–M3).

- **Chromium SSRF is pinned down (P1-8).** `browse_page` and
  `screenshot_page` no longer spawn Chromium with `--dump-dom` /
  `--screenshot` (which validated only the initial URL and let the
  browser follow redirects anywhere, including 169.254.169.254).
  A new CDP driver (`src/tools.js`) drives the pinned headless shell
  over the DevTools protocol with the Fetch domain enabled: every
  document navigation, redirect hop, XHR/fetch and script request
  pauses and is re-validated with `assertPublicUrl` before it is
  sent; refused targets are failed with ERR_BLOCKED_BY_CLIENT and
  never reach the network, and the final landed URL is validated
  again before anything is read. The browser process is killed in
  a `finally` on every path — no orphan Chromium (T4). Residual:
  our DNS answer and Chromium's can still differ (rebinding
  window), as with the fetch reader. Tests: interception decisions
  are unit-tested with an injected validator; a real-driver test
  (302 → private target for both tools, target never contacted)
  runs when a Chromium binary is discoverable and skips otherwise.
- **claude-cli is confined and owner-gated (P1-10).** The engine
  now runs with `cwd` = the bot's workspace and the sandbox env
  whitelist (server secrets are no longer inherited). Bot create,
  bot update and chat execution all refuse the engine for bots
  whose owner is not a site owner, with the stable key
  `errClaudeOwnerOnly`; the engine picker annotates the risk
  (`engineClaudeRisk`, en/zh/tw). Legacy ownerless bots count as
  site bots. The CLI's own tools still run as the server OS user —
  that is why the engine is owner-only (see SECURITY.md).
- **textcall Form A is anchored (audit P1-9).** The JSON form must
  BE the message — object at the first character, nothing but
  whitespace after it — and its arguments must parse to a plain
  object, or the text is prose. A model quoting an example call in
  its second paragraph no longer executes it. Form B is unchanged.
- **execCaptured always settles (P1-18 root).** Timeout/abort kills
  now arm a 1.5 s grace timer: if `close` has not landed (a
  detached grandchild can hold the stdio pipes hostage), the pipes
  are destroyed and the promise settles unconditionally. The
  server adds a watchdog backstop on the SAME wall clock as
  batch 2: a run still registered at 1.5× `SA_RUN_WALL_MS` gets
  `abortRun()` again — no second timing system.
- **Packages join the quota and get retention (audit P1-16).**
  Package bytes count toward the per-bot cap everywhere the cap is
  shown or enforced (workspace API + `buildPackage`, checked
  against the post-prune figure); each bot keeps only its newest
  5 packages (`PACKAGES_KEEP`, pruned count reported); deleting a
  bot deletes its packages directory (and share-epoch file).
  `buildPackage` also names skipped symlinks in the `excluded`
  list: a link is packaged only when its real target is a regular
  file inside the workspace — a link to a directory or outside no
  longer crashes the build with EISDIR (audit T5).
- **Quota pre-checks completed.** `screenshot_page` pre-checks an
  8 MB estimate and enforces the real size after capture (an
  oversize shot is deleted); `convert_doc` pre-checks against the
  source size. (write/edit were already pre-checked.)
- **Preview share links retire on rename/delete (T2).** Share
  tokens are stateless, so each bot now carries a per-path epoch
  map (`data/share-epochs/<botId>.json`): preview links are minted
  with the file's epoch, and `rename_file` / `delete_file` bump the
  epochs of every path they touch — links for the old path answer
  410 from then on. Pre-epoch links read as epoch 0 and stay valid
  until their path first moves.
- **browse_page honesty (T3, T8).** PDFs and other non-text
  document types are refused BY NAME ("unsupported document type")
  instead of being dumped as binary garbage; a page that renders
  with no readable text says "empty content". The fetch reader now
  streams with a hard 2 MB cap and reports truncation instead of
  buffering the whole body first.
- **Stable `errNoModel` (T7).** A bot whose provider exists but
  names no model (and the bot names none either) is refused before
  the engine runs, with the localizable key `errNoModel` — the
  client renders the fix (pick a model) in the user's language.
- **Client tool catalog completed (T6).** The chat's tool-summary
  line covers every server tool (run_python, screenshot_page,
  media_probe, convert_doc, update_tasks were missing); a test
  asserts the client switch and the server catalog stay in step.
- **Module supply chain (M1–M3).** (M1) The browser module drops
  the opaque `@puppeteer/browsers` installer: the pinned
  chrome-headless-shell 141.0.7390.65 archive is downloaded
  directly from the official Chrome-for-Testing bucket and passes
  a sha256 verify gate like every other module. CfT publishes no
  `.sha256` sidecar (verified 2026-11-08), so the pinned hash was
  computed from the official archive that day and cross-checked
  by running the extracted binary; CfT also ships no linux-arm64
  headless-shell build, so arm64 installs now fail loudly at the
  steps stage. (M2) Installs are two-phase: build in
  `.staging-<id>`, verify artifacts + write the completion marker
  there, then atomically rename into place — a failed install
  cleans staging and leaves the live directory untouched (before,
  failure deleted the live directory). (M3) python-data installs
  now end with a real `import requests, numpy, pandas` self-test,
  and the sandbox probe reports a marker-ready but import-broken
  python-data as `unusable` instead of `ready` (registry-derived,
  not a hardcoded list); the client renders the new status
  (`sbUnusable`).

### Batch 5a — data layer: SQLite migration

- **One SQLite database replaces the JSON file store.** Bots,
  messages, providers, grants, usage, run history, users, sessions,
  codes and the audit log now live in `data/app.db` (node:sqlite,
  WAL, still zero dependencies). Every mutation is a single indexed
  statement: a chat message is one INSERT instead of a synchronous
  rewrite of the entire state file, and usage recording is four
  upserts instead of a whole-file write (audit P0-1, C1, C2).
- **Automatic first-boot import.** A data dir that still has
  `state.json` / `auth.json` / `usage.json` / `runs.json` /
  `audit.log` is imported in one transaction on first boot:
  verbatim copies land in `data/backups/legacy-<timestamp>/` first,
  originals are renamed to `*.migrated-<date>` (kept, not deleted)
  after. A corrupt `state.json` / `auth.json` aborts the import and
  the boot — the store still fails closed, never starts empty.
  Unknown top-level fields of the old files are preserved in a `kv`
  table rather than dropped.
- **Single-instance lock.** Startup takes `data/app.lock` (pid
  file): a second process against the same data dir refuses to
  start while the first is alive; a dead holder's lock is taken
  over. Instances must be exactly 1 (pm2 `-i 1`) — the boot
  snapshot + whole-file overwrite corruption path (audit P0-2) is
  gone with the JSON store, and the lock keeps it that way.
- **Automatic snapshots.** A consistent `VACUUM INTO` copy of the
  database lands in `data/backups/` at startup and every 24h,
  keeping the newest `SA_BACKUP_KEEP` (default 7). Backup failures
  log and never stop the service. Expired sessions/codes are pruned
  at startup, and audit rows older than `SA_AUDIT_KEEP_DAYS`
  (default 90) are pruned at startup too — imported audit entries
  older than the window are pruned at that first boot (their
  original text survives in the `backups/legacy-*` copy).
- **Sessions are stored hashed.** The sessions table is keyed by
  SHA-256 of the session id (checklist item 24): the plaintext id
  exists only in the client cookie, the Settings session list shows
  a hash prefix, and revoking by that prefix works within the
  owner's own sessions.
- **Bot deletion cascades in the database** — messages and grants
  go with the bot (foreign keys), as do its per-bot usage rows.
- `scripts/rekey.mjs` rotates provider keys inside `app.db` now
  (the legacy `state.json` path is kept for never-migrated
  installs), still decrypt-everything-before-writing-anything.

### Batch 5b — data lifecycle tail

- **Deleting a user cascades** (audit P1-23). The account's bots go
  through the full bot-deletion path (workspace, packages, share
  epochs, task list and notebook files, messages/grants by foreign
  key, per-bot usage), its providers are deleted with their sealed
  keys, its persistent grants and per-user usage rows are removed,
  its pending verification codes are dropped, and the volunteer
  flag dies with the row. The whole cascade is audit-logged as
  `auth_user_delete` with per-kind counts. The last-owner and
  self-delete guards are unchanged.
- **Audit trail completed** (audit P1-25). New entries:
  `auth_user_delete`, `bot_created`, `bot_updated` (with the changed
  field names), `bot_deleted`, `provider_deleted`,
  `auth_pw_changed`, `auth_session_revoked`. `provider_added` /
  `provider_updated` now carry `by`, and `provider_updated` marks
  `keyChanged` so a silent key swap is visible after the fact. Tool
  execution entries now carry the executing user's name and id
  (approval and grant entries already did).
- **Vault key ring + rotation** (audit P1-24). The vault holds a
  ring of master keys (`SA_VAULT_KEYS`, comma-separated; the legacy
  `SA_VAULT_KEY` / `START_AGENTS_MASTER_KEY` / key-file sources keep
  working as a one-key ring): sealing always uses the first key,
  opening tries them all. `npm run vault:rotate` re-seals every
  provider key under the primary key — every entry is decrypted
  and its replacement verified before anything is written, so a
  key missing from the ring aborts the run with zero changes — and
  writes a `vault_rotate` audit entry. The old
  `scripts/rekey.mjs` two-key flow still works for the simple case.
- **Verification codes are HMAC'd** (audit A4 tail). Reset,
  registration and email-change codes are stored as HMAC-SHA-256
  under a pepper derived from the vault master key, so a leaked
  database alone can no longer brute-force the 10^6 code space
  offline. Rows written by older versions (bare SHA-256) are still
  accepted once at verify time; every success path deletes the
  code, so a legacy hit is also its last use.
- **Password hashes are parameter-versioned** (audit A6). New
  hashes store as `v2:<N>:<hex>` at scrypt N=32768
  (`START_AGENTS_SCRYPT_N` overrides); verification reads the cost
  back out of the stored string, legacy bare-hex hashes (N=16384)
  keep working, and a successful login silently rehashes a
  weaker-than-current stored hash at the current cost.
- **Health endpoint + structured logs** (audit O2). `GET
  /api/health` answers `{ ok, version }` anonymously; an owner
  session also gets database size, bot/user counts, the last
  snapshot time and uptime. A new `src/log.js` emits one JSON line
  per event ({ts, level, msg}) and now covers the top-level request
  failure path, boot failures, backup failures and audit-write
  failures, plus `uncaughtException` (fatal, logged, exit 1) and
  `unhandledRejection` (logged) handlers.
- **Durability posture**: `app.db` now runs `synchronous = FULL`
  (audit O4 tail) — every commit is fsynced, so a completed write
  survives host power loss, not just a process crash. Write volume
  on a single small instance makes the cost noise.
- Test-harness note: the batch-5b HTTP scenario runs inside one
  parent test with sequential subtests, and ports are probed free
  at runtime — this Node's test runner can interleave registered
  tests with later top-level awaits, and fixed ports let a killed
  run's orphaned server poison every later run.

### Batch 6a — UI platform pass

- **Design tokens aligned with the main site** (feedback item 30).
  Motion now runs on the shared tokens — `--dur-1..4`
  (120/200/320/500ms) and `--spring: cubic-bezier(.22, 1.36, .36, 1)`
  — across cards, sheets, dialogs, tabs and button feedback. List
  entrances are fade + 12px rise with a 50ms stagger capped at 8
  steps (bot roster, task center, workspace, providers), and the
  reduced-motion block covers every new animation. Brand palette
  re-verified: gradient #6C5CE7 → #00CEC9 on base #0F212E.
- **Occlusion family swept** (items 27–29). The bot card's "…"
  button now owns a flex slot in the card header row instead of
  overlaying the model line. Bottom clearance is a system:
  `--tabbar-h` + safe-area inset behind a shared `.page-pad` class
  on all four main views (the old per-view 108px magic number is
  gone). The chat composer follows the software keyboard via a
  visualViewport listener that keeps a bottom-riding transcript
  pinned.
- **Native dropdown elements: zero** (house rule). The four
  remaining form dropdowns (bot engine, bot provider, provider
  preset, account role) plus the local-model picker now use the
  app's own dropdown component; a test asserts no native dropdown
  markup exists anywhere under `public/`.
- **Approval failures stay on the card** (audit F1). A failed
  decision turns the card into a red error state with the reason
  and live retry buttons; the card leaves only on success or an
  explicit dismiss tap, and dismissed cards are never resurrected
  by the pending-approvals sync.
- **Composer queue** (audit F2). Messages composed while a run is
  busy wait in a queue bar above the composer — each row removable
  — and send in order when the run ends, carrying the attachments
  snapshotted at compose time. Switching bots drops the queue.
  Stop-and-resend remains available as the manual path.
- **Toast governance** (audit F3). One toast stack (new
  `public/ui-utils.js`): identical text inside 3 seconds refreshes
  instead of stacking, at most 3 live at once, overflow evicts the
  oldest. Team import, share-link and delete completions report
  through it.
- **Settings regrouped + type-the-name deletes** (audit F4). The
  settings page is now "Account & permissions" and "Data & danger
  zone" sections. Deleting a bot, account, provider or local model
  goes through one confirmation dialog whose delete button unlocks
  only when the target's exact name is typed.
- **Lock-screen state machine hardened** (audit F5). `?authError`
  values are whitelist-only: anything that is not a known translated
  key falls back to the generic lock error, so a crafted link can
  no longer put arbitrary text on the sign-in screen. SSO/Google
  buttons take a loading state on tap.
- **Display-layer error redaction** (audit F7). Server/engine error
  text passes a shape redactor (PEM, Bearer, Telegram tokens,
  sk-/ghp_/github_pat_/AKIA/JWT shapes, URL and key-value
  credentials, long opaque tokens) before it is rendered; the
  error card's Copy action still carries the raw text.
- **Narrow chat header + preview teardown** (audit F8/F9). At
  360px the chat header truncates the bot name with an ellipsis
  while status and action buttons keep their slots
  (`min-width: 0` chain verified). Closing a preview blanks its
  frame first, and a `pagehide` handler tears down the preview,
  card menu and settings poll timers.

### Batch 6b — full i18n + feature close-out

- **F6: i18n is now 100% in all 15 languages.** Every locale
  carries the full 321-key set — the twelve partial locales
  (ja/ko/es/fr/de/pt/ru/ar/vi/th/id/hi) were translated key by
  key, not English-filled. A test asserts exact key-set parity
  with English, placeholder preservation, and sentinel keys
  differing from the English originals in every locale.
- **Item 18: fetched models are a picker, not a dump.** "Fetch
  models" now opens a searchable checkbox list (filter / select
  all / clear / count); only ticked models join the provider's
  list, and models already in the list start ticked. Filtering
  and selection logic live in `public/ui-utils.js` as testable
  pure functions.
- **Item 19: files are viewable from the chat.** Package cards
  list every packaged file with a View button into the in-app
  file viewer (zip download kept), and write_file/edit_file
  tool rows carry a View action that opens the file's current
  content — behind the batch-1 ownership gate, with a friendly
  "not yours / gone" notice instead of a raw error.
- **Item 22: shell commands are risk-graded on approval cards.**
  `src/risk.js` statically grades run_shell/run_python commands:
  download-piped execution, package installs, git clone,
  rm -rf, sudo, disk tools and system-path writes grade `high`
  (red warning line on the card); single read-only commands
  (ls/cat/git status/…) grade `low`; everything else `normal`.
- **Item 23: TOCTOU close-out.** write_file opens its target
  with O_NOFOLLOW and writes through the fd; edit_file reads
  and rewrites through one O_NOFOLLOW fd — a symlink swapped
  into the path can no longer carry a write outside the
  workspace (tested with a live symlink trap).
- **A7 remainder: weak-password gate.** Registration, password
  change and code reset now require 10+ characters, or 8+ with
  three character classes, and reject a built-in common-password
  list (`errWeakPw`). Existing shorter-but-strong test fixtures
  were adjusted (`password123` → a compliant password in five
  test files); new hashes still use the versioned scrypt params.

## v0.13.0 — 2026-11-08 (sandbox upgrade: hardening, env probe, optional modules)

- **Preview can no longer reach the app API.** The workspace preview
  CSP now sets `connect-src 'none'` (on top of the existing sandbox
  without `allow-same-origin`): a previewed page's script cannot
  fetch/XHR the app's `/api` with the viewer's session. Static
  previews still render whole — css/js/img/fonts are subresource
  loads, not connect-src.
- **Per-bot workspace quota.** Workspaces are size-accounted; the
  write tools (`write_file` / `edit_file`) refuse a write that would
  exceed the cap with a clear message. Default 500 MB
  (`START_AGENTS_WORKSPACE_QUOTA_MB`, 0 = unlimited). Current usage
  and cap are exposed on the workspace API and shown in the
  Workspace view. `run_shell` is not pre-blocked (builds spike temp
  files); the quota status stays visible instead.
- **run_shell soft resource limits.** The shell invocation now sets
  generous `ulimit` caps (processes, virtual memory) on top of the
  existing whitelist env, 120s timeout and process-group kill.
- **Sandbox environment panel.** New `GET /api/sandbox/env` probes
  the real toolchain (node, npm, git, python3, pip3, rg, jq,
  ffmpeg, ffprobe, pandoc, chromium, zip, unzip) — versions are read
  from the binaries themselves — and Settings shows each item as
  ready / module-download / not-installed.
- **Optional modules（需要下载）.** Five owner-installable toolchains
  under Settings → Optional modules, all from fixed official
  sources, installed into `sandbox-modules/` (never into a bot
  workspace, never into a deployment package):
  - **browser** — real Chromium headless shell: `browse_page`
    renders for real, new `screenshot_page` tool (safe).
  - **python-data** — venv with requests/numpy/pandas: new
    `run_python` tool (approval-gated like the shell).
  - **media** — static ffmpeg/ffprobe: new `media_probe` tool
    (safe), ffmpeg on the sandbox PATH.
  - **docs** — pandoc: new `convert_doc` tool (approval-gated).
  - **devtools** — ripgrep + jq: `search_text` takes the rg fast
    path (same result contract), jq on the sandbox PATH.
  A module's tools are omitted from the model's tool list until the
  module is installed — absent modules produce no errors, the tools
  simply do not exist yet. Installs are owner-only, run async with a
  polled status (installing → ready / failed with log tail), reject
  concurrent duplicates with 409, and are audit-logged
  (start / done / fail).
- Shell and Python children now get the *effective* sandbox PATH —
  installed modules' bin dirs first — so what the env panel shows is
  exactly what a bot's shell can call.

## v0.12.1 — 2026-11-08 (hotfix: four real-device defects from v0.12.0)

- **Approval-card errors no longer stack.** A failed decision tap
  appended a fresh generic error line every time (five identical
  lines in the field) and never said why. Each card now keeps ONE
  error line, reused across taps, carrying the real reason — the
  server's error text, the HTTP status, or a localized network
  message; a later success clears it.
- **Busy deadlock broken.** A run parked on an approval holds the
  bot; if the client's stream died, the chat lost its stop button
  and every new message hit a 409 whose card offered only a futile
  retry. The 409 body now also carries the live run's status
  (`running` / `awaiting_approval`, error string unchanged), the
  card shows a localized busy message, and a third action —
  "Stop task & resend" — stops the parked run and resends the
  message once.
- **Raw engine errors are no longer shown verbatim.** Safari's
  "Load failed" / Chrome's "Failed to fetch" and other
  network-shaped failures now display as a localized
  network-interruption message on error cards; the raw text remains
  available via the card's Copy button only.
- **No more empty AI bubbles.** A turn that died by stream error
  before any content arrived left a blank assistant bubble with the
  AI footer above the error card. The error path now applies the
  same drop-if-empty cleanup the end-of-stream path already had,
  and stored history rendering skips contentless assistant
  messages so a blank bubble can't come back on reload.

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
