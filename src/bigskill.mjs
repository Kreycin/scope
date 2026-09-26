// Notice skill bodies that load tens of thousands of tokens into a session.
//
// A skill body stays in context and is re-read on every later request until /clear or
// /compact (e.g. the bundled claude-api skill is ~170k tokens). At each prompt the hook
// scans only the transcript bytes added since its last scan, so a body larger than the
// tail window used for the context size is still seen whole.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

const SKILL_PREFIX = /^Base directory for this skill: (\S+)/;

function skillName(text) {
  const base = text.match(SKILL_PREFIX)?.[1];
  if (base) return base.replace(/\/+$/, '').split('/').pop();
  const heading = text.match(/^#\s+(.+)$/m)?.[1];
  return heading ? heading.trim().slice(0, 60) : 'skill';
}

// Big skill bodies in transcript lines: [{ name, tokens }].
export function findBigSkills(lines, minTokens) {
  const found = [];
  for (const line of lines) {
    // Compaction drops earlier skill bodies from context.
    if (line.length < 2000 && line.includes('"compact_boundary"')) found.length = 0;
    if (line.length < minTokens * 4) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== 'user' || !row.message || row.isCompactSummary) continue;
    const c = row.message.content;
    const texts = typeof c === 'string' ? [c] : (c ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '');
    for (const t of texts) {
      if (t.length < minTokens * 4) continue;
      if (!SKILL_PREFIX.test(t) && !row.isMeta) continue;
      found.push({ name: skillName(t), tokens: Math.round(t.length / 4) });
    }
  }
  return found;
}

// Complete lines added to the transcript since the offset stored for this session.
// A new (or reset) session caps its first read to the last maxFirstBytes so a huge
// existing transcript doesn't get read in full.
export function readNewLines(path, state, sessionId, maxFirstBytes = 16 * 1024 * 1024) {
  state.skillScan ??= {};
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    let from = state.skillScan[sessionId] ?? 0;
    if (from > size) from = 0;
    if (from === 0 && size > maxFirstBytes) {
      const start = size - maxFirstBytes;
      const head = Buffer.alloc(maxFirstBytes);
      readSync(fd, head, 0, head.length, start);
      const nl = head.indexOf(0x0a);
      if (nl < 0) return [];
      from = start + nl + 1;
    }
    if (size === from) return [];
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return [];
    state.skillScan[sessionId] = from + end + 1;
    const ids = Object.keys(state.skillScan);
    for (const id of ids.slice(0, Math.max(0, ids.length - 50))) delete state.skillScan[id];
    return buf.subarray(0, end).toString('utf8').split('\n');
  } finally {
    closeSync(fd);
  }
}

export function bigSkillNote(skills, restorable = true) {
  const list = skills.map((s) => `${s.name} (~${Math.round(s.tokens / 1000)}k tokens)`).join(', ');
  if (!restorable) {
    const message = `scope: skill ${list} is now in context and re-read on every request. Finish the task that needs it, then /compact.`;
    const context =
      `scope: the skill body ${list} was loaded into this session and every later request re-reads it. ` +
      `Handle the user's message first. When the task that needed this skill is done, tell the user in one line that they can type /compact to shrink the context.`;
    return { message, context };
  }
  const message = `scope: skill ${list} is now in context and re-read on every request. Finish the task that needs it, then /clear.`;
  const context =
    `scope: the skill body ${list} was loaded into this session and every later request re-reads it. ` +
    `Handle the user's message first. When the task that needed this skill is done, update STATUS.md at the repo root ` +
    `(rewrite stale lines, under ~80 lines) and tell the user in one line that they can type /clear to drop the skill from context.`;
  return { message, context };
}
