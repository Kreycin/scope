// Config: shipped defaults (src/profiles.json) with the user's overrides on top.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadApiKey } from './jev.mjs';

// Defaults, so a missing or partial profiles.json still runs safely.
export const DEFAULTS = {
  tokensPerTool: 30,
  always: [],
  profiles: {},
  connectors: { enabled: true },
  status: { maxChars: 6000, trustedRoots: [] },
  handoff: { enabled: true, min: 100000, max: 300000, regrow: 50000, jev: { enabled: false, threshold: 0.85, timeoutMs: 3000 }, autoClear: { enabled: false, keepExports: 5 } },
  idleBlock: { enabled: false, minutes: 60, minTokens: 50000 },
  bigSkill: { enabled: true, minTokens: 20000 },
};

export function withDefaults(raw) {
  const r = raw ?? {};
  return {
    ...DEFAULTS,
    ...r,
    connectors: { ...DEFAULTS.connectors, ...r.connectors },
    status: { ...DEFAULTS.status, ...r.status },
    handoff: {
      ...DEFAULTS.handoff,
      ...r.handoff,
      jev: { ...DEFAULTS.handoff.jev, ...r.handoff?.jev },
      autoClear: { ...DEFAULTS.handoff.autoClear, ...r.handoff?.autoClear },
    },
    idleBlock: { ...DEFAULTS.idleBlock, ...r.idleBlock },
    bigSkill: { ...DEFAULTS.bigSkill, ...r.bigSkill },
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Objects merge key by key; arrays and scalars in `over` replace.
export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

export function userConfigPath(env = process.env, home = homedir()) {
  if (env.SCOPE_USER_CONFIG) return env.SCOPE_USER_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'scope', 'config.json');
}

export function readUserConfig(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export function writeUserConfig(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

// Shipped file + user file. A broken user file throws, so hooks stay silent instead of guessing.
export function loadConfig(shippedPath, userPath, { apiKey = loadApiKey } = {}) {
  const shipped = JSON.parse(readFileSync(shippedPath, 'utf8'));
  const user = readUserConfig(userPath);
  const config = withDefaults(deepMerge(shipped, user));
  // JEV "auto": on only when a TypeSafe key is present.
  if (config.handoff.jev.enabled === 'auto') config.handoff.jev = { ...config.handoff.jev, enabled: !!apiKey() };
  config.setupDone = !!user.setupDone;
  return config;
}
