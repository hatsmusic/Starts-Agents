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

export function parseTeam(md) {
  const text = String(md || '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('team file must start with a --- frontmatter block');
  const [, fm, body] = m;
  const team = { name: 'Imported team', bots: [] };
  let cur = null;
  let inPersona = false;
  for (const line of fm.split('\n')) {
    if (/^team:\s*/.test(line)) { team.name = line.replace(/^team:\s*/, '').trim() || team.name; inPersona = false; continue; }
    if (/^bots:\s*$/.test(line)) { inPersona = false; continue; }
    const item = line.match(/^\s*-\s*name:\s*(.+)$/);
    if (item) { cur = { name: item[1].trim(), engine: 'echo', model: '', persona: '' }; team.bots.push(cur); inPersona = false; continue; }
    if (!cur) continue;
    const kv = line.match(/^\s+(engine|model):\s*(.*)$/);
    if (kv) { cur[kv[1]] = kv[2].trim(); inPersona = false; continue; }
    if (/^\s+persona:\s*\|/.test(line)) { inPersona = true; continue; }
    if (inPersona) {
      cur.persona += (cur.persona ? '\n' : '') + line.replace(/^\s{6}/, '');
      continue;
    }
  }
  const shared = body.trim();
  if (shared) for (const b of team.bots) b.persona = (b.persona ? b.persona + '\n\n' : '') + shared;
  team.bots = team.bots.filter((b) => b.name);
  if (!team.bots.length) throw new Error('no bots found in team file');
  return team;
}

export function exportTeam(name, bots) {
  const lines = ['---', 'team: ' + (name || 'My team'), 'bots:'];
  for (const b of bots) {
    lines.push('  - name: ' + b.name);
    lines.push('    engine: ' + (b.engine || 'echo'));
    if (b.model) lines.push('    model: ' + b.model);
    lines.push('    persona: |');
    for (const l of String(b.persona || '').split('\n')) lines.push('      ' + l);
  }
  lines.push('---', '');
  return lines.join('\n');
}
