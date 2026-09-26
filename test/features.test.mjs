import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, deepMerge } from '../src/config.mjs';
import { setFeatures } from '../src/features.mjs';

const shipped = new URL('../src/profiles.json', import.meta.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), 'scope-feat-'));

test('shipped defaults are safe for a new user', () => {
  const c = loadConfig(shipped, join(tmp(), 'none.json'), { apiKey: () => null });
  assert.equal(c.handoff.autoClear.enabled, false);
  assert.equal(c.idleBlock.enabled, false);
  assert.equal(c.handoff.jev.enabled, false);
  assert.deepEqual(c.status.trustedRoots, []);
  assert.equal(c.connectors.enabled, true);
  assert.equal(c.setupDone, false);
});

test('jev auto turns on when an API key exists', () => {
  const c = loadConfig(shipped, join(tmp(), 'none.json'), { apiKey: () => 'k' });
  assert.equal(c.handoff.jev.enabled, true);
});

test('user file overrides key by key and replaces lists', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2] } }), { a: { b: 1, c: [2] } });
  const dir = tmp();
  const user = join(dir, 'config.json');
  writeFileSync(user, JSON.stringify({ status: { trustedRoots: ['~/code'] }, handoff: { min: 5 } }));
  const c = loadConfig(shipped, user, { apiKey: () => null });
  assert.deepEqual(c.status.trustedRoots, ['~/code']);
  assert.equal(c.handoff.min, 5);
  assert.equal(c.handoff.max, 300000);
  assert.ok(Object.keys(c.profiles).length > 0);
});

test('broken user file throws so hooks stay silent', () => {
  const user = join(tmp(), 'config.json');
  writeFileSync(user, '{bad');
  assert.throws(() => loadConfig(shipped, user));
});

test('setFeatures writes only switches and marks setup done', () => {
  const user = join(tmp(), 'sub', 'config.json');
  setFeatures(user, ['autoClear=on', 'idleBlock=off', 'jev=auto']);
  const saved = JSON.parse(readFileSync(user, 'utf8'));
  assert.deepEqual(saved, { handoff: { autoClear: { enabled: true }, jev: { enabled: 'auto' } }, idleBlock: { enabled: false }, setupDone: true });
  assert.throws(() => setFeatures(user, ['nope=on']), /unknown feature/);
  assert.throws(() => setFeatures(user, ['idleBlock=auto']), /takes on\|off/);
});
