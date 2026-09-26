// Replay real transcripts under different "save STATUS.md and /clear" policies.
//
// A clear can only happen at a user prompt. After a clear at context C_p the session
// restarts at R = baseline + status file, and every later request is assumed to carry
// the same growth it really had: C_i' = max(R, C_i - C_p + R). Each clear also costs
// one extra request of size C_p (the turn that writes STATUS.md).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const total = (u) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

const TEST_CMD = /(npm|pnpm|yarn)( run)? test|node --test|pytest|vitest|jest|go test|cargo test/;
const TEST_FAIL = /\bfail(ed|ing)?\s*[:=]?\s*[1-9]|[1-9]\d* (failed|failing)|FAILED|not ok/i;
const TEST_PASS = /\bpass(ed)?\b|✓|\bok\b/i;
const DONE_START = /^\s*(โอเค|ok\b|okay|เยี่ยม|ดีมาก|เสร็จ|ผ่าน|done\b|great\b|nice\b)/i;
const NEW_TOPIC = /เรื่องใหม่|งานใหม่|ทีนี้เรา|ต่อไปเรา|เรื่องต่อไป|อีกเรื่อง|next task|new task/i;
const GAP_MS = 30 * 60 * 1000;

function userText(row) {
  if (row.isMeta || row.isCompactSummary) return null;
  const c = row.message?.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c) && !c.some((b) => b.type === 'tool_result')) text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (!text || /^\s*</.test(text)) return null; // command echoes, system tags
  return text;
}

// Returns requests [{context}] and prompts [{req, signals}] where req is the index of the
// first request answering that prompt.
export function parseTimeline(lines) {
  const tl = scanTimeline(lines);
  return { requests: tl.requests, prompts: tl.prompts.filter((p) => p.req > 0 && p.req < tl.requests.length) };
}

// Same scan, keeping every prompt (including a trailing one with no answer yet) and the
// last assistant text, which the prompt hook uses.
export function scanTimeline(lines) {
  const requests = [];
  const prompts = [];
  const seen = new Set();
  const tools = new Map();
  let signals = new Set();
  let lastTs = null;
  let lastAssistantText = '';
  let recentTools = [];
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = row.timestamp ? Date.parse(row.timestamp) : null;
    if (row.type === 'assistant' && row.message) {
      const msg = row.message;
      const id = msg.id ?? row.uuid;
      if (msg.usage && !seen.has(id)) {
        seen.add(id);
        requests.push({ context: total(msg.usage) });
      }
      for (const b of msg.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) lastAssistantText = b.text;
        if (b.type !== 'tool_use') continue;
        tools.set(b.id, b);
        recentTools.push(b.name);
        const cmd = b.input?.command ?? '';
        if (b.name === 'Bash' && /git commit/.test(cmd)) signals.add('commit');
        if ((b.name === 'Edit' || b.name === 'Write') && /STATUS\.md$/i.test(b.input?.file_path ?? '')) signals.add('status-edit');
      }
    } else if (row.type === 'user' && row.message) {
      const c = row.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          const t = tools.get(b.tool_use_id);
          if (t?.name !== 'Bash' || !TEST_CMD.test(t.input?.command ?? '')) continue;
          const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          if (!b.is_error && TEST_PASS.test(out) && !TEST_FAIL.test(out)) signals.add('tests-pass');
        }
      }
      const text = userText(row);
      if (text != null) {
        if (DONE_START.test(text)) signals.add('user-ok');
        if (NEW_TOPIC.test(text)) signals.add('new-topic');
        if (ts && lastTs && ts - lastTs > GAP_MS) signals.add('idle-gap');
        prompts.push({ req: requests.length, signals: [...signals], text, lastAssistantText, tools: recentTools.slice(-12) });
        signals = new Set();
        recentTools = [];
      }
    }
    if (ts) lastTs = ts;
  }
  return { requests, prompts };
}

// policy(prompt, liveContext) -> true to clear before this prompt's first request.
export function replay({ requests, prompts }, policy, { statusTokens = 2000 } = {}) {
  if (!requests.length) return { input: 0, clears: 0, atBoundary: 0 };
  const R = requests[0].context + statusTokens;
  const clearAt = new Map(prompts.map((p) => [p.req, p]));
  let offset = 0; // tokens removed by clears so far
  let input = 0;
  let clears = 0;
  let atBoundary = 0;
  requests.forEach((r, i) => {
    const p = clearAt.get(i);
    if (p && i > 0) {
      const prevLive = Math.max(R, requests[i - 1].context - offset);
      if (prevLive > R && policy(p, prevLive)) {
        input += prevLive; // the extra turn that writes STATUS.md
        offset = requests[i - 1].context - R;
        clears++;
        if (p.signals.length) atBoundary++;
      }
    }
    input += Math.max(R, r.context - offset);
  });
  return { input, clears, atBoundary };
}

const boundary = (p) => p.signals.length > 0;
const firmBoundary = (p) => p.signals.some((s) => s !== 'idle-gap');

export const POLICIES = {
  'no clear (actual)': () => false,
  'size >=200k (current)': (p, c) => c >= 200_000,
  'boundary & >=100k': (p, c) => boundary(p) && c >= 100_000,
  'boundary & >=60k': (p, c) => boundary(p) && c >= 60_000,
  'boundary & >=100k, else >=300k': (p, c) => (boundary(p) && c >= 100_000) || c >= 300_000,
  'firm boundary (no idle) & >=100k, else >=300k': (p, c) => (firmBoundary(p) && c >= 100_000) || c >= 300_000,
};

export function simulateAll({ root, days = 7, now = Date.now() }) {
  const since = now - days * 86400_000;
  const sums = Object.fromEntries(Object.keys(POLICIES).map((k) => [k, { input: 0, clears: 0, atBoundary: 0 }]));
  const signalCounts = {};
  let prompts = 0;
  let sessions = 0;
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(dir, f);
      if (statSync(path).mtimeMs < since) continue;
      const tl = parseTimeline(readFileSync(path, 'utf8').split('\n'));
      if (!tl.requests.length) continue;
      sessions++;
      prompts += tl.prompts.length;
      for (const p of tl.prompts) for (const s of p.signals) signalCounts[s] = (signalCounts[s] ?? 0) + 1;
      for (const [name, policy] of Object.entries(POLICIES)) {
        const r = replay(tl, policy);
        for (const k of ['input', 'clears', 'atBoundary']) sums[name][k] += r[k];
      }
    }
  }
  return { days, sessions, prompts, signalCounts, sums };
}

const k = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

export function formatSimulation({ days, sessions, prompts, signalCounts, sums }) {
  const base = sums['no clear (actual)'].input;
  const out = [
    `last ${days}d: ${sessions} sessions, ${prompts} user prompts`,
    `boundary signals seen: ${Object.entries(signalCounts).map(([s, n]) => `${s} ${n}`).join(', ')}`,
    '',
    `${'input'.padEnd(9)}${'saved'.padEnd(8)}${'clears'.padEnd(8)}${'at boundary'.padEnd(13)}policy`,
  ];
  for (const [name, s] of Object.entries(sums)) {
    const saved = base ? (1 - s.input / base) * 100 : 0;
    const bnd = s.clears ? `${Math.round((s.atBoundary / s.clears) * 100)}%` : '-';
    out.push(`${k(s.input).padEnd(9)}${`${saved.toFixed(0)}%`.padEnd(8)}${String(s.clears).padEnd(8)}${bnd.padEnd(13)}${name}`);
  }
  return out.join('\n');
}
