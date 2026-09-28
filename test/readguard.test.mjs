import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readGuard } from '../src/readguard.mjs';
import { withDefaults } from '../src/config.mjs';
import { loadState, saveState } from '../src/store.mjs';

const dir = mkdtempSync(join(tmpdir(), 'scope-rg-'));
const long = join(dir, 'long.ts');
const short = join(dir, 'short.ts');
writeFileSync(long, 'const x = 1;\n'.repeat(1500));
writeFileSync(short, 'const x = 1;\n'.repeat(100));
const cfg = withDefaults({});

test('first full read of a long file is denied, the same read again passes', () => {
  const state = {};
  const r = readGuard({ sessionId: 's', toolInput: { file_path: long } }, state, cfg);
  assert.match(r.deny, /1500 lines/);
  assert.match(r.deny, /offset and limit/);
  assert.equal(readGuard({ sessionId: 's', toolInput: { file_path: long } }, state, cfg), null);
  assert.ok(readGuard({ sessionId: 's', toolInput: { file_path: long } }, state, cfg).deny, 'a later full read is held again');
});

test('ranged, short, tail and binary reads pass', () => {
  const state = {};
  assert.equal(readGuard({ sessionId: 's', toolInput: { file_path: long, offset: 100, limit: 200 } }, state, cfg), null);
  assert.equal(readGuard({ sessionId: 's', toolInput: { file_path: long, offset: 1200 } }, state, cfg), null);
  assert.equal(readGuard({ sessionId: 's', toolInput: { file_path: short } }, state, cfg), null);
  assert.equal(readGuard({ sessionId: 's', toolInput: { file_path: join(dir, 'x.png') } }, state, cfg), null);
  assert.equal(readGuard({ sessionId: 's', toolInput: { file_path: join(dir, 'missing.ts') } }, state, cfg), null);
});

test('read guard and stalled-clear state survive a save and load', () => {
  const data = mkdtempSync(join(tmpdir(), 'scope-rgs-'));
  const state = loadState(data, 'sess');
  readGuard({ sessionId: 'sess', toolInput: { file_path: long } }, state, cfg);
  state.stalledClear = { sess: '2026-09-27T14:26:09Z' };
  saveState(data, 'sess', state, []);
  const back = loadState(data, 'sess');
  assert.deepEqual(back.readGuard.sess, [long]);
  assert.equal(back.stalledClear.sess, '2026-09-27T14:26:09Z');
});

test('hook-pre-read prints a PreToolUse deny once', () => {
  const env = { ...process.env, XDG_DATA_HOME: mkdtempSync(join(tmpdir(), 'scope-rgh-')), SCOPE_DATA_DIR: mkdtempSync(join(tmpdir(), 'scope-rgd-')) };
  const run = () => execFileSync('node', ['bin/scope.mjs', 'hook-pre-read'], { input: JSON.stringify({ session_id: 'h', tool_name: 'Read', tool_input: { file_path: long } }), env, encoding: 'utf8' });
  const out = JSON.parse(run());
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run().trim(), '');
});
