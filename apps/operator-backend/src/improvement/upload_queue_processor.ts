import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";
import { atomicAppendJsonlLine } from "../persistence/jsonl.js";
import { buildImprovementUploadPayload, encodeUploadPayload, resolveRunBundleDir } from "./upload_payload.js";

export type UploadQueueProcessResult =
  | { ok: true; session_id: string; queue_dir_full: string; outgoing_path_rel: string; uploaded: boolean; status_code?: number }
  | { ok: false; session_id?: string; queue_dir_full: string; error: string; outgoing_path_rel?: string };

export type UploadQueueProcessorOptions = {
  upload_url?: string;
  upload_token?: string;
  max_per_tick?: number;
  max_lines_per_file?: number;
  gzip?: boolean;
  timeout_ms?: number;
  retry_backoff_ms?: number;
  fetch_fn?: typeof fetch;
};

type QueueState = {
  attempts: number;
  last_attempt_at?: string;
  last_error?: string;
  uploaded_at?: string;
  last_status_code?: number;
  last_outgoing_path_rel?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function tryReadQueuedAt(queueDirFull: string): string | null {
  try {
    const p = path.join(queueDirFull, "pointer.json");
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const parsed: any = JSON.parse(raw.replace(/^\uFEFF/, ""));
    const q = typeof parsed?.queued_at === "string" ? parsed.queued_at.trim() : "";
    if (!q) return null;
    const t = Date.parse(q);
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString();
  } catch {
    return null;
  }
}

function loadState(queueDirFull: string): QueueState {
  try {
    const p = path.join(queueDirFull, "state.json");
    if (!fs.existsSync(p)) return { attempts: 0 };
    const raw = fs.readFileSync(p, "utf8");
    const parsed: any = JSON.parse(raw.replace(/^\uFEFF/, ""));
    const attempts = typeof parsed?.attempts === "number" ? parsed.attempts : 0;
    return {
      attempts,
      last_attempt_at: typeof parsed?.last_attempt_at === "string" ? parsed.last_attempt_at : undefined,
      last_error: typeof parsed?.last_error === "string" ? parsed.last_error : undefined,
      uploaded_at: typeof parsed?.uploaded_at === "string" ? parsed.uploaded_at : undefined,
      last_status_code: typeof parsed?.last_status_code === "number" ? parsed.last_status_code : undefined,
      last_outgoing_path_rel: typeof parsed?.last_outgoing_path_rel === "string" ? parsed.last_outgoing_path_rel : undefined
    };
  } catch {
    return { attempts: 0 };
  }
}

function saveState(queueDirFull: string, state: QueueState): void {
  const p = path.join(queueDirFull, "state.json");
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

function acquireLock(queueDirFull: string): { ok: true; release: () => void } | { ok: false } {
  const p = path.join(queueDirFull, ".lock");
  try {
    const fd = fs.openSync(p, "wx");
    fs.writeFileSync(fd, `${process.pid}\n${nowIso()}\n`, "utf8");
    const release = () => {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore
      }
    };
    return { ok: true, release };
  } catch {
    return { ok: false };
  }
}

function shouldRetry(state: QueueState, retryBackoffMs: number): boolean {
  if (state.uploaded_at) return false;
  if (!state.last_attempt_at) return true;
  if (!state.last_error) return true;
  const t = Date.parse(state.last_attempt_at);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t >= retryBackoffMs;
}

function ensureOutgoingDir(): string {
  const layout = ensureWorkspaceLayout();
  const outDir = path.join(layout.feedbackUploadQueue, ".outgoing");
  fs.mkdirSync(outDir, { recursive: true });
  return outDir;
}

function tryWorkspaceRelative(fullPath: string): string {
  const layout = ensureWorkspaceLayout();
  const root = path.resolve(layout.root);
  const full = path.resolve(fullPath);
  const rootNorm = process.platform === "win32" ? root.toLowerCase() : root;
  const fullNorm = process.platform === "win32" ? full.toLowerCase() : full;
  const prefix = rootNorm.endsWith(path.sep) ? rootNorm : rootNorm + path.sep;
  if (fullNorm === rootNorm) return ".";
  if (!fullNorm.startsWith(prefix)) return fullPath;
  return path.relative(root, full).replace(/\\/g, "/");
}

function appendUploaderLog(evt: any): void {
  try {
    const layout = ensureWorkspaceLayout();
    const p = path.join(layout.feedbackUploadQueue, "uploader_log.jsonl");
    atomicAppendJsonlLine(p, evt);
  } catch {
    // ignore
  }
}

export async function processUploadQueueDir(
  queueDirFull: string,
  opts: UploadQueueProcessorOptions
): Promise<UploadQueueProcessResult> {
  const layout = ensureWorkspaceLayout();
  const resolved = resolveRunBundleDir(queueDirFull);
  const session_id = resolved.ok ? resolved.session_id : undefined;

  const lock = acquireLock(queueDirFull);
  if (!lock.ok) return { ok: false, session_id, queue_dir_full: queueDirFull, error: "Queue item is locked (in progress elsewhere)." };

  try {
    const state = loadState(queueDirFull);
    const retryBackoffMs = Math.max(1_000, Math.min(24 * 60 * 60 * 1000, Number(opts.retry_backoff_ms ?? 5 * 60 * 1000) || 5 * 60 * 1000));
    if (!shouldRetry(state, retryBackoffMs)) {
      return { ok: false, session_id, queue_dir_full: queueDirFull, error: "Backoff active; skipping for now." };
    }

    const queued_at = tryReadQueuedAt(queueDirFull) ?? nowIso();
    const attemptTs = nowIso();
    state.attempts = (state.attempts || 0) + 1;
    state.last_attempt_at = attemptTs;
    state.last_error = undefined;

    appendUploaderLog({ ts: attemptTs, kind: "upload.attempt", session_id: session_id ?? null, queue_dir_rel: tryWorkspaceRelative(queueDirFull), attempts: state.attempts });

    const built = buildImprovementUploadPayload({
      queue_dir_full: queueDirFull,
      queued_at,
      created_at: attemptTs,
      max_lines_per_file: opts.max_lines_per_file
    });
    if (!built.ok) {
      state.last_error = built.error;
      saveState(queueDirFull, state);
      appendUploaderLog({ ts: attemptTs, kind: "upload.failed", session_id: session_id ?? null, error: built.error });
      return { ok: false, session_id, queue_dir_full: queueDirFull, error: built.error };
    }

    const encoded = encodeUploadPayload(built.payload, { gzip: opts.gzip !== false });
    const outDir = ensureOutgoingDir();
    const base = path.basename(queueDirFull).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "queued";
    const ext = encoded.contentEncoding === "gzip" ? "json.gz" : "json";
    const outgoingPath = path.join(outDir, `${base}__${Date.now()}.${ext}`);
    fs.writeFileSync(outgoingPath, encoded.body);

    const outgoing_path_rel = tryWorkspaceRelative(outgoingPath);
    state.last_outgoing_path_rel = outgoing_path_rel;
    saveState(queueDirFull, state);

    const uploadUrl = (opts.upload_url ?? "").trim();
    if (!uploadUrl) {
      const error = "Missing OPERATOR_IMPROVEMENT_UPLOAD_URL (prepared payload only).";
      state.last_error = error;
      saveState(queueDirFull, state);
      appendUploaderLog({ ts: attemptTs, kind: "upload.prepared", session_id: session_id ?? null, outgoing_path_rel, uploaded: false });
      return { ok: false, session_id, queue_dir_full: queueDirFull, outgoing_path_rel, error };
    }

    const fetchFn = opts.fetch_fn ?? fetch;
    const controller = new AbortController();
    const timeoutMs = Math.max(1_000, Math.min(5 * 60 * 1000, Number(opts.timeout_ms ?? 30_000) || 30_000));
    const t = setTimeout(() => controller.abort(), timeoutMs);

    let statusCode: number | undefined;
    try {
      const headers: Record<string, string> = {
        "content-type": encoded.contentType
      };
      if (encoded.contentEncoding) headers["content-encoding"] = encoded.contentEncoding;
      if (opts.upload_token && opts.upload_token.trim()) headers["authorization"] = `Bearer ${opts.upload_token.trim()}`;

      const resp = await fetchFn(uploadUrl, { method: "POST", headers, body: encoded.body, signal: controller.signal });
      statusCode = resp.status;
      const ok = resp.status >= 200 && resp.status < 300;
      const bodyText = await resp.text().catch(() => "");

      state.last_status_code = statusCode;
      if (!ok) {
        const error = `Upload failed (HTTP ${resp.status}): ${(bodyText || "").slice(0, 400)}`.trim();
        state.last_error = error;
        saveState(queueDirFull, state);
        appendUploaderLog({ ts: nowIso(), kind: "upload.failed", session_id: session_id ?? null, status_code: resp.status, error });
        return { ok: false, session_id, queue_dir_full: queueDirFull, outgoing_path_rel, error };
      }

      const uploadedAt = nowIso();
      state.uploaded_at = uploadedAt;
      state.last_error = undefined;
      saveState(queueDirFull, state);

      try {
        const up = path.join(queueDirFull, "uploaded.json");
        const tmp = up + ".tmp";
        fs.writeFileSync(
          tmp,
          JSON.stringify(
            {
              uploaded_at: uploadedAt,
              upload_url: uploadUrl,
              status_code: resp.status,
              outgoing_path_rel,
              response_preview: (bodyText || "").slice(0, 800) || undefined
            },
            null,
            2
          ),
          "utf8"
        );
        fs.renameSync(tmp, up);
      } catch {
        // ignore
      }

      appendUploaderLog({ ts: uploadedAt, kind: "upload.done", session_id: session_id ?? null, status_code: resp.status, outgoing_path_rel });
      return { ok: true, session_id: session_id ?? "unknown", queue_dir_full: queueDirFull, outgoing_path_rel, uploaded: true, status_code: resp.status };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      state.last_error = error;
      if (typeof statusCode === "number") state.last_status_code = statusCode;
      saveState(queueDirFull, state);
      appendUploaderLog({ ts: nowIso(), kind: "upload.failed", session_id: session_id ?? null, error });
      return { ok: false, session_id, queue_dir_full: queueDirFull, outgoing_path_rel, error };
    } finally {
      clearTimeout(t);
    }
  } finally {
    lock.release();
  }
}

export async function scanAndProcessUploadQueue(opts: UploadQueueProcessorOptions): Promise<UploadQueueProcessResult[]> {
  const layout = ensureWorkspaceLayout();
  fs.mkdirSync(layout.feedbackUploadQueue, { recursive: true });
  ensureOutgoingDir();

  const maxPer = Math.max(1, Math.min(25, Number(opts.max_per_tick ?? 2) || 2));
  const dirs = fs
    .readdirSync(layout.feedbackUploadQueue, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(n => !n.startsWith(".") && n !== ".outgoing")
    .slice(0, 500);

  const results: UploadQueueProcessResult[] = [];
  for (const name of dirs) {
    if (results.length >= maxPer) break;
    const full = path.join(layout.feedbackUploadQueue, name);
    // Skip if already uploaded.
    if (fs.existsSync(path.join(full, "uploaded.json"))) continue;
    const st = loadState(full);
    if (st.uploaded_at) continue;
    results.push(await processUploadQueueDir(full, opts));
  }
  return results;
}
