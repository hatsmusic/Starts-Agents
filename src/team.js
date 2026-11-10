// Teams as one Markdown file — the portable unit of sharing.
// A team file is readable by humans AND by models, and never carries
// credentials, transcripts or permissions: just names, engines, models
// and personas. Import creates fresh bots; export writes bots back out.
//
// Supported format (a small, documented subset — see docs/teams.md):
//
//   ---
//   team: Support Crew
//   bots:
//     - name: Chief
//       engine: echo
//       model: gpt-4o-mini
//       persona: |
//         You are the chief of staff...
//   ---
//   Shared instructions appended to every bot's persona (this body).

/* Import limits (v0.21.0, audit F-10): a team file used to be
 * bounded only by the route's 1MB body cap — one file could mint
 * thousands of bots or a ~1MB persona that then rides EVERY turn's
 * system prompt forever. These caps reject the whole file up
 * front (parse throws before anything is created); the matching
 * transactional insert lives in store.addBots, and the route
 * wiring is a coordinator TODO. */
export const TEAM_LIMITS = {
  maxBots: 50,
  maxPersonaChars: 20_000,
  maxModelChars: 200,
  maxEngineChars: 64,
  maxNameChars: 200,
  maxTeamNameChars: 200,
  maxFileChars: 1024 * 1024,
};

export function parseTeam(md, defaultEngine = 'echo') {
  const text = String(md || '').replace(/\r\n/g, '\n');
  if (text.length > TEAM_LIMITS.maxFileChars) throw new Error(`team file too large (max ${TEAM_LIMITS.maxFileChars} characters)`);
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('team file must start with a --- frontmatter block');
  const [, fm, body] = m;
  const team = { name: 'Imported team', bots: [] };
  let cur = null;
  let inPersona = false;
  for (const line of fm.split('\n')) {
    // Persona block lines come FIRST (audit fix): a persona is free
    // text — lines like "model: x" or "- name: y" inside it used to
    // hijack the structural parsing, splitting one bot into two and
    // truncating the persona. A line belongs to the block only while
    // it is blank or indented by the full 6 spaces; anything less
    // indented ends the block and is parsed structurally.
    if (inPersona && cur && (line.trim() === '' || line.startsWith('      '))) {
      cur.persona += (cur.persona ? '\n' : '') + line.replace(/^\s{6}/, '');
      continue;
    }
    inPersona = false;
    if (/^team:\s*/.test(line)) { team.name = line.replace(/^team:\s*/, '').trim() || team.name; continue; }
    if (/^bots:\s*$/.test(line)) { continue; }
    const item = line.match(/^ {2}-\s*name:\s*(.+)$/);
    if (item) { cur = { name: item[1].trim(), engine: defaultEngine, model: '', persona: '' }; team.bots.push(cur); continue; }
    if (!cur) continue;
    const kv = line.match(/^ {4}(engine|model):\s*(.*)$/);
    if (kv) { cur[kv[1]] = kv[2].trim(); continue; }
    if (/^ {4}persona:\s*\|/.test(line)) { inPersona = true; continue; }
  }
  const shared = body.trim();
  if (shared) for (const b of team.bots) b.persona = (b.persona ? b.persona + '\n\n' : '') + shared;
  team.bots = team.bots.filter((b) => b.name);
  if (!team.bots.length) throw new Error('no bots found in team file');
  // Limit enforcement (audit F-10): checked AFTER the shared body
  // is folded in, so a persona cannot sneak past the cap via the
  // shared section. Any violation rejects the whole file.
  if (team.name.length > TEAM_LIMITS.maxTeamNameChars) throw new Error(`team name too long (max ${TEAM_LIMITS.maxTeamNameChars} characters)`);
  if (team.bots.length > TEAM_LIMITS.maxBots) throw new Error(`too many bots in team file (max ${TEAM_LIMITS.maxBots})`);
  for (const b of team.bots) {
    if (b.name.length > TEAM_LIMITS.maxNameChars) throw new Error(`bot name too long (max ${TEAM_LIMITS.maxNameChars} characters)`);
    if (String(b.engine || '').length > TEAM_LIMITS.maxEngineChars) throw new Error(`engine name too long (max ${TEAM_LIMITS.maxEngineChars} characters)`);
    if (String(b.model || '').length > TEAM_LIMITS.maxModelChars) throw new Error(`model name too long (max ${TEAM_LIMITS.maxModelChars} characters)`);
    if (String(b.persona || '').length > TEAM_LIMITS.maxPersonaChars) throw new Error(`persona too long for bot "${b.name}" (max ${TEAM_LIMITS.maxPersonaChars} characters)`);
  }
  return team;
}

/* Single-line fields (team/bot name, engine, model) must not
 * carry raw newlines into the frontmatter (v0.21.0, audit F-24,
 * P2 same-file): an unsanitized name could inject forged
 * frontmatter lines that a later import would parse as structure.
 * Persona is exempt — it is written as an indented block, which
 * the parser already treats as opaque. */
const oneLine = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

export function exportTeam(name, bots) {
  const lines = ['---', 'team: ' + (oneLine(name) || 'My team'), 'bots:'];
  for (const b of bots) {
    lines.push('  - name: ' + oneLine(b.name));
    lines.push('    engine: ' + (oneLine(b.engine) || 'echo'));
    if (b.model) lines.push('    model: ' + oneLine(b.model));
    lines.push('    persona: |');
    for (const l of String(b.persona || '').split('\n')) lines.push('      ' + l);
  }
  lines.push('---', '');
  return lines.join('\n');
}
