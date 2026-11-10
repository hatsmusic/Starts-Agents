# Architecture

Starts-Agents is one small harness and four ideas. Everything else is
replaceable.

```
┌────────────┐   HTTP/SSE   ┌──────────────────────────────────────┐
│  Web UI    │ ───────────▶ │  Harness (src/server.js)             │
│ (public/)  │ ◀─────────── │  · roster + transcripts (store.js)   │
└────────────┘   tokens,    │  · turn loop: stream engine events,  │
                  approvals │    mediate tools by risk             │
                            └──────┬───────────────┬───────────────┘
                                   │               │
                          ┌────────▼─────┐  ┌──────▼────────┐
                          │ Engines      │  │ Tools         │
                          │ (engines.js) │  │ (tools.js)    │
                          │ echo/openai/ │  │ safe → run    │
                          │ claude-cli   │  │ ask → broker  │
                          └──────────────┘  └──────┬────────┘
                                                 │
                                          ┌──────▼────────┐
                                          │ Approvals     │
                                          │ (approvals.js)│
                                          └───────────────┘
```

## 1. The roster is the product shape

Bots are contacts, not API keys. Each bot is a record
`{ id, name, engine, model, persona }` with its own transcript. The UI
is a messaging app because that is how people actually supervise
agents: in threads, with memory.

## 2. Engines are drivers

An engine is an async generator that yields `token` events and `tool`
requests, and receives tool results back (see `src/engines.js`). The
harness does not know which brain it is running. That is deliberate:
models change every quarter; the supervision layer should not.

To add a brain (Codex CLI, Grok, a local server, your own fine-tune):
copy the `claude-cli` driver, change how it produces text, register it
in `ENGINES`. One file, one line.

## 3. Tools declare their risk; the broker enforces it

Every tool in `src/tools.js` carries `risk: 'safe' | 'ask'`. Safe tools
(read-only, confined to the bot's workspace — plus `update_tasks`,
which only mutates the bot's own task list) run immediately. Anything risky
pauses the turn and creates an approval card; a human resolves it, or
a 5-minute timeout denies it. The model can *propose* — only a human
can *permit*. Keep this line bright as you add tools: the day a
state-changing tool ships as `'safe'`, the seatbelt is off.

## 4. Teams are Markdown

A team is one `.md` file (see `docs/teams.md`): names, engines, models,
personas, shared instructions. No credentials, no transcripts, no
permissions — so a team file is safe to commit, gist, or hand to
another person (or another model) to recreate the crew.

## What is deliberately NOT here (yet)

- **Computers per bot** (VM/cloud desktop, screen control) — the big
  missing piece versus full agent products. The seam for it is a new
  kind of tool whose `run()` drives a VM; approvals already gate it.
- **Channels / group rooms** with several bots and a router that picks
  who answers — the store already keys transcripts per bot; a room is
  a transcript shared by several.
- **Schedules & webhooks** — the turn loop is a plain function
  (`chatTurn`); a cron that calls it with a synthetic user message is
  an afternoon of work.
- **Hosted relay / mobile** — the harness binds localhost by design.
  Put it behind Tailscale or a reverse proxy if you want your phone
  to reach it; do not expose it raw.

## Data

`data/app.db` — one SQLite database (node:sqlite, WAL) holding the
roster, transcripts, providers, grants, usage, run history,
accounts, sessions, codes and the audit log; `data/backups/` holds
its automatic snapshots, `data/projects/<botId>/` is each bot's
workspace (the only place its file tools may touch),
`data/packages/<botId>/` holds built zips, `data/tasks/` per-bot
task lists. Delete `data/` to start over (accounts included).
The master key and share secret live OUTSIDE `data/` — see
SECURITY.md before moving or restoring anything.
