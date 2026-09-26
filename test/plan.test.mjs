import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keywordHits, plan, summarize } from '../src/plan.mjs';

const config = JSON.parse(readFileSync(new URL('../src/profiles.json', import.meta.url), 'utf8'));

const status = {
  servers: [
    { name: 'jev', kind: 'user', status: 'connected', tool_count: 1 },
    { name: 'Vercel', kind: 'connector', status: 'connected', tool_count: 212 },
    { name: 'Supabase', kind: 'connector', status: 'connected', tool_count: 29 },
    { name: 'Canva', kind: 'connector', status: 'disabled' },
    { name: 'visualize', kind: 'connector', status: 'connected', tool_count: 2 },
    { name: 'Gmail', kind: 'connector', status: 'connected', tool_count: 6 },
  ],
};

test('ascii keywords match whole words only', () => {
  assert.equal(keywordHits('fix the doc', 'doc'), true);
  assert.equal(keywordHits('fix docker build', 'doc'), false);
  assert.equal(keywordHits('Deploy to Vercel', 'vercel'), true);
});

test('thai keywords match as substrings', () => {
  assert.equal(keywordHits('ช่วยดีพลอยเว็บหน่อย', 'ดีพลอย'), true);
});

test('coding task keeps only the always-on connectors', () => {
  const r = plan({ task: 'refactor the rerank function and add tests', status, config });
  assert.deepEqual(r.profiles, []);
  assert.deepEqual(r.want, ['visualize']);
  assert.deepEqual(r.disable.sort(), ['Gmail', 'Supabase', 'Vercel']);
  assert.deepEqual(r.enable, []);
  assert.equal(r.toolsRemoved, 247);
  assert.equal(r.estTokensSavedPerRequest, 247 * config.tokensPerTool);
});

test('multiple profiles union their connectors', () => {
  const r = plan({ task: 'deploy to vercel then run a supabase migration', status, config });
  assert.deepEqual(r.profiles.map((p) => p.name).sort(), ['db', 'deploy']);
  assert.deepEqual(r.disable, ['Gmail']);
});

test('a disabled connector the task needs is enabled', () => {
  const r = plan({ task: 'ทำโปสเตอร์ใน canva', status, config });
  assert.deepEqual(r.enable, ['Canva']);
});

test('--profile overrides keyword matching', () => {
  const r = plan({ task: 'anything', profiles: ['mail'], status, config });
  assert.deepEqual(r.profiles.map((p) => p.name), ['mail']);
  assert.ok(!r.disable.includes('Gmail'));
});

test('unknown profile is an error', () => {
  assert.throws(() => plan({ task: '', profiles: ['nope'], config }), /unknown profile/);
});

test('non-connector servers are never toggled', () => {
  const r = plan({ task: 'code', status, config });
  assert.ok(!r.disable.includes('jev'));
});

test('connectors named in a profile but not installed are reported', () => {
  const r = plan({ task: 'check my meeting notes', status, config });
  assert.deepEqual(r.missing, ['wispr flow']);
});

test('summarize totals only enabled connectors', () => {
  const s = summarize(status, config);
  assert.equal(s.connectorToolsOn, 212 + 29 + 2 + 6);
  assert.equal(s.connectors[0].name, 'Vercel');
});

import { emptyState, onPrompt, onStart } from '../src/hook.mjs';
import { sessionStats } from '../src/audit.mjs';

test('hook stays silent for a plain coding prompt', () => {
  const r = onPrompt({ prompt: 'fix the failing test in rerank', sessionId: 's1' }, emptyState(), config);
  assert.equal(r.context, null);
});

test('thai words that merely contain a keyword do not trigger', () => {
  const r = onPrompt({ prompt: 'ปกติแล้วถนัดเขียนแบบนี้', sessionId: 's1' }, emptyState(), config);
  assert.equal(r.context, null);
});

test('hook asks once per session for a needed connector', () => {
  let state = emptyState();
  const a = onPrompt({ prompt: 'deploy this to vercel', sessionId: 's1' }, state, config);
  assert.match(a.context, /Vercel/);
  const b = onPrompt({ prompt: 'deploy again to vercel', sessionId: 's1' }, a.state, config);
  assert.equal(b.context, null);
  assert.deepEqual(b.state.leftOn, ['Vercel']);
});

