// Pure planning logic: task text + connector status -> which connectors to turn on/off.

const ASCII_WORD = /^[\x20-\x7e]+$/;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ASCII keywords match on word boundaries ("doc" must not hit "docker");
// Thai has no spaces, so Thai keywords match as substrings.
export function keywordHits(text, keyword) {
  const t = text.toLowerCase();
  const k = keyword.toLowerCase();
  if (ASCII_WORD.test(k)) return new RegExp(`(^|[^a-z0-9])${escapeRegex(k)}($|[^a-z0-9])`).test(t);
  return t.includes(k);
}

export function matchProfiles(task, config) {
  const matched = [];
  for (const [name, profile] of Object.entries(config.profiles)) {
    const hits = profile.keywords.filter((k) => keywordHits(task, k));
    if (hits.length) matched.push({ name, hits });
  }
  return matched;
}

const norm = (s) => s.trim().toLowerCase();

// Rows the user toggles through claude.ai; plugin/project/desktop servers are managed elsewhere.
export function connectorRows(status) {
  return (status?.servers ?? []).filter((s) => s.kind === 'connector');
}

export function isOn(row) {
  return row.status !== 'disabled';
}

export function plan({ task = '', profiles: forced = [], status = null, config }) {
  const unknown = forced.filter((p) => !config.profiles[p]);
  if (unknown.length) throw new Error(`unknown profile: ${unknown.join(', ')}`);

  const matched = forced.length
    ? forced.map((name) => ({ name, hits: ['--profile'] }))
    : matchProfiles(task, config);

  const want = new Set(config.always.map(norm));
  for (const m of matched) for (const c of config.profiles[m.name].connectors) want.add(norm(c));

  const result = {
    profiles: matched,
    want: [...want],
    enable: [],
    disable: [],
  };
  if (!status) return result;

  const rows = connectorRows(status);
  const known = new Set(rows.map((r) => norm(r.name)));
  result.missing = result.want.filter((w) => !known.has(w));

  let toolsOff = 0;
  let toolsOn = 0;
  for (const row of rows) {
    const wanted = want.has(norm(row.name));
    if (wanted && !isOn(row)) {
      result.enable.push(row.name);
    } else if (!wanted && isOn(row)) {
      result.disable.push(row.name);
      toolsOff += row.tool_count ?? 0;
    }
    if (wanted) toolsOn += row.tool_count ?? 0;
  }
  // Disabled connectors report no tool_count, so newly enabled ones are not counted here.
  result.toolsRemoved = toolsOff;
  result.estTokensSavedPerRequest = toolsOff * config.tokensPerTool;
  result.toolsKept = toolsOn;
  return result;
}

export function summarize(status, config) {
  const rows = connectorRows(status).map((r) => ({
    name: r.name,
    on: isOn(r),
    tools: r.tool_count ?? 0,
    estTokens: (r.tool_count ?? 0) * config.tokensPerTool,
  }));
  rows.sort((a, b) => b.tools - a.tools);
  const other = (status?.servers ?? [])
    .filter((s) => s.kind !== 'connector')
    .map((s) => ({ name: s.name, kind: s.kind, status: s.status, tools: s.tool_count ?? 0 }));
  const totalOn = rows.filter((r) => r.on).reduce((n, r) => n + r.tools, 0);
  return { connectors: rows, other, connectorToolsOn: totalOn, estTokensPerRequest: totalOn * config.tokensPerTool };
}
