import { appendNotification } from "../memory/sqlite_store.js";
import { scanAndProcessUploadQueue } from "./upload_queue_processor.js";
import { resolveImprovementUploadSettings } from "./upload_settings.js";

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? "").toString().trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function shouldNotify(): boolean {
  return parseBool(process.env.OPERATOR_IMPROVEMENT_UPLOAD_NOTIFY, true);
}

export function startUploadQueueWorker(): { stop: () => void } | null {
  const settings = resolveImprovementUploadSettings();
  if (settings.mode === "off") return null;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  const tick = async () => {
    if (stopped) return;
    if (inFlight) return;
    inFlight = true;
    try {
      const results = await scanAndProcessUploadQueue({
        upload_url: settings.upload_url,
        upload_token: settings.upload_token,
        gzip: settings.gzip,
        max_per_tick: settings.max_per_tick,
        max_lines_per_file: settings.max_lines_per_file,
        timeout_ms: settings.timeout_ms,
        retry_backoff_ms: settings.retry_backoff_ms
      });

      if (!shouldNotify()) return;

      for (const r of results) {
        const session_id = (r as any).session_id;
        if (!session_id || typeof session_id !== "string") continue;

        if (r.ok && r.uploaded) {
          try {
            appendNotification(session_id, "improvement.upload.done", "Queued run bundle uploaded for improvement.", {
              outgoing_path_rel: r.outgoing_path_rel,
              status_code: r.status_code ?? null
            });
          } catch {
            // ignore
          }
          continue;
        }

        // If we prepared a payload but have no URL configured, avoid spamming per session.
        if (!r.ok && typeof r.error === "string" && r.error.includes("OPERATOR_IMPROVEMENT_UPLOAD_URL")) continue;

        if (!r.ok) {
          try {
            appendNotification(session_id, "improvement.upload.failed", "Queued run bundle upload failed (will retry).", {
              outgoing_path_rel: (r as any).outgoing_path_rel ?? null,
              error: r.error
            });
          } catch {
            // ignore
          }
        }
      }
    } finally {
      inFlight = false;
    }
  };

  // Fire once immediately.
  void tick();

  if (settings.mode === "watch") {
    timer = setInterval(() => void tick(), settings.interval_ms);
  }

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    }
  };
}