test('next session start asks to close what was left on, once', () => {
  const state = { leftOn: ['Vercel'], sessions: {} };
  const a = onStart({ sessionId: 's2', source: 'startup' }, state);
  assert.match(a.context, /Vercel/);
  assert.deepEqual(a.state.leftOn, []);
  assert.equal(onStart({ sessionId: 's3', source: 'startup' }, a.state).context, null);
});

test('resume does not trigger a close request', () => {
  const r = onStart({ sessionId: 's2', source: 'resume' }, { leftOn: ['Vercel'], sessions: {} });
  assert.equal(r.context, null);
});

test('audit counts each API response once', () => {
  const u = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 10 };
  const lines = [
    JSON.stringify({ type: 'assistant', message: { id: 'a', usage: u } }),
    JSON.stringify({ type: 'assistant', message: { id: 'a', usage: u } }),
    JSON.stringify({ type: 'assistant', message: { id: 'b', usage: { ...u, cache_read_input_tokens: 1000 } } }),
  ];
  const s = sessionStats(lines);
  assert.equal(s.requests, 2);
  assert.equal(s.baseline, 1002);
});

import { gate, decide } from '../src/boundary.mjs';

test('gate: signals hand off, big context hands off, otherwise ask JEV', () => {
  const s = emptyState();
  assert.equal(gate({ sessionId: 'g', contextTokens: 90000, signals: ['commit'] }, s, config).action, 'none');
  assert.equal(gate({ sessionId: 'g', contextTokens: 120000, signals: ['commit'] }, s, config).action, 'handoff');
  assert.equal(gate({ sessionId: 'g', contextTokens: 120000, signals: [] }, s, config).action, 'ask-jev');
  assert.equal(gate({ sessionId: 'g', contextTokens: 310000, signals: [] }, s, config).action, 'handoff');
});

test('gate waits for regrowth after a note and resets after a clear', () => {
  const s = { ...emptyState(), handoff: { g: 150000 } };
  assert.equal(gate({ sessionId: 'g', contextTokens: 180000, signals: ['commit'] }, s, config).action, 'none');
  assert.equal(gate({ sessionId: 'g', contextTokens: 210000, signals: ['commit'] }, s, config).action, 'handoff');
  const cleared = { ...emptyState(), handoff: { g: 150000 } };
  assert.equal(gate({ sessionId: 'g', contextTokens: 120000, signals: ['commit'] }, cleared, config).action, 'handoff');
});

test('decide asks JEV only without signals and follows its answer', async () => {
  const lines = [row({ type: 'assistant', message: { id: 'a', usage: usage(120000), content: [{ type: 'text', text: 'Added the page and it builds.' }] } })];
  const yes = { systemOne: async () => ({ answers: { step_done: { noul: 0.93 } } }) };
  const no = { systemOne: async () => ({ answers: { step_done: { noul: 0.4 } } }) };
  const boom = { systemOne: async () => { throw new Error('down'); } };
  const r1 = await decide({ sessionId: 'd1', contextTokens: 120000, lines, prompt: 'แล้วหน้า settings ล่ะ' }, emptyState(), config, yes);
  assert.match(r1.note.context, /STATUS\.md/);
  assert.match(r1.note.message, /JEV p=0\.93/);
  assert.doesNotMatch(r1.note.context, /clear_session/);
  const r2 = await decide({ sessionId: 'd2', contextTokens: 120000, lines, prompt: 'ปุ่มยังเพี้ยนอยู่' }, emptyState(), config, no);
  assert.equal(r2.note, null);
  const r3 = await decide({ sessionId: 'd3', contextTokens: 120000, lines, prompt: 'x' }, emptyState(), config, boom);
  assert.equal(r3.note, null);
  let called = false;
  const spy = { systemOne: async () => { called = true; return { answers: {} }; } };
  const r4 = await decide({ sessionId: 'd4', contextTokens: 120000, lines, prompt: 'โอเค เยี่ยม' }, emptyState(), config, spy);
  assert.equal(called, false);
  assert.match(r4.note.message, /user-ok/);
});

