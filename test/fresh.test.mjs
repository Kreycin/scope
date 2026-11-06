import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { statusFreshness, promptsSinceWrite, replaceNext, saveClause, privateStatusPath } from '../src/status.mjs';
import { decide } from '../src/boundary.mjs';
import { autoClearNote } from '../src/autoclear.mjs';
import { withDefaults } from '../src/config.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'scope-fresh-'));
const ts = (m) => new Date(Date.UTC(2026, 10, 3, 10, m)).toISOString();
const assistant = (m, content, tokens = 150000) =>
  JSON.stringify({ type: 'assistant', timestamp: ts(m), message: { id: `a${m}`, usage: { input_tokens: tokens }, content } });
const prompt = (m, text) => JSON.stringify({ type: 'user', timestamp: ts(m), message: { content: text } });
const write = (m, file) => assistant(m, [{ type: 'tool_use', id: `t${m}`, name: 'Write', input: { file_path: file, content: 'x' } }]);
const reply = (m) => assistant(m, [{ type: 'text', text: 'done' }]);

function repo() {
  const dir = tmp();
  mkdirSync(join(dir, '.git'));
  const path = join(dir, 'STATUS.md');
  writeFileSync(path, '# STATUS\n\n## Done\n- a\n\n## Next\n1. old\n\n## Open questions\n- q\n');
  return { dir, path };
}

test('a file this session saved within the window is fresh', () => {
  const { path } = repo();
  const lines = [prompt(0, 'build it'), write(1, path), reply(2)];
  assert.equal(promptsSinceWrite(lines, path), 0);
  assert.deepEqual(statusFreshness(lines, path, { turns: 2, minutes: 30 }), { exists: true, fresh: true, since: 0 });
  // One prompt later still fresh with turns 2, stale with turns 1.
  const later = [...lines, prompt(3, 'and this'), reply(4)];
  assert.equal(statusFreshness(later, path, { turns: 2, minutes: 30 }).fresh, true);
  assert.equal(statusFreshness(later, path, { turns: 1, minutes: 30 }).fresh, false);
  // turns 0 turns the check off.
  assert.equal(statusFreshness(lines, path, { turns: 0, minutes: 30 }).fresh, false);
});

test('older writes, other files, old mtimes and missing files are stale', () => {
  const { path } = repo();
  const other = [prompt(0, 'x'), write(1, '/elsewhere/STATUS.md'), reply(2)];
  assert.deepEqual(statusFreshness(other, path, { turns: 2, minutes: 30 }), { exists: true, fresh: false, since: null });
  const old = [prompt(0, 'x'), write(1, path), prompt(2, 'a'), prompt(3, 'b'), reply(4)];
  assert.equal(statusFreshness(old, path, { turns: 2, minutes: 30 }).fresh, false);
  // Tool results and command echoes are not prompts.
  const echoes = [write(1, path), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }), prompt(2, '<command-name>/x</command-name>')];
  assert.equal(promptsSinceWrite(echoes, path), 0);
  const recent = [prompt(0, 'x'), write(1, path), reply(2)];
  const hourAgo = (Date.now() - 3600 * 1000) / 1000;
  utimesSync(path, hourAgo, hourAgo);
  assert.equal(statusFreshness(recent, path, { turns: 2, minutes: 30 }).fresh, false);
  assert.deepEqual(statusFreshness(recent, join(tmp(), 'STATUS.md'), { turns: 2, minutes: 30 }), { exists: false, fresh: false });
});

test('a status-next command counts as a write', () => {
  const { path } = repo();
  const bash = assistant(1, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `node "/p/bin/scope.mjs" status-next "${path}" <<'EOF'\n1. a\nEOF` } }]);
  assert.equal(promptsSinceWrite([prompt(0, 'x'), bash], path), 0);
});

