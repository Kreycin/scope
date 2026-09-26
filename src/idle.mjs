// Block the first prompt after the prompt cache expired on a big context.
//
// After the cache TTL (1 hour in Claude Code) the next request re-writes the whole context
// at ~2x the input price, ~20x a cache read. That cost lands before any handoff note can
// suggest /clear, so the hook stops that one prompt and offers /clear first. Resending
// goes through: a block is recorded against the last request's timestamp.

// Timestamp of the last API response in the transcript tail.
export function lastRequestTime(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row.type === 'assistant' && row.message?.usage && row.timestamp) return Date.parse(row.timestamp);
  }
  return null;
}

export function idleCheck({ lines, contextTokens, sessionId = 'unknown', prompt = '', now = Date.now(), restorable = true }, state, config) {
  const { enabled, minutes, minTokens } = config.idleBlock ?? {};
  if (!enabled || !contextTokens || contextTokens < minTokens) return null;
  const last = lastRequestTime(lines);
  if (!last) return null;
  const idle = (now - last) / 60000;
  if (idle < minutes) return null;
  state.idleBlock ??= {};
  if (state.idleBlock[sessionId] === last) return null;
  state.idleBlock[sessionId] = last;
  const ids = Object.keys(state.idleBlock);
  for (const id of ids.slice(0, Math.max(0, ids.length - 50))) delete state.idleBlock[id];

  const k = Math.round(contextTokens / 1000);
  const hours = idle >= 90 ? `${(idle / 60).toFixed(1)} h` : `${Math.round(idle)} min`;
  const echo = prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt;
  const restart = restorable ? 'Type /clear to restart from STATUS.md' : 'Type /compact to shrink it first';
  const reason =
    `scope: idle ${hours}, the prompt cache has expired. Sending now re-writes all ${k}k tokens of context ` +
    `at ~2x price (about 20 normal requests' worth). ` +
    `${restart}, or send your message again to continue here.` +
    (echo ? `\n\nYour message:\n${echo}` : '');
  return { reason, log: { idle_min: Math.round(idle), context: contextTokens } };
}
