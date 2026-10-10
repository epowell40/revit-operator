// Routing capability only: matching this does not authorize a print job or
// override a user's no-print/read-only instruction. Driver interaction may
// require desktop UI even when the requested output is a PDF.
export function needsPrinterCapableLane(userText) {
  return /\b(?:print(?:ing|er|ers)?|plot(?:ting|ter|ters)?)\b/i.test(String(userText || ""));
}

export const PRINT_EXECUTION_GUIDANCE =
  "Distinguish printer-driver work from native PDF export. Do not substitute PDF export for an explicit printer or plot request. For printer work, stay in this computer-capable task: inspect the requested printer/settings, use Revit's Print UI and handle the ordinary destination dialog when needed. Honor requests not to print or to verify an existing output without another job. If a native print attempt was made, continue via UI only when its trusted receipt proves not_started with settings untouched and no output/job; never retry an uncertain or pending attempt. Preserve the current assignment, cancellation and review state. For an export-to-PDF request, prefer export_revit_sheets_pdf and then verify_local_file. After submitting a virtual-printer job, use verify_local_file to wait for stable nonempty output. A zero-byte or missing file may still be pending; do not reprint. Stable metadata does not verify content. Verify a virtual-printer file independently, including intended sheet/content and settings, before claiming delivery; for a physical printer, require observed job status and do not claim paper delivery from submission alone. ";

export const PDF_EXPORT_TOOL_GUIDANCE =
  "Use for PDF export requests, not a printer-driver request or a substitute for a specifically requested print job. ";

// Metadata readiness does not prove content correctness or printer delivery.
export async function waitForLocalArtifact(read, { timeoutMs = 15000, stableMs = 2000, intervalMs = 250, cancelled = () => false, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) throw new Error("Invalid artifact wait timeout");
  const start = now();
  let signature = null, unchangedSince = start;
  while (true) {
    if (cancelled()) return { ok: false, readiness: "cancelled", content_verified: false, waited_ms: now() - start };
    const result = await read();
    if (cancelled()) return { ok: false, readiness: "cancelled", content_verified: false, waited_ms: now() - start };
    const current = now();
    if (!result.ok || (result.exists && !result.is_file)) return { ...result, readiness: "unavailable", content_verified: false, waited_ms: current - start };
    const eligible = result.exists && result.is_file && result.size_bytes > 0;
    const next = eligible ? JSON.stringify([result.path, result.size_bytes, result.last_write_time_utc]) : null;
    if (next === null || next !== signature) { signature = next; unchangedSince = current; }
    if (eligible && current - unchangedSince >= stableMs) return { ...result, readiness: "stable_nonempty", content_verified: false, waited_ms: current - start };
    if (current - start >= timeoutMs) return { ...result, readiness: "timeout", content_verified: false, waited_ms: current - start };
    await sleep(Math.min(intervalMs, timeoutMs - (current - start)));
  }
}
