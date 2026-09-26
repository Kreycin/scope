import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoClearOn, autoClearNote, CLEARED_TITLE, markPending, takePending, pruneExports } from '../src/autoclear.mjs';
import { withDefaults } from '../src/config.mjs';
import { decide } from '../src/boundary.mjs';
import { privateStatusPath, loadPrivateStatus } from '../src/status.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'scope-ac-'));
const on = withDefaults({ handoff: { autoClear: { enabled: true } } });
const desktop = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' };

test('auto clear only in interactive desktop sessions with the flag on', () => {
  assert.equal(autoClearOn(on, { headless: false, env: desktop }), true);
  assert.equal(autoClearOn(withDefaults({}), { headless: false, env: desktop }), false);
  assert.equal(autoClearOn(on, { headless: true, env: desktop }), false);
  assert.equal(autoClearOn(on, { headless: false, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } }), false);
});

test('auto clear note asks for export then clear, clear last, with fallbacks', () => {
  const { context } = autoClearNote(150000, 'commit');
  assert.ok(context.includes('STATUS.md'));
  assert.ok(context.indexOf('export') < context.lastIndexOf('call the clear'));
  assert.match(context, /export failed, and to type \/clear/);
  assert.match(context, /if it is refused, tell the user to type \/clear/);
  assert.ok(context.indexOf('set_session_title') < context.lastIndexOf('call the clear'));
  assert.ok(context.includes(CLEARED_TITLE));
});

test('untrusted folders write a private file that is restored only after a clear', () => {
  const dir = tmp();
  const path = privateStatusPath(dir, '/some/repo');
  assert.ok(path.startsWith(join(dir, 'handoff')));
  const { context } = autoClearNote(150000, 'commit', path);
  assert.ok(context.includes(path));
  assert.doesNotMatch(context, /STATUS\.md/);
  assert.equal(loadPrivateStatus(dir, '/some/repo', { maxChars: 6000 }), null);
  mkdirSync(join(dir, 'handoff'), { recursive: true });
  writeFileSync(path, '# STATUS\nNext: x');
  assert.match(loadPrivateStatus(dir, '/some/repo', { maxChars: 6000 }), /Next: x/);
  assert.equal(loadPrivateStatus(dir, '/some/repo', { maxChars: 6000 }, Date.now() + 25 * 3600 * 1000), null);
});

test('decide uses the auto clear note when asked', async () => {
  const cfg = withDefaults({});
  const d = await decide({ sessionId: 's', contextTokens: 350000, lines: [], prompt: 'x', autoClear: true }, {}, cfg);
  assert.equal(d.autoClear, true);
  assert.ok(d.note.context.includes('clear_session'));
});

test('pending mark gives a recap once, only after a clear in the same folder', () => {
  const dir = tmp();
  const dl = tmp();
  markPending(dir, { cwd: '/p', now: 1000 });
  assert.equal(takePending(dir, { cwd: '/p', source: 'startup', now: 1000 + 6 * 60_000, downloads: dl }), null);
  assert.equal(takePending(dir, { cwd: '/q', source: 'clear', now: 2000, downloads: dl }), null);
  const recap = takePending(dir, { cwd: '/p', source: 'clear', now: 2000, downloads: dl });
  assert.ok(recap.includes('recap') && recap.includes('set_session_title'));
  assert.equal(takePending(dir, { cwd: '/p', source: 'clear', now: 3000, downloads: dl }), null);
});

test('desktop clear tool starts a fresh session: startup soon after the mark gets the recap', () => {
  const dir = tmp();
  const dl = tmp();
  markPending(dir, { cwd: '/p', session: 'abc-123', now: 1000 });
  assert.equal(takePending(dir, { cwd: '/q', source: 'startup', now: 42_000, downloads: dl }), null);
  const recap = takePending(dir, { cwd: '/p', source: 'startup', now: 42_000, downloads: dl });
  assert.ok(recap.includes('recap') && recap.includes('claude --resume abc-123'));
});

test('only exports made during an auto clear are pruned, oldest to the Trash', () => {
  const dir = tmp();
  const dl = tmp();
  const trash = join(tmp(), '.Trash');
  const mk = (name, t) => {
    const f = join(dl, name);
    writeFileSync(f, 'z');
    utimesSync(f, t / 1000, t / 1000);
    return f;
  };
  const manual = mk('session-export-1.zip', 1_000_000);
  const now = Date.now();
  const made = [];
  for (let i = 0; i < 3; i++) {
    markPending(dir, { cwd: '/p', now: now + i * 10_000 });
    made.push(mk(`session-export-${10 + i}.zip`, now + i * 10_000 + 5000));
    takePending(dir, { cwd: '/p', source: 'clear', now: now + i * 10_000 + 6000, downloads: dl });
  }
  mkdirSync(trash, { recursive: true });
  const moved = pruneExports(dir, 1, trash);
  assert.deepEqual(moved.sort(), [made[0], made[1]].sort());
  assert.ok(existsSync(manual));
  assert.ok(existsSync(made[2]));
  assert.ok(existsSync(join(trash, 'session-export-10.zip')));
});

test('statusContext keeps Next when it falls past the cut', async () => {
  const { statusContext } = await import('../src/status.mjs');
  const text = '# S\n## Done\n' + '- x\n'.repeat(100) + '## Next\n1. a\n2. b\n## End\n- z\n';
  const s = statusContext('/p', text, 120);
  assert.match(s, /## Next\n1\. a\n2\. b/);
  assert.doesNotMatch(statusContext('/p', '# S\n## Next\n1. a\n' + '- x\n'.repeat(100), 60), /## Next[\s\S]*## Next/);
});