test('save clause: fresh leaves the file, stale replaces Next in one call, missing writes once', () => {
  const fresh = saveClause('STATUS.md at the repo root', { exists: true, fresh: true, since: 0 });
  assert.match(fresh, /already current/);
  assert.match(fresh, /do not rewrite, Read or check it/);
  assert.doesNotMatch(fresh, /status-next|Write call/);
  const stale = saveClause('STATUS.md at the repo root', { exists: true, fresh: false, path: '/r/STATUS.md', cli: '/p/bin/scope.mjs' });
  assert.match(stale, /node "\/p\/bin\/scope\.mjs" status-next "\/r\/STATUS\.md"/);
  assert.match(stale, /without Reading it first or after/);
  assert.match(stale, /replaces only Next/);
  const none = saveClause('STATUS.md at the repo root', {});
  assert.match(none, /one Write call/);
  assert.match(none, /do not Read it back/);
  // Every branch rides along with the turn's last tool call instead of costing its own request.
  for (const c of [fresh, stale, none]) assert.match(c, /in parallel with your last other tool call/);
});

test('decide passes freshness into the handoff and auto clear notes', async () => {
  const cfg = withDefaults({ handoff: { jev: { enabled: false } } });
  const lines = [prompt(0, 'x'), assistant(1, [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'git commit -m x' } }])];
  const save = { exists: true, fresh: true, since: 0 };
  const d = await decide({ sessionId: 's', contextTokens: 150000, lines, prompt: 'ok', save }, {}, cfg);
  assert.match(d.note.message, /saved state is current: type \/clear/);
  assert.match(d.note.context, /already current/);
  assert.match(d.note.context, /no separate confirmation turn/);
  assert.equal(d.log.save, 'fresh');
  const stale = await decide({ sessionId: 's2', contextTokens: 150000, lines, prompt: 'ok', save: { exists: true, path: '/r/STATUS.md', cli: '/c' } }, {}, cfg);
  assert.match(stale.note.message, /After Claude saves its state/);
  assert.match(stale.note.context, /status-next/);
  assert.equal(stale.log.save, 'next');
  const ac = autoClearNote(150000, 'commit', '/r/STATUS.md', save);
  assert.match(ac.context, /already current/);
  assert.match(ac.context, /clear_session/);
  assert.match(ac.context, /in parallel with the ToolSearch call/);
  assert.doesNotMatch(ac.context, /last other tool call/);
});

test('replaceNext swaps only the Next body and appends one when missing', () => {
  const text = '# STATUS\n\n## Done\n- a\n\n## Next\n1. old\n2. older\n\n## Open questions\n- q\n';
  assert.equal(replaceNext(text, 'Just done: b\n1. new\n'), '# STATUS\n\n## Done\n- a\n\n## Next\nJust done: b\n1. new\n\n## Open questions\n- q\n');
  assert.equal(replaceNext('# STATUS\n\n## Next\n1. old\n', '1. new'), '# STATUS\n\n## Next\n1. new\n');
  assert.equal(replaceNext('# STATUS\n\n## Done\n- a\n', '1. new'), '# STATUS\n\n## Done\n- a\n\n## Next\n1. new\n');
  assert.equal(replaceNext('', '1. new'), '# STATUS\n\n## Next\n1. new\n');
});

