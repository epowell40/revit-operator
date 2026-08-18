export const DEFAULT_CODEX_TURN_TIMEOUT_MS = 15 * 60_000;

export function resolveCodexTurnTimeoutMs(rawValue: string | undefined): number {
  const raw = Number.parseInt(rawValue ?? `${DEFAULT_CODEX_TURN_TIMEOUT_MS}`, 10);
  if (!Number.isFinite(raw)) return DEFAULT_CODEX_TURN_TIMEOUT_MS;
  return Math.max(60_000, Math.min(30 * 60_000, raw));
}
