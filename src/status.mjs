// Project state file: a short STATUS.md at the repo root that a fresh session reads
// instead of inheriting a long conversation.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { userText } from './simulate.mjs';

export const STATUS_FILE = 'STATUS.md';
// Parallel sessions in one project: STATUS.md is the index, each work stream keeps its own
// status/<slug>.md, so two sessions never rewrite each other's Next (2026-11-17).
export const STREAMS_DIR = 'status';

// Nearest STATUS.md walking up to the git root; never $HOME itself.
export function findStatus(cwd, home = homedir()) {
  if (!cwd) return null;
  let dir = resolve(cwd);
  while (dir !== home && dir !== dirname(dir)) {
    const p = join(dir, STATUS_FILE);
    if (existsSync(p)) return p;
    if (existsSync(join(dir, '.git'))) return null;
    dir = dirname(dir);
  }
  return null;
}

export function statusContext(path, text, maxChars) {
  const cut = text.length > maxChars;
  let body = text;
  let moved = false;
  if (cut) {
    // Next is what the new session acts on: when it would fall past the cut, move it to the top.
    const next = /^## Next[^\n]*\n[\s\S]*?(?=^## |$(?![\s\S]))/m.exec(text);
    const rest = next && next.index + next[0].length > maxChars ? text.slice(0, next.index) + text.slice(next.index + next[0].length) : text;
    moved = rest !== text;
    body = moved ? (next[0].trimEnd() + '\n\n' + rest).slice(0, maxChars) : text.slice(0, maxChars);
  }
  // Say when Next was moved: a session that took this order for the file's own once sliced
  // from '## Next' to '# STATUS', got an empty string and shredded the file (2026-11-06).
  return (
    `scope: project state from ${path} (read this instead of asking what was done; continue from its Next section` +
    (cut ? `; truncated at ${maxChars} chars, Read the rest only if needed` : '') +
    (moved ? '; Next is shown first here but comes after the other sections in the file' : '') +
    `):\n\n${body}`
  );
}

// Only the user's own project folders: a cloned repo's STATUS.md is not injected.
export function isTrusted(path, roots, home = homedir()) {
  return roots.some((r) => {
    const root = resolve(r.replace(/^~(?=\/|$)/, home));
    return path === root || path.startsWith(root + '/');
  });
}

export function loadStatusContext(cwd, { maxChars, trustedRoots }, own = null) {
  const path = findStatus(cwd);
  if (!path || !isTrusted(path, trustedRoots)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    const streams = streamPaths(path);
    if (!streams.length && !hasStreamsTable(text)) return statusContext(path, text, maxChars);
    return streamsContext(path, text, streams, own && streams.includes(own) ? own : null, maxChars);
  } catch {
    return null;
  }
}

// status/<slug>.md files next to the index (names starting with _ are templates or archives).
export function streamPaths(statusPath) {
  const dir = join(dirname(statusPath), STREAMS_DIR);
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort().map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export function hasStreamsTable(text) {
  return /^## Streams\b/m.test(text);
}

// A stream file: <project>/status/<slug>.md with the project's STATUS.md one level up.
export function isStreamFile(path) {
  const p = resolve(path);
  return basename(dirname(p)) === STREAMS_DIR && p.endsWith('.md') && existsSync(join(dirname(dirname(p)), STATUS_FILE));
}

// One line per stream: slug, last change, first Next item.
export function streamLine(path, now = Date.now()) {
  let text = '';
  let day = '?';
  try {
    text = readFileSync(path, 'utf8');
    day = new Date(statSync(path).mtimeMs).toISOString().slice(0, 10);
  } catch {}
  const next = /^## Next[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(text)?.[1] ?? '';
  const first = next.split('\n').map((l) => l.trim()).find((l) => l && !/^just done/i.test(l)) ?? '(no Next)';
  return `- ${basename(path, '.md')} (updated ${day}): ${first.slice(0, 140)}`;
}

// The stream this session wrote last in this project: an Edit/Write of status/<slug>.md or a status-next on it.
export function streamFromLines(lines, statusPath) {
  const dir = join(dirname(statusPath), STREAMS_DIR) + '/';
  let found = null;
  for (const line of lines) {
    if (!line.includes('/' + STREAMS_DIR + '/')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== 'assistant') continue;
    for (const b of row.message?.content ?? []) {
      if (b.type !== 'tool_use') continue;
      const file = b.input?.file_path ? resolve(b.input.file_path) : null;
      if (file && file.startsWith(dir) && file.endsWith('.md')) found = file;
      const cmd = b.name === 'Bash' ? b.input?.command ?? '' : '';
      const m = cmd.includes('status-next') ? /status-next\s+"([^"]+)"/.exec(cmd) : null;
      if (m && resolve(m[1]).startsWith(dir)) found = resolve(m[1]);
    }
  }
  return found;
}

const STREAM_RULE =
  `edit only your own stream file; touch STATUS.md only to add or close your row in its Streams table ` +
  `(Goal, Decisions and shared Open questions there change only when the user decides something for the whole project)`;

