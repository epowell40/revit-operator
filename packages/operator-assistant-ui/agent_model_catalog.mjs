/** Explicit UI choices. Unknown names must not silently select another model. */
export const agentModelIds = Object.freeze([
  'gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra',
  'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'
]);

export function normalizeAgentModel(value, fallback) {
  const model = String(value ?? '').trim();
  return agentModelIds.includes(model) ? model : fallback;
}
