import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idleCheck } from '../src/idle.mjs';

const config = { idleBlock: { enabled: true, minutes: 60, minTokens: 50000 } };
const t0 = Date.parse('2026-09-26T00:00:00Z');
const lines = [JSON.stringify({ type: 'assistant', timestamp: new Date(t0).toISOString(), message: { usage: { input_tokens: 1 } } })];
const at = (min) => t0 + min * 60000;

test('blocks once after idle on a big context, then lets the resend through', () => {
  const state = {};
  const first = idleCheck({ lines, contextTokens: 300000, sessionId: 's', prompt: 'go on', now: at(90) }, state, config);
  assert.match(first.reason, /300k tokens/);
  assert.match(first.reason, /go on/);
  assert.equal(idleCheck({ lines, contextTokens: 300000, sessionId: 's', now: at(91) }, state, config), null);
});

test('no block when recent, small, or disabled', () => {
  assert.equal(idleCheck({ lines, contextTokens: 300000, now: at(30) }, {}, config), null);
  assert.equal(idleCheck({ lines, contextTokens: 20000, now: at(90) }, {}, config), null);
  assert.equal(idleCheck({ lines, contextTokens: 300000, now: at(90) }, {}, { idleBlock: { ...config.idleBlock, enabled: false } }), null);
});
