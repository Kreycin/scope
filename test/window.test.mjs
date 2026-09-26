import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestCosts, blocks } from '../src/window.mjs';

const { pricing } = JSON.parse(readFileSync(new URL('../src/profiles.json', import.meta.url), 'utf8'));
const row = (id, ts, model, usage) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage } });

test('weights parts by price and counts a response once', () => {
  const u = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 100 }, output_tokens: 50, output_tokens_details: { thinking_tokens: 20 } };
  const lines = [row('a', '2026-09-26T00:00:00Z', 'claude-opus-5-5', u), row('a', '2026-09-26T00:00:00Z', 'claude-opus-5-5', u)];
  const [r] = requestCosts(lines, pricing, { session: 's' });
  assert.equal(requestCosts(lines, pricing).length, 1);
  assert.deepEqual(r.parts, { 'cache read': 100, 'cache write': 200, 'uncached input': 10, thinking: 100, 'output text': 150 });
  const [fast] = requestCosts([row('b', '2026-09-26T00:00:00Z', 'claude-sonnet-5', { ...u, speed: 'fast' })], pricing);
  assert.ok(Math.abs(fast.cost - r.cost * pricing.models.sonnet * pricing.fastMultiplier) < 1e-6);
});

test('a block starts at the first request after the previous block ends', () => {
  const at = (h) => ({ t: Date.parse('2026-09-26T00:00:00Z') + h * 3600_000, session: 's', parts: { x: 1 }, cost: 1, model: 'opus' });
  const b = blocks([at(0), at(4.9), at(5.1), at(9.9), at(10.2)]);
  assert.deepEqual(b.map((x) => x.requests), [2, 2, 1]);
});
