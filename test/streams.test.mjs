// Parallel streams: STATUS.md is the project index, each session keeps its own status/<slug>.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { streamPaths, streamFromLines, isStreamFile, loadStatusContext, streamLine, saveClause } from '../src/status.mjs';
import { markPending, pendingStream } from '../src/autoclear.mjs';
import { loadState, saveState } from '../src/store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'scope-streams-'));
const ts = (m) => new Date(Date.UTC(2026, 10, 3, 10, m)).toISOString();
const assistant = (m, content, tokens = 150000) =>
  JSON.stringify({ type: 'assistant', timestamp: ts(m), message: { id: `a${m}`, usage: { input_tokens: tokens }, content } });
const prompt = (m, text) => JSON.stringify({ type: 'user', timestamp: ts(m), message: { content: text } });
const edit = (m, file) => assistant(m, [{ type: 'tool_use', id: `t${m}`, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }]);
const bash = (m, command) => assistant(m, [{ type: 'tool_use', id: `t${m}`, name: 'Bash', input: { command } }]);
const reply = (m) => assistant(m, [{ type: 'text', text: 'done' }]);

function project() {
  const dir = tmp();
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, 'status'));
  const index = join(dir, 'STATUS.md');
  writeFileSync(index, '# STATUS\n\nGoal: g\n\n## Streams\n| stream | file | owner | state |\n|---|---|---|---|\n| a | status/a.md | s1 | x |\n\n## Decisions\n- d\n');
  const a = join(dir, 'status', 'a.md');
  const b = join(dir, 'status', 'b.md');
  writeFileSync(a, '# a\n\n## Done\n- a1\n\n## Next\nJust done: a0\n1. alpha step\n');
  writeFileSync(b, '# b\n\n## Next\n1. beta step\n');
  writeFileSync(join(dir, 'status', '_template.md'), '# t\n');
  return { dir, index, a, b };
}

test('streamPaths lists status/*.md, skipping _ files', () => {
  const { index, a, b } = project();
  assert.deepEqual(streamPaths(index), [a, b]);
  assert.match(streamLine(a), /^- a \(updated \d{4}-\d\d-\d\d\): 1\. alpha step$/);
});

test('isStreamFile needs status/<slug>.md with STATUS.md one level up', () => {
  const { dir, a } = project();
  assert.ok(isStreamFile(a));
  assert.ok(isStreamFile(join(dir, 'status', 'new.md')));
  assert.ok(!isStreamFile(join(tmp(), 'status', 'x.md')));
  assert.ok(!isStreamFile(join(dir, 'notes.md')));
});

test('streamFromLines finds the stream this session wrote last (Edit or status-next)', () => {
  const { index, a, b } = project();
  assert.equal(streamFromLines([prompt(0, 'x'), reply(1)], index), null);
  assert.equal(streamFromLines([edit(1, a)], index), a);
  assert.equal(streamFromLines([edit(1, a), bash(2, `node "/p/bin/scope.mjs" status-next "${b}" <<'EOF'`)], index), b);
  // Another project's status folder does not count.
  assert.equal(streamFromLines([edit(1, join(tmp(), 'status', 'z.md'))], index), null);
});

test('start context: own stream is loaded with the index; unknown stream gets a list, not the files', () => {
  const { dir, a } = project();
  const cfg = { maxChars: 6000, trustedRoots: [dir] };
  const own = loadStatusContext(dir, cfg, a);
  assert.match(own, /your stream .*a\.md/);
  assert.match(own, /alpha step/);
  assert.doesNotMatch(own, /beta step/);
  const none = loadStatusContext(dir, cfg, null);
  assert.match(none, /pick yours/);
  assert.match(none, /- a \(updated .*\): 1\. alpha step/);
  assert.match(none, /- b \(updated .*\): 1\. beta step/);
  assert.doesNotMatch(none, /a1/);
  // A stream path from elsewhere is ignored.
  assert.match(loadStatusContext(dir, cfg, join(tmp(), 'status', 'a.md')), /pick yours/);
});

