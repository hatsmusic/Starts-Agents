// Structured logging (v0.14 batch 5b, audit O2): one JSON object
// per line — { ts, level, msg, ...fields } — info to stdout,
// warn/error to stderr, so PM2 (or any log shipper) can split and
// parse the stream without regex archaeology. This deliberately
// does NOT replace every console.* call site in the codebase; it
// covers the places an operator actually pages on: uncaught
// exceptions, audit-write failures, backup failures and boot
// failures. Human-facing boot chatter stays plain text.
export function logLine(level, msg, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: String(msg), ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
  return line;
}
export const log = {
  info: (msg, fields) => logLine('info', msg, fields),
  warn: (msg, fields) => logLine('warn', msg, fields),
  error: (msg, fields) => logLine('error', msg, fields),
};
