type JsonRecord = Record<string, unknown>;

export interface LocalRevitProcessGuardTarget {
  processId: number;
  executorId: string;
  documentTitle: string;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function localRevitProcessGuardTarget(
  sidecarBaseUrl: string,
  health: JsonRecord
): LocalRevitProcessGuardTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(sidecarBaseUrl);
  } catch {
    return null;
  }
  if (!isLoopbackHost(parsed.hostname)) return null;

  const context = asRecord(health.context);
  const document = asRecord(context.document);
  const processId = Number(context.process_id);
  if (!Number.isSafeInteger(processId) || processId <= 0) return null;

  return {
    processId,
    executorId: String(context.courier_executor_id || "").trim(),
    documentTitle: String(document.title || "").trim()
  };
}

export function localProcessIsAlive(
  processId: number,
  signalProcess: (processId: number, signal: 0) => void = (candidate, signal) => process.kill(candidate, signal)
): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    signalProcess(processId, 0);
    return true;
  } catch (error) {
    // EPERM still proves the PID exists; the caller simply cannot signal it.
    return String((error as NodeJS.ErrnoException)?.code || "").toUpperCase() === "EPERM";
  }
}
