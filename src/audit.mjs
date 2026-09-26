// Read Claude Code transcripts and show where input tokens go:
// the fixed context every request re-sends (baseline) versus conversation growth.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const total = (u) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

// Size of the context the last request carried, from the end of a transcript.
export function lastContextTokens(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row.type === 'assistant' && row.message?.usage) return total(row.message.usage);
  }
  return 0;
}

export function sessionStats(lines) {
  const seen = new Set();
  const reqs = [];
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = row.type === 'assistant' ? row.message : null;
    if (!msg?.usage) continue;
    // One API response is logged once per content block; count it once.
    const id = msg.id ?? row.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    reqs.push(msg.usage);
  }
  if (!reqs.length) return null;
  const baseline = total(reqs[0]);
  const input = reqs.reduce((n, u) => n + total(u), 0);
  return {
    requests: reqs.length,
    baseline,
    input,
    cacheRead: reqs.reduce((n, u) => n + (u.cache_read_input_tokens ?? 0), 0),
    output: reqs.reduce((n, u) => n + (u.output_tokens ?? 0), 0),
    peak: Math.max(...reqs.map(total)),
    baselineShare: (baseline * reqs.length) / input,
  };
}

export function audit({ root, days = 7, now = Date.now() }) {
  const since = now - days * 86400_000;
  const sessions = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(dir, f);
      if (statSync(path).mtimeMs < since) continue;
      const s = sessionStats(readFileSync(path, 'utf8').split('\n'));
      if (s) sessions.push({ project: project.name.replace(/^-Users-[^-]+-/, ''), session: basename(f, '.jsonl').slice(0, 8), ...s });
    }
  }
  sessions.sort((a, b) => b.input - a.input);
  const sum = (k) => sessions.reduce((n, s) => n + s[k], 0);
  const input = sum('input');
  const fixed = sessions.reduce((n, s) => n + s.baseline * s.requests, 0);
  return {
    days,
    sessions: sessions.length,
    requests: sum('requests'),
    inputTokens: input,
    outputTokens: sum('output'),
    fixedContextShare: input ? fixed / input : 0,
    medianBaseline: median(sessions.map((s) => s.baseline)),
    top: sessions.slice(0, 10),
  };
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

export function formatAudit(a) {
  const out = [
    `last ${a.days}d: ${a.sessions} sessions, ${a.requests} requests, input ${k(a.inputTokens)}, output ${k(a.outputTokens)}`,
    `fixed context (re-sent each request): ${(a.fixedContextShare * 100).toFixed(0)}% of input; median baseline ${k(a.medianBaseline)}/request`,
    '',
    'input    reqs  baseline  peak   fixed%  project/session',
  ];
  for (const s of a.top) {
    out.push(
      `${k(s.input).padEnd(8)} ${String(s.requests).padEnd(5)} ${k(s.baseline).padEnd(9)} ${k(s.peak).padEnd(6)} ${(s.baselineShare * 100).toFixed(0).padStart(3)}%    ${s.project}/${s.session}`,
    );
  }
  return out.join('\n');
}
