import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, sessionFileId, pruneSessions, log } from '../src/store.mjs';
import { isHeadless } from '../src/env.mjs';
import { withDefaults } from '../src/config.mjs';
import { handoffNote } from '../src/boundary.mjs';
import { bigSkillNote, readNewLines } from '../src/bigskill.mjs';
import { idleCheck } from '../src/idle.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'scope-'));

test('two sessions saving from the same stale load do not lose each other slice', () => {
  const dir = tmp();
  const a = loadState(dir, 'a');
  const b = loadState(dir, 'b');
  a.handoff = { a: 111000 };
  b.handoff = { b: 222000 };
  saveState(dir, 'a', a, a.leftOn);
  saveState(dir, 'b', b, b.leftOn);
  const a2 = loadState(dir, 'a');
  const b2 = loadState(dir, 'b');
  assert.equal(a2.handoff.a, 111000);
  assert.equal(b2.handoff.b, 222000);
});

test('leftOn delta merge: session A adds while B clears, both applied', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ leftOn: ['Y'] }));
  const loadedA = loadState(dir, 'A');
  const loadedLeftOnA = [...loadedA.leftOn];
  const loadedB = loadState(dir, 'B');
  const loadedLeftOnB = [...loadedB.leftOn];
  loadedA.leftOn = [...loadedA.leftOn, 'X'];
  loadedB.leftOn = loadedB.leftOn.filter((n) => n !== 'Y');
  saveState(dir, 'A', loadedA, loadedLeftOnA);
  saveState(dir, 'B', loadedB, loadedLeftOnB);
  const fresh = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(new Set(fresh.leftOn), new Set(['X']));
});

test('legacy migration from shared state.json maps', () => {
  const dir = tmp();
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ leftOn: ['Vercel'], sessions: { s1: ['Gmail'] }, handoff: { s1: 150000 }, idleBlock: { s1: 999 }, skillScan: { s1: 42 } })
  );
  const state = loadState(dir, 's1');
  assert.deepEqual(state.sessions.s1, ['Gmail']);
  assert.equal(state.handoff.s1, 150000);
  assert.equal(state.idleBlock.s1, 999);
  assert.equal(state.skillScan.s1, 42);
  assert.deepEqual(state.leftOn, ['Vercel']);
});

test('sessionFileId sanitizes and caps', () => {
  assert.equal(sessionFileId('abc-123_XYZ'), 'abc-123_XYZ');
  assert.equal(sessionFileId('a/b c:d'), 'a_b_c_d');
  assert.equal(sessionFileId(''), 'unknown');
  assert.equal(sessionFileId(undefined), 'unknown');
  assert.equal(sessionFileId('x'.repeat(200)).length, 100);
});

test('pruneSessions deletes old session files', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const old = join(dir, 'sessions', 'old.json');
  const fresh = join(dir, 'sessions', 'fresh.json');
  writeFileSync(old, '{}');
  writeFileSync(fresh, '{}');
  const past = new Date(Date.now() - 20 * 86400000);
  utimesSync(old, past, past);
  pruneSessions(dir, 14);
  assert.throws(() => statSync(old));
  assert.doesNotThrow(() => statSync(fresh));
});

test('isHeadless detects sdk entrypoint unless SCOPE_INTERACTIVE=1', () => {
  assert.equal(isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' }), true);
  assert.equal(isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), false);
  assert.equal(isHeadless({}), false);
  assert.equal(isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py', SCOPE_INTERACTIVE: '1' }), false);
});

test('non-restorable notes point to /compact and never mention STATUS.md', () => {
  const h = handoffNote(150000, 'commit', false);
  assert.match(h.message, /\/compact/);
  // The message explains why /clear won't help here, which names STATUS.md; only the
  // context (what drives the agent's behavior) must stay silent on it.
  assert.match(h.context, /\/compact/);
  assert.doesNotMatch(h.context, /STATUS\.md/);

  const b = bigSkillNote([{ name: 'claude-api', tokens: 30000 }], false);
  assert.match(b.message, /\/compact/);
  assert.doesNotMatch(b.message, /STATUS\.md/);
  assert.match(b.context, /\/compact/);
  assert.doesNotMatch(b.context, /STATUS\.md/);

  const t0 = Date.parse('2026-09-26T00:00:00Z');
  const lines = [JSON.stringify({ type: 'assistant', timestamp: new Date(t0).toISOString(), message: { usage: { input_tokens: 1 } } })];
  const idle = idleCheck(
    { lines, contextTokens: 300000, sessionId: 's', now: t0 + 90 * 60000, restorable: false },
    {},
    { idleBlock: { enabled: true, minutes: 60, minTokens: 50000 } }
  );
  assert.match(idle.reason, /\/compact/);
  assert.doesNotMatch(idle.reason, /STATUS\.md/);
});

test('readNewLines caps a big first read and drops the partial first line', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'scope-')), 't.jsonl');
  const line1 = 'a'.repeat(20);
  const line2 = 'b'.repeat(20);
  writeFileSync(f, `${line1}\n${line2}\n`);
  const state = {};
  // Cap smaller than the whole file but bigger than the last line: should drop the
  // partial leading fragment and return only the complete trailing line(s).
  const out = readNewLines(f, state, 's', 25);
  assert.deepEqual(out, [line2]);
});

test('withDefaults fills missing sections without dropping provided ones', () => {
  const merged = withDefaults({ handoff: { min: 5 }, pricing: { output: 5 } });
  assert.equal(merged.handoff.min, 5);
  assert.equal(merged.handoff.max, 300000);
  assert.equal(merged.handoff.jev.enabled, false);
  assert.equal(merged.idleBlock.enabled, false);
  assert.equal(merged.status.maxChars, 6000);
  assert.deepEqual(merged.pricing, { output: 5 });
});

test('log rotates the file once it exceeds the size limit', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'log.jsonl'), 'x'.repeat(200));
  log(dir, { cmd: 'test' }, 100);
  const rotated = readFileSync(join(dir, 'log.1.jsonl'), 'utf8');
  assert.equal(rotated, 'x'.repeat(200));
  const current = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim();
  assert.match(current, /"cmd":"test"/);
});
