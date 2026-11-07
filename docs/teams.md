# Team files

A team file is Markdown with a small frontmatter block. The parser
(`src/team.js`) intentionally supports only the subset documented
here — it is a sharing format, not a config language.

```markdown
---
team: Support Crew
bots:
  - name: Chief
    engine: echo
    model: gpt-4o-mini
    persona: |
      You are the chief of staff...
  - name: Scout
    engine: openai
    persona: |
      You research and summarise...
---

Text after the frontmatter is appended to every bot's persona as
shared instructions.
```

Rules:

- `team:` — display name of the crew.
- Each bot needs at least a `name:`. `engine:` defaults to the
  harness default, `model:` is optional, `persona:` uses the `|`
  block style with 6-space indentation.
- A team file NEVER contains credentials, transcripts, approvals or
  computer access. Engines read keys from the harness environment,
  not from the file — so a team file is safe to share as-is.
- Importing always creates *fresh* bots (new ids, empty transcripts).
  Imported bots start life with the standard tool set and approval
  rules; nothing in the file can weaken them.

Export: `GET /api/teams/export` (or the button in the UI) writes the
current roster back into this format.
