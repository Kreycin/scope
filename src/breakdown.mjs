// Attribute a session's input tokens to what filled the context.
//
// Each request's usage gives the exact context size C_i. The growth C_i - C_(i-1) is
// split among whatever entered the transcript between the two requests (previous
// output, tool results, hook injections, user text) in proportion to their size.
// An item then costs its tokens again on every later request until a compaction
// drops it, which is what cache read bills. Per-item sizes inside one step are
// estimates; step totals and the overall sum are exact.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const total = (u) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

export function toolCategory(name = '?') {
  if (name.startsWith('mcp__Claude_Browser__') || name.startsWith('mcp__claude-in-chrome__')) return 'tool:browser';
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  if (m) return `tool:mcp:${m[1].length > 20 ? m[1].slice(0, 8) : m[1]}`;
  return `tool:${name}`;
}

// An image costs ~1.5k tokens whatever its base64 length; count it as that many chars.
const IMAGE_CHARS = 1500 * 4;

function size(x) {
  if (x == null) return 0;
  if (typeof x === 'string') return x.length;
  if (Array.isArray(x)) return x.reduce((n, b) => n + (b?.type === 'image' ? IMAGE_CHARS : b?.type === 'text' ? size(b.text) : size(b)), 0);
  return JSON.stringify(x).length;
}

function detailOf(name, input = {}) {
  if (name === 'Read') return input.file_path;
  if (name === 'Bash') {
    const cmd = (input.command ?? '').trim().replace(/^cd\s+("[^"]*"|\S+)\s*(&&|;)\s*/, '');
    return cmd.split(/\s+/).slice(0, 2).join(' ');
  }
  return null;
}

// Parse transcript lines into requests, each with the items that arrived before it.
export function parseSession(lines) {
  const requests = [];
  const seen = new Set();
  const toolNames = new Map();
  let pending = [];
  let compacted = false;
  const push = (cat, chars, detail = null) => chars > 0 && pending.push({ cat, chars, detail });

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === 'system' && row.subtype === 'compact_boundary') compacted = true;
    if (row.type === 'assistant' && row.message) {
      const msg = row.message;
      const id = msg.id ?? row.uuid;
      if (msg.usage && !seen.has(id)) {
        seen.add(id);
        requests.push({ context: total(msg.usage), items: pending, compacted });
        pending = [];
        compacted = false;
      }
      for (const b of msg.content ?? []) {
        if (b.type === 'thinking') push('thinking', size(b.thinking));
        else if (b.type === 'text') push('assistant text', size(b.text));
        else if (b.type === 'tool_use') {
          toolNames.set(b.id, { name: b.name, detail: detailOf(b.name, b.input) });
          push(`args:${b.name}`, size(b.input), b.name === 'Write' || b.name === 'Edit' ? b.input?.file_path : null);
        }
      }
    } else if (row.type === 'user' && row.message) {
      const c = row.message.content;
      if (typeof c === 'string') push(row.isCompactSummary ? 'compact summary' : 'user prompt', c.length);
      else
        for (const b of c ?? []) {
          if (b.type === 'tool_result') {
            const t = toolNames.get(b.tool_use_id) ?? {};
            push(toolCategory(t.name), size(b.content), t.detail);
          } else if (b.type === 'text') push(row.isCompactSummary ? 'compact summary' : 'user prompt', size(b.text));
          else if (b.type === 'image') push('image', IMAGE_CHARS);
        }
    } else if (row.type === 'attachment' && row.attachment) {
      const { type, ...rest } = row.attachment;
      push(`inject:${type}`, size(rest), rest.hookName ? `${rest.hookName} ${String(rest.command ?? '').split('/').pop()}` : null);
    }
  }
  return requests;
}