import { parseSession, attribute, toolCategory } from '../src/breakdown.mjs';

const row = (o) => JSON.stringify(o);
const usage = (n) => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: n, output_tokens: 1 });

test('breakdown splits growth by source and bills it on every later request', () => {
  const lines = [
    row({ type: 'assistant', message: { id: 'a', usage: usage(1000), content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } }),
    row({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(4000) }] } }),
    row({ type: 'assistant', message: { id: 'b', usage: usage(2000), content: [] } }),
    row({ type: 'assistant', message: { id: 'c', usage: usage(2000), content: [] } }),
  ];
  const r = attribute(parseSession(lines));
  assert.equal(r.requests, 3);
  assert.equal(Math.round(r.input), 5000);
  const sum = Object.values(r.cost).reduce((n, v) => n + v, 0);
  assert.equal(Math.round(sum), 5000);
  assert.equal(Math.round(r.cost['baseline (system+tools+skills)']), 3000);
  assert.ok(r.cost['tool:Read'] > 1800);
});

test('compaction drops earlier items', () => {
  const lines = [
    row({ type: 'assistant', message: { id: 'a', usage: usage(1000), content: [] } }),
    row({ type: 'user', message: { content: 'y'.repeat(9000) } }),
    row({ type: 'assistant', message: { id: 'b', usage: usage(10000), content: [] } }),
    row({ type: 'system', subtype: 'compact_boundary' }),
    row({ type: 'assistant', message: { id: 'c', usage: usage(1500), content: [] } }),
  ];
  const r = attribute(parseSession(lines));
  assert.equal(Math.round(r.cost['compact summary']), 500);
  assert.equal(Math.round(r.cost['user prompt']), 9000);
});

test('tool categories group MCP servers and browser', () => {
  assert.equal(toolCategory('mcp__Claude_Browser__navigate'), 'tool:browser');
  assert.equal(toolCategory('mcp__supabase__execute_sql'), 'tool:mcp:supabase');
  assert.equal(toolCategory('Bash'), 'tool:Bash');
});

import { isTrusted, statusContext } from '../src/status.mjs';

test('status is only injected from trusted roots', () => {
  assert.equal(isTrusted('/Users/u/Desktop/proj/STATUS.md', ['~/Desktop'], '/Users/u'), true);
  assert.equal(isTrusted('/Users/u/Downloads/x/STATUS.md', ['~/Desktop'], '/Users/u'), false);
  assert.equal(isTrusted('/Users/u/Desktopx/STATUS.md', ['~/Desktop'], '/Users/u'), false);
});

test('long status is truncated with a note', () => {
  const c = statusContext('/p/STATUS.md', 'x'.repeat(100), 10);
  assert.match(c, /truncated at 10 chars/);
});

import { parseTimeline, replay } from '../src/simulate.mjs';

test('timeline picks up commit and user-ok boundary signals', () => {
  const u = (n) => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: n, output_tokens: 1 });
  const lines = [
    row({ type: 'user', message: { content: 'build it' } }),
    row({ type: 'assistant', message: { id: 'a', usage: u(1000), content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'git commit -m x' } }] } }),
    row({ type: 'assistant', message: { id: 'b', usage: u(50000), content: [] } }),
    row({ type: 'user', message: { content: 'โอเค ต่อเรื่องถัดไป' } }),
    row({ type: 'assistant', message: { id: 'c', usage: u(60000), content: [] } }),
  ];
  const tl = parseTimeline(lines);
  assert.equal(tl.prompts.length, 1);
  assert.deepEqual(tl.prompts[0].signals.sort(), ['commit', 'user-ok']);
});

test('replay shrinks later requests after a clear and charges the save turn', () => {
  const tl = { requests: [{ context: 1000 }, { context: 50000 }, { context: 60000 }], prompts: [{ req: 2, signals: ['commit'] }] };
  const none = replay(tl, () => false, { statusTokens: 0 });
  assert.equal(none.input, 111000);
  const r = replay(tl, () => true, { statusTokens: 0 });
  // 1000 + 50000 + save turn 50000 + (60000 - 49000)
  assert.equal(r.input, 1000 + 50000 + 50000 + 11000);
  assert.equal(r.clears, 1);
});