test('replaceNext keeps one Next section, so saving twice never grows the file', () => {
  const dup = '# STATUS\n\n## Next\n1. a\n\n## Next\n1. a\n\n## Done\n- d\n\n## Next\n1. b\n';
  const once = replaceNext(dup, '1. new');
  assert.equal(once, '# STATUS\n\n## Next\n1. new\n\n## Done\n- d\n');
  assert.equal(replaceNext(once, '1. new'), once);
  // 2026-11-06: Python `s.replace('', block)` put a Next block between every character of the file.
  const block = '## Next\nJust done: v\n- x\n\n';
  const original = '# STATUS — t\n\nGoal: g\n\n## Done\n- a\n\n## Next\n1. old\n';
  const shredded = block + [...original].join(block) + block;
  const healed = replaceNext(shredded, '1. new');
  assert.equal((healed.match(/## Next/g) || []).length, 1);
  assert.ok(healed.length < 40, healed);
  assert.equal(replaceNext(healed, '1. new'), healed);
});

test('status-next run twice leaves one Next and the same file', () => {
  const { path } = repo();
  const env = { ...process.env, SCOPE_DATA_DIR: tmp() };
  writeFileSync(path, readFileSync(path, 'utf8') + '\n## Next\n1. copy\n'.repeat(50));
  const run = () => execFileSync('node', ['bin/scope.mjs', 'status-next', path], { input: 'Just done: x\n- y\n', env, encoding: 'utf8' });
  run();
  const first = readFileSync(path, 'utf8');
  const out = run();
  assert.equal(readFileSync(path, 'utf8'), first);
  assert.equal((first.match(/^## Next/gm) || []).length, 1);
  assert.match(out, /\(11 lines\)/);
});

test('status-next CLI writes Next and refuses other files', () => {
  const { path } = repo();
  const env = { ...process.env, SCOPE_DATA_DIR: tmp() };
  const out = execFileSync('node', ['bin/scope.mjs', 'status-next', path], { input: '1. new\n', env, encoding: 'utf8' });
  assert.match(out, /saved Next/);
  assert.match(readFileSync(path, 'utf8'), /## Next\n1\. new\n\n## Open questions/);
  const priv = privateStatusPath(env.SCOPE_DATA_DIR, '/some/repo');
  execFileSync('node', ['bin/scope.mjs', 'status-next', priv], { input: '1. p\n', env, encoding: 'utf8' });
  assert.match(readFileSync(priv, 'utf8'), /## Next\n1\. p/);
  assert.throws(() => execFileSync('node', ['bin/scope.mjs', 'status-next', join(tmp(), 'notes.md')], { input: 'x', env, stdio: 'pipe' }));
});

function runHook(cwd, lines, userConfig) {
  const dir = tmp();
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, lines.join('\n') + '\n');
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ setupDone: true, connectors: { enabled: false }, ...userConfig }));
  const env = { ...process.env, SCOPE_DATA_DIR: join(dir, 'data'), SCOPE_USER_CONFIG: cfgPath, CLAUDE_CODE_ENTRYPOINT: 'cli', SCOPE_INTERACTIVE: '1', TYPESAFE_API_KEY: '' };
  const out = execFileSync('node', ['bin/scope.mjs', 'hook-prompt'], {
    input: JSON.stringify({ session_id: 'h', cwd, transcript_path: transcript, prompt: 'ok next' }),
    env,
    encoding: 'utf8',
  });
  return { out: out ? JSON.parse(out) : null, dataDir: env.SCOPE_DATA_DIR };
}

test('hook: trusted repo gets the short note when fresh, the status-next note when stale', () => {
  const { dir, path } = repo();
  const cfg = { status: { trustedRoots: [dir] }, handoff: { jev: { enabled: false } } };
  const fresh = runHook(dir, [prompt(0, 'x'), write(1, path), reply(2)], cfg).out;
  assert.match(fresh.systemMessage, /saved state is current/);
  assert.match(fresh.hookSpecificOutput.additionalContext, /already current/);
  const stale = runHook(dir, [prompt(0, 'x'), reply(1)], cfg).out;
  assert.match(stale.hookSpecificOutput.additionalContext, new RegExp(`status-next "${resolve(path)}"`));
});

test('hook: untrusted folder keeps the private handoff file as target', () => {
  const dir = tmp();
  const { out, dataDir } = runHook(dir, [prompt(0, 'x'), reply(1)], { handoff: { jev: { enabled: false } } });
  const priv = privateStatusPath(dataDir, dir);
  assert.ok(out.hookSpecificOutput.additionalContext.includes(`${priv} (private handoff file`));
  assert.match(out.hookSpecificOutput.additionalContext, /one Write call/);
});
