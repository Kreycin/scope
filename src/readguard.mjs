// Read guard: a full Read of a long file stays in every later request. The first full
// Read of a file over `maxLines` is denied with a hint to read only the part needed;
// the same Read sent again goes through, so a real need for the whole file still works.
import { statSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

// Binary or rendered types the Read tool handles on its own terms.
const SKIP = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.ipynb', '.zip', '.mp4', '.mov', '.wav', '.mp3']);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REMEMBERED = 50;

export function countLines(path) {
  const st = statSync(path);
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  const buf = readFileSync(path);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  if (buf.length && buf[buf.length - 1] !== 10) n++;
  return { lines: n, bytes: st.size };
}

// Returns { deny: reason } or null. Updates state.readGuard[sessionId] (paths denied once).
export function readGuard({ sessionId = 'unknown', toolInput = {} }, state, config) {
  const path = toolInput.file_path;
  if (!path || toolInput.limit || SKIP.has(extname(path).toLowerCase())) return null;
  let info;
  try {
    info = countLines(path);
  } catch {
    return null;
  }
  if (!info) return null;
  const from = Math.max(1, Number(toolInput.offset) || 1);
  const lines = info.lines - from + 1;
  if (lines <= config.readGuard.maxLines) return null;
  state.readGuard ??= {};
  const denied = state.readGuard[sessionId] ?? [];
  if (denied.includes(path)) {
    state.readGuard[sessionId] = denied.filter((p) => p !== path);
    return null;
  }
  state.readGuard[sessionId] = [...denied, path].slice(-MAX_REMEMBERED);
  const k = Math.max(1, Math.round((info.bytes * lines) / info.lines / 4000));
  return {
    lines,
    deny:
      `scope: ${path} has ${lines} lines to read (~${k}k tokens), and a full read stays in every later request. ` +
      `Find the part you need first (grep -n for the symbol or section), then Read it with offset and limit (a few hundred lines). ` +
      `If you really need the whole file, send the same Read again and it goes through.`,
  };
}
