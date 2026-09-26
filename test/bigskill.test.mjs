import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBigSkills, readNewLines } from '../src/bigskill.mjs';

const row = (text, extra = {}) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] }, ...extra });
const body = (head, tokens) => head + '\n' + 'x'.repeat(tokens * 4);

test('finds big skill bodies by prefix or isMeta', () => {
  const lines = [
    row(body('Base directory for this skill: /tmp/skills/claude-api', 30000)),
    row(body('# Update Config Skill', 25000), { isMeta: true }),
    row(body('Base directory for this skill: /tmp/skills/small', 1000)),
    row(body('plain pasted text', 30000)),
  ];
  assert.deepEqual(findBigSkills(lines, 20000).map((s) => s.name), ['claude-api', 'Update Config Skill']);
});

test('compaction clears earlier bodies', () => {
  const lines = [row(body('Base directory for this skill: /a/big', 30000)), JSON.stringify({ type: 'system', subtype: 'compact_boundary' })];
  assert.deepEqual(findBigSkills(lines, 20000), []);
});

test('reads only complete lines added since last scan', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'scope-')), 't.jsonl');
  writeFileSync(f, 'a\nb\npart');
  const state = {};
  assert.deepEqual(readNewLines(f, state, 's'), ['a', 'b']);
  appendFileSync(f, 'ial\nc\n');
  assert.deepEqual(readNewLines(f, state, 's'), ['partial', 'c']);
  assert.deepEqual(readNewLines(f, state, 's'), []);
});
