// Minimal TypeSafe System One client: POST {base}/v1/systemone { state, model, questions }.
// Same transport as the JEV repo's TypeSafe provider, kept separate so scope has no
// cross-repo import. Source: https://docs.typesafe.ai/api.md
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function loadApiKey(env = process.env, file = join(homedir(), '.config', 'typesafe', 'env')) {
  if (env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY.trim();
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*['"]?([^'"\s]+)['"]?\s*$/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

export async function systemOne({ state, questions, apiKey = loadApiKey(), timeoutMs = 3000, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('TYPESAFE_API_KEY not set');
  const base = (process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/$/, '');
  const res = await fetchImpl(`${base}/v1/systemone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: 'jev-latest', questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json || typeof json.answers !== 'object') throw new Error('unexpected response shape');
  return json;
}