// Project with parallel streams: the index, plus this session's own stream when known,
// else a one-line list so the session picks (or starts) its stream without loading the others.
export function streamsContext(path, text, streams, own, maxChars) {
  const index = text.length > maxChars ? text.slice(0, maxChars) : text;
  if (own) {
    let body = '';
    try {
      body = readFileSync(own, 'utf8');
    } catch {}
    if (body.length > maxChars) body = body.slice(0, maxChars);
    return (
      `scope: project index from ${path} and your stream ${own} (read these instead of asking what was done; ` +
      `continue from your stream's Next; ${STREAM_RULE}):\n\n${index}\n\n--- ${own} ---\n\n${body}`
    );
  }
  const list = streams.map((p) => streamLine(p)).join('\n') || '- (no stream files yet)';
  return (
    `scope: project index from ${path}. This project runs parallel sessions, one work stream each, every stream in ` +
    `${join(dirname(path), STREAMS_DIR)}/<slug>.md (Goal, Done, Next, Open questions; under 80 lines). ` +
    `Do not load them all. From the user's first message pick yours: continuing a stream below -> Read only that file ` +
    `and continue from its Next; new work -> create ${STREAMS_DIR}/<slug>.md and add a row to the Streams table; ` +
    `unclear -> ask the user which stream in one short question. Then ${STREAM_RULE}.\n\nStreams:\n${list}\n\n${index}`
  );
}

// Outside trusted roots the handoff state goes to a private file only Claude writes,
// so a clear works in any folder without trusting the repo's own STATUS.md.
export function privateStatusPath(dataDir, cwd) {
  return join(dataDir, 'handoff', createHash('sha1').update(resolve(cwd)).digest('hex').slice(0, 16) + '.md');
}

// Restored only right after a clear, and only if written in the last day.
export function loadPrivateStatus(dataDir, cwd, { maxChars }, now = Date.now()) {
  const path = privateStatusPath(dataDir, cwd);
  try {
    if (now - statSync(path).mtimeMs > 24 * 3600 * 1000) return null;
    return statusContext(path, readFileSync(path, 'utf8'), maxChars);
  } catch {
    return null;
  }
}

// Prompts since this session last wrote `path` (Edit/Write/MultiEdit, or `scope status-next`), or null.
export function promptsSinceWrite(lines, path) {
  let since = null;
  for (const line of lines) {
    if (!line.includes(STATUS_FILE) && !line.includes(basename(path)) && since == null) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === 'assistant') {
      for (const b of row.message?.content ?? []) {
        if (b.type !== 'tool_use') continue;
        const file = b.input?.file_path;
        const cmd = b.name === 'Bash' ? b.input?.command ?? '' : '';
        if ((file && resolve(file) === path) || (cmd.includes('status-next') && cmd.includes(path))) since = 0;
      }
    } else if (row.type === 'user' && since != null && userText(row) != null) since++;
  }
  return since;
}

// Is the handoff file already current? Written by this session within `turns` prompts
// and changed on disk within `minutes`; a file another session wrote earlier is stale.
export function statusFreshness(lines, path, { turns, minutes }, now = Date.now()) {
  let mtime = null;
  try {
    mtime = path ? statSync(path).mtimeMs : null;
  } catch {}
  if (mtime == null) return { exists: false, fresh: false };
  const since = turns > 0 ? promptsSinceWrite(lines, path) : null;
  return { exists: true, fresh: since != null && since < turns && now - mtime <= minutes * 60000, since };
}

// Replace the `## Next` section (appended when missing); other sections stay as they are.
// Every further `## Next` section is dropped, so saving twice never grows the file and a file
// that already holds copies heals on the next save (2026-11-06: an ad-hoc `str.replace('', next)`
// left a Sandbox STATUS.md with 6,865 Next copies, 6.8 MB, and each save fixed only the first one).
export function replaceNext(text, body) {
  const next = `## Next\n${body.trim()}\n`;
  if (!text.trim()) return `# STATUS\n\n${next}`;
  const out = [];
  let at = -1;
  for (const part of text.split(/^(?=## )/m)) {
    if (!/^## Next\b/.test(part)) out.push(part);
    else if (at < 0) {
      at = out.length;
      out.push(next);
    }
  }
  if (at < 0) return `${text.trimEnd()}\n\n${next}`;
  if (at < out.length - 1) out[at] += '\n';
  return out.join('').trimEnd() + '\n';
}

// How to save state at a handoff, cheapest first. Each extra request re-reads the whole
// context, so the save rides along with the turn's last tool call and is never re-read or confirmed.
//   fresh  -> leave it (one Edit of Next only if this turn changed what comes next)
//   exists -> replace only Next in one call (status-next reads the body from stdin; no Read first)
//   none   -> one Write of the whole file
const RIDE_ALONG =
  ` Send that call in parallel with your last other tool call of this turn so it costs no extra request; ` +
  `if the turn has no other tool call, put your reply text in the same message before it and add no text after its result`;

export function saveClause(target, save = {}, ride = RIDE_ALONG) {
  if (save.fresh) {
    return `${target} is already current (you saved it ${save.since === 0 ? 'in your last reply' : `${save.since + 1} replies ago`}): do not rewrite, Read or check it; ` +
      `only if this turn changes what comes next, make one Edit to its Next section.` + ride;
  }
  if (save.exists && save.path && save.cli) {
    return `update ${target} in one call, without Reading it first or after: run ` +
      `\`node "${save.cli}" status-next "${save.path}" <<'EOF'\` with the new Next section body, then EOF ` +
      `(first line "Just done: ..." for what this session finished, then next steps, running work and open questions; under ~30 lines); ` +
      `it replaces only Next and keeps the other sections (if you already Read the file in this session, one Edit of Next works too).` + ride;
  }
  if (save.stream) {
    return `write ${target} in one Write call (Goal, Done, Next, Open questions; under ~80 lines; ` +
      `rewrite stale lines instead of appending; keep an existing file's language and layout) and do not Read it back.` + ride;
  }
  return `write ${target} in one Write call (Goal, Done, Decisions, Key files, Next, Open questions; under ~80 lines; ` +
    `rewrite stale lines instead of appending; keep an existing file's language and layout) and do not Read it back.` + ride;
}
