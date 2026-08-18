type JsonRecord = Record<string, unknown>;

export interface ExactRevitFixtureHealthResult {
  health: JsonRecord;
  attempts: number;
}

export interface ExactRevitFixtureHealthOptions {
  expectedDocumentTitle: string;
  timeoutMs: number;
  readHealth: (remainingMs: number) => Promise<JsonRecord>;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export function revitHealthDocumentTitle(health: JsonRecord): string {
  return String(asRecord(asRecord(health.context).document).title || "").trim();
}

function transientHealthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:408|409|425|429|500|502|503|504)\b|abort|econn|fetch failed|network|temporar|timeout|timed out|exceeded/i.test(message);
}

export async function waitForExactRevitFixtureHealth(
  options: ExactRevitFixtureHealthOptions
): Promise<ExactRevitFixtureHealthResult> {
  const expectedTitle = options.expectedDocumentTitle.trim();
  if (!expectedTitle) throw new Error("Expected Revit fixture document title is required.");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const timeoutMs = Math.max(1, options.timeoutMs);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 1_000);
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let lastError = "";

  while (true) {
    attempts += 1;
    const remainingMs = Math.max(1, deadline - now());
    try {
      const health = await options.readHealth(remainingMs);
      const observedTitle = revitHealthDocumentTitle(health);
      if (observedTitle === expectedTitle) return { health, attempts };
      if (observedTitle) {
        throw new Error(`Expected active Revit document '${expectedTitle}', but Revit reports '${observedTitle}'.`);
      }
      lastError = "Revit reports no active document.";
    } catch (error) {
      if (!transientHealthError(error)) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }

    const remainingAfterReadMs = deadline - now();
    if (remainingAfterReadMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingAfterReadMs));
  }

  throw new Error(
    `Revit fixture readiness exceeded ${timeoutMs}ms waiting for '${expectedTitle}' after ${attempts} attempt${attempts === 1 ? "" : "s"}.`
    + (lastError ? ` Last observation: ${lastError}` : "")
  );
}
