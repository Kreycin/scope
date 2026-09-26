// Headless (SDK-driven) sessions skip interactive-only notes: there's no one to read
// a systemMessage or type /clear.
export function isHeadless(env = process.env) {
  if (env.SCOPE_INTERACTIVE === '1') return false;
  return typeof env.CLAUDE_CODE_ENTRYPOINT === 'string' && env.CLAUDE_CODE_ENTRYPOINT.startsWith('sdk-');
}