test('a project without streams keeps the old single-file context', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'STATUS.md'), '# STATUS\n\n## Next\n1. one\n');
  assert.match(loadStatusContext(dir, { maxChars: 6000, trustedRoots: [dir] }), /^scope: project state from/);
});

test('saveClause asks for stream sections when the stream file is not known yet', () => {
  assert.match(saveClause('your stream file x', { stream: true }), /Goal, Done, Next, Open questions/);
});

test('auto clear hands the stream to the next session; session state keeps it', () => {
  const data = tmp();
  markPending(data, { cwd: '/r', session: 's1', stream: '/r/status/a.md' });
  assert.equal(pendingStream(data, { cwd: '/r', source: 'clear' }), '/r/status/a.md');
  assert.equal(pendingStream(data, { cwd: '/other', source: 'clear' }), null);
  assert.equal(pendingStream(data, { cwd: '/r', source: 'compact' }), null);
  const st = loadState(data, 's2');
  st.stream = { s2: '/r/status/a.md' };
  saveState(data, 's2', st, []);
  assert.equal(loadState(data, 's2').stream.s2, '/r/status/a.md');
});

function hook(cmd, dir, input, dataDir) {
  const cfgPath = join(tmp(), 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ setupDone: true, connectors: { enabled: false }, status: { trustedRoots: [dir] }, handoff: { jev: { enabled: false } } }));
  const env = { ...process.env, SCOPE_DATA_DIR: dataDir, SCOPE_USER_CONFIG: cfgPath, CLAUDE_CODE_ENTRYPOINT: 'cli', SCOPE_INTERACTIVE: '1', TYPESAFE_API_KEY: '' };
  const out = execFileSync('node', ['bin/scope.mjs', cmd], { input: JSON.stringify({ cwd: dir, ...input }), env, encoding: 'utf8' });
  return out ? JSON.parse(out) : null;
}

test('hook: handoff targets the own stream file, and a compacted session gets it back', () => {
  const { dir, a } = project();
  const data = tmp();
  const transcript = join(tmp(), 't.jsonl');
  writeFileSync(transcript, [prompt(0, 'x'), edit(1, a), reply(2), prompt(3, 'y'), reply(4)].join('\n') + '\n');
  const out = hook('hook-prompt', dir, { session_id: 's1', transcript_path: transcript, prompt: 'ok next' }, data);
  assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`your stream file ${resolve(a)}`));
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /STATUS\.md at the repo root/);
  const start = hook('hook-start', dir, { session_id: 's1', source: 'compact' }, data);
  assert.match(start.hookSpecificOutput.additionalContext, /alpha step/);
  assert.doesNotMatch(start.hookSpecificOutput.additionalContext, /pick yours/);
});

test('hook: a session that has not picked a stream is told to pick one, not to rewrite STATUS.md', () => {
  const { dir } = project();
  const transcript = join(tmp(), 't.jsonl');
  writeFileSync(transcript, [prompt(0, 'x'), reply(1)].join('\n') + '\n');
  const out = hook('hook-prompt', dir, { session_id: 's9', transcript_path: transcript, prompt: 'ok next' }, tmp());
  assert.match(out.hookSpecificOutput.additionalContext, /status\/<slug>\.md \(the stream you work on/);
  assert.match(out.hookSpecificOutput.additionalContext, /Goal, Done, Next, Open questions/);
});

test('status-next writes a stream file and starts a new one with its slug as title', () => {
  const { dir, a } = project();
  const env = { ...process.env, SCOPE_DATA_DIR: tmp() };
  execFileSync('node', ['bin/scope.mjs', 'status-next', a], { input: '1. new alpha\n', env, encoding: 'utf8' });
  assert.match(readFileSync(a, 'utf8'), /## Done\n- a1\n\n## Next\n1\. new alpha\n$/);
  const fresh = join(dir, 'status', 'c.md');
  execFileSync('node', ['bin/scope.mjs', 'status-next', fresh], { input: '1. gamma\n', env, encoding: 'utf8' });
  assert.equal(readFileSync(fresh, 'utf8'), '# c\n\n## Next\n1. gamma\n');
});
