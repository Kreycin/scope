// Project state file: a short STATUS.md at the repo root that a fresh session reads
// instead of inheriting a long conversation.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const STATUS_FILE = 'STATUS.md';

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
  const body = cut ? text.slice(0, maxChars) : text;
  return (
    `scope: project state from ${path} (read this instead of asking what was done; continue from its Next section` +
    (cut ? `; truncated at ${maxChars} chars, Read the rest only if needed` : '') +
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

export function loadStatusContext(cwd, { maxChars, trustedRoots }) {
  const path = findStatus(cwd);
  if (!path || !isTrusted(path, trustedRoots)) return null;
  try {
    return statusContext(path, readFileSync(path, 'utf8'), maxChars);
  } catch {
    return null;
  }
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