// Returns { cost: {cat: tokens re-read}, added: {cat: tokens added}, details: {cat|detail: cost}, input }
export function attribute(requests) {
  const cost = {};
  const added = {};
  const details = {};
  let live = []; // { cat, detail, tokens }
  let prev = 0;
  let input = 0;
  const add = (m, k, v) => (m[k] = (m[k] ?? 0) + v);

  requests.forEach((req, i) => {
    const C = req.context;
    input += C;
    if (i === 0) {
      live = [{ cat: 'baseline (system+tools+skills)', tokens: C }];
      add(added, live[0].cat, C);
    } else {
      const delta = C - prev;
      if (req.compacted || delta < -0.3 * prev) {
        const base = live.find((x) => x.cat.startsWith('baseline'));
        live = base ? [base] : [];
        const rest = C - (base?.tokens ?? 0);
        if (rest > 0) {
          live.push({ cat: 'compact summary', tokens: rest });
          add(added, 'compact summary', rest);
        }
      } else if (delta > 0) {
        const chars = req.items.reduce((n, x) => n + x.chars, 0);
        if (!chars) {
          live.push({ cat: 'unattributed', tokens: delta });
          add(added, 'unattributed', delta);
        }
        for (const it of req.items) {
          const tokens = (delta * it.chars) / chars;
          live.push({ cat: it.cat, detail: it.detail, tokens });
          add(added, it.cat, tokens);
        }
      }
    }
    // Scale so this request's attributed total equals its real context size.
    const sum = live.reduce((n, x) => n + x.tokens, 0) || 1;
    for (const x of live) {
      const t = (x.tokens * C) / sum;
      add(cost, x.cat, t);
      if (x.detail) add(details, `${x.cat}|${x.detail}`, t);
    }
    prev = C;
  });
  return { cost, added, details, input, requests: requests.length };
}

function merge(into, from) {
  for (const k of ['cost', 'added', 'details']) for (const [c, v] of Object.entries(from[k])) into[k][c] = (into[k][c] ?? 0) + v;
  into.input += from.input;
  into.requests += from.requests;
  into.sessions += 1;
}

const empty = () => ({ cost: {}, added: {}, details: {}, input: 0, requests: 0, sessions: 0 });

export function breakdownAll({ root, days = 7, now = Date.now() }) {
  const since = now - days * 86400_000;
  const main = empty();
  const sub = empty();
  const lines = (p) => readFileSync(p, 'utf8').split('\n');
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(dir, f);
      if (statSync(path).mtimeMs < since) continue;
      const reqs = parseSession(lines(path));
      if (reqs.length) merge(main, attribute(reqs));
      const subDir = join(dir, f.replace(/\.jsonl$/, ''), 'subagents');
      if (!existsSync(subDir)) continue;
      for (const s of readdirSync(subDir)) {
        if (!s.endsWith('.jsonl')) continue;
        const r = parseSession(lines(join(subDir, s)));
        if (r.length) merge(sub, attribute(r));
      }
    }
  }
  return { days, main, sub };
}

const k = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

function table(b, top) {
  const rows = Object.entries(b.cost).sort((x, y) => y[1] - x[1]);
  const out = [`  ${'re-read'.padEnd(9)}${'share'.padEnd(7)}${'added'.padEnd(8)}source`];
  for (const [cat, v] of rows.slice(0, top)) {
    out.push(`  ${k(v).padEnd(9)}${`${((v / b.input) * 100).toFixed(1)}%`.padEnd(7)}${k(b.added[cat] ?? 0).padEnd(8)}${cat}`);
  }
  return out;
}

export function formatBreakdown({ days, main, sub }, { top = 18, details = 8 } = {}) {
  const out = [
    `last ${days}d main sessions: ${main.sessions} sessions, ${main.requests} requests, input ${k(main.input)}`,
    're-read = tokens billed across all later requests (cache read + write); added = tokens when first entered',
    ...table(main, top),
  ];
  for (const cat of ['tool:Read', 'tool:Bash', 'args:Write', 'args:Edit', 'inject:hook_additional_context']) {
    const rows = Object.entries(main.details)
      .filter(([key]) => key.startsWith(cat + '|'))
      .sort((x, y) => y[1] - x[1])
      .slice(0, details);
    if (!rows.length) continue;
    out.push('', `top ${cat}:`);
    for (const [key, v] of rows) out.push(`  ${k(v).padEnd(9)}${key.slice(cat.length + 1).replace(/^\/Users\/[^/]+\//, '~/')}`);
  }
  if (sub.sessions) {
    out.push('', `subagents: ${sub.sessions} runs, ${sub.requests} requests, input ${k(sub.input)}`, ...table(sub, 8));
  }
  return out.join('\n');
}
