// Find the heaviest 5-hour usage blocks and what filled them, weighted by price.
//
// The 5-hour limit counts cost in a short window, so it tracks bursts (parallel sessions,
// subagents, long thinking, cache rewrites) that the weekly total averages away. Blocks
// follow the limit's shape: a block starts at the first request after the previous one ends.
// Weights are API price ratios from profiles.json `pricing`; the real limit formula is not public.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const H5 = 5 * 3600_000;

export function requestCosts(lines, pricing, source = {}) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = row.type === 'assistant' ? row.message : null;
    const u = msg?.usage;
    if (!u || !row.timestamp) continue;
    const id = msg.id ?? row.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    const family = Object.keys(pricing.models).find((m) => (msg.model ?? '').includes(m)) ?? 'other';
    const fast = u.speed === 'fast';
    const scale = (pricing.models[family] ?? pricing.models.other) * (fast ? pricing.fastMultiplier : 1);
    const w5m = u.cache_creation?.ephemeral_5m_input_tokens;
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens;
    const writeUnits =
      w5m != null || w1h != null
        ? (w5m ?? 0) * pricing.cacheWrite5m + (w1h ?? 0) * pricing.cacheWrite1h
        : (u.cache_creation_input_tokens ?? 0) * pricing.cacheWrite1h;
    const thinking = u.output_tokens_details?.thinking_tokens ?? 0;
    const parts = {
      'cache read': (u.cache_read_input_tokens ?? 0) * pricing.cacheRead,
      'cache write': writeUnits,
      'uncached input': u.input_tokens ?? 0,
      thinking: Math.min(thinking, u.output_tokens ?? 0) * pricing.output,
      'output text': Math.max(0, (u.output_tokens ?? 0) - thinking) * pricing.output,
    };
    for (const k in parts) parts[k] *= scale;
    out.push({
      t: Date.parse(row.timestamp),
      session: source.session ?? row.sessionId,
      project: source.project,
      subagent: !!source.subagent,
      model: `${family}${fast ? ' fast' : ''}`,
      parts,
      cost: Object.values(parts).reduce((a, b) => a + b, 0),
    });
  }
  return out;
}

export function blocks(reqs) {
  const sorted = [...reqs].sort((a, b) => a.t - b.t);
  const out = [];
  let cur = null;
  for (const r of sorted) {
    if (!cur || r.t >= cur.start + H5) {
      cur = { start: r.t, reqs: [] };
      out.push(cur);
    }
    cur.reqs.push(r);
  }
  return out.map(summarizeBlock);
}

function add(map, key, v) {
  map[key] = (map[key] ?? 0) + v;
}

// Peak number of sessions sending requests within the same 10 minutes.
function peakParallel(reqs) {
  const bins = {};
  for (const r of reqs) (bins[Math.floor(r.t / 600_000)] ??= new Set()).add(r.session);
  return Math.max(0, ...Object.values(bins).map((s) => s.size));
}

export function summarizeBlock({ start, reqs }) {
  const parts = {};
  const models = {};
  const projects = {};
  let subagent = 0;
  for (const r of reqs) {
    for (const k in r.parts) add(parts, k, r.parts[k]);
    add(models, r.model, r.cost);
    add(projects, r.project ?? '?', r.cost);
    if (r.subagent) subagent += r.cost;
  }
  const cost = reqs.reduce((a, r) => a + r.cost, 0);
  return {
    start,
    cost,
    requests: reqs.length,
    sessions: new Set(reqs.map((r) => r.session)).size,
    peakParallel: peakParallel(reqs),
    subagent,
    parts,
    models,
    projects,
  };
}

export function windowAll({ root, days = 7, pricing, now = Date.now() }) {
  const since = now - days * 86400_000;
  const reqs = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    const name = project.name.replace(/^-Users-[^-]+-/, '').slice(0, 40);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(dir, f);
      if (statSync(path).mtimeMs < since) continue;
      const session = f.replace(/\.jsonl$/, '');
      reqs.push(...requestCosts(readFileSync(path, 'utf8').split('\n'), pricing, { session, project: name }));
      const subDir = join(dir, session, 'subagents');
      if (!existsSync(subDir)) continue;
      for (const s of readdirSync(subDir)) {
        if (!s.endsWith('.jsonl')) continue;
        const lines = readFileSync(join(subDir, s), 'utf8').split('\n');
        reqs.push(...requestCosts(lines, pricing, { session: `${session}/${s}`, project: name, subagent: true }));
      }
    }
  }
  const all = blocks(reqs.filter((r) => r.t >= since));
  return { days, blocks: all, total: summarizeBlock({ start: since, reqs: reqs.filter((r) => r.t >= since) }) };
}

const pct = (a, b) => `${b ? Math.round((100 * a) / b) : 0}%`;
const top = (map, total, n = 3) =>
  Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${pct(v, total)}`)
    .join(', ');

function line(b) {
  return [
    `  cost: ${top(b.parts, b.cost, 5)}`,
    `  models: ${top(b.models, b.cost)}; subagents ${pct(b.subagent, b.cost)}`,
    `  projects: ${top(b.projects, b.cost)}`,
  ].join('\n');
}

export function formatWindow(w, n = 5) {
  const costs = w.blocks.map((b) => b.cost).sort((a, b) => a - b);
  const median = costs[Math.floor(costs.length / 2)] ?? 0;
  const out = [
    `last ${w.days}d: ${w.blocks.length} five-hour blocks; cost units = price-weighted tokens (Mtok-equivalent of uncached input)`,
    `whole period:`,
    line(w.total),
    `median block ${(median / 1e6).toFixed(1)}M; heaviest blocks:`,
  ];
  for (const b of [...w.blocks].sort((a, b) => b.cost - a.cost).slice(0, n)) {
    const d = new Date(b.start);
    const when = `${d.toISOString().slice(5, 10)} ${d.toTimeString().slice(0, 5)}`;
    out.push(
      `${when}  ${(b.cost / 1e6).toFixed(1)}M (${(b.cost / (median || 1)).toFixed(1)}x median), ${b.requests} requests, ${b.sessions} sessions, peak ${b.peakParallel} in parallel`,
      line(b),
    );
  }
  return out.join('\n');
}
