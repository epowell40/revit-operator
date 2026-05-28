import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ensureWorkspaceLayout } from "../workspace.js";
import { redactString, redactUnknown } from "./redact.js";
import type { DevHandoff } from "../feedback/dev_handoff.js";

export type ImprovementUploadPayload = {
  schema_version: 1;
  queued_at: string;
  created_at: string;
  session_id: string;
  queue_dir_rel: string;
  backend: {
    node: string;
    platform: string;
  };
  feedback?: {
    rating?: "worked" | "partial" | "failed";
    note?: string | null;
    created_at?: string;
    dev_handoff?: DevHandoff;
  };
  run_bundle: {
    manifest?: unknown;
    files: {
      request_log?: unknown[];
      agent_log?: unknown[];
      tool_calls?: unknown[];
      tool_outputs?: unknown[];
    };
    truncation?: Record<string, { max_lines: number; dropped_lines: number }>;
  };
};

function safeNowIso(): string {
  return new Date().toISOString();
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

function readJsonIfExists(filePath: string): unknown | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return undefined;
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

function parseJsonlLines(raw: string, opts: { maxLines: number; workspaceRoot?: string }): { items: unknown[]; dropped: number } {
  const lines = raw.split("\n").filter(Boolean);
  const max = Math.max(1, opts.maxLines);
  const slice = lines.slice(0, max);
  const dropped = Math.max(0, lines.length - slice.length);

  const items: unknown[] = [];
  for (const l of slice) {
    try {
      const v = JSON.parse(l);
      items.push(redactUnknown(v, { workspaceRoot: opts.workspaceRoot }));
    } catch {
      items.push({ raw: redactString(l, { workspaceRoot: opts.workspaceRoot }) });
    }
  }
  return { items, dropped };
}

function readJsonlIfExists(filePath: string, opts: { maxLines: number; workspaceRoot?: string }): { items?: unknown[]; dropped?: number } {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return {};
    const { items, dropped } = parseJsonlLines(raw, opts);
    return { items, dropped };
  } catch {
    return {};
  }
}

function findLatestFeedbackForSession(sessionId: string, opts: { workspaceRoot?: string }): ImprovementUploadPayload["feedback"] | undefined {
  try {
    const layout = ensureWorkspaceLayout();
    const p = path.join(layout.feedback, "events.jsonl");
    if (!fs.existsSync(p)) return undefined;
    const raw = fs.readFileSync(p, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      try {
        const evt: any = JSON.parse(line);
        if (evt?.session_id !== sessionId) continue;
        const rating = typeof evt?.rating === "string" ? evt.rating : undefined;
        const note = typeof evt?.note === "string" ? evt.note : evt?.note === null ? null : undefined;
        const created_at = typeof evt?.created_at === "string" ? evt.created_at : undefined;
        const dev_handoff = evt?.dev_handoff && typeof evt.dev_handoff === "object" ? evt.dev_handoff : undefined;
        return redactUnknown({ rating, note, created_at, ...(dev_handoff ? { dev_handoff } : {}) }, { workspaceRoot: opts.workspaceRoot });
      } catch {
        continue;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function resolveRunBundleDir(queueDirFull: string): { ok: true; session_id: string; run_bundle_full: string } | { ok: false; error: string } {
  try {
    const base = path.basename(queueDirFull);
    const session_id = base.split("_")[0] ?? "";
    if (!session_id.trim()) return { ok: false, error: "Could not infer session_id from queue folder name." };

    const link = path.join(queueDirFull, "run_bundle");
    if (fs.existsSync(link)) return { ok: true, session_id, run_bundle_full: link };

    const ptrPath = path.join(queueDirFull, "pointer.json");
    if (fs.existsSync(ptrPath)) {
      const ptrRaw = fs.readFileSync(ptrPath, "utf8");
      const ptr: any = JSON.parse(ptrRaw.replace(/^\uFEFF/, ""));
      const full = typeof ptr?.run_bundle_full === "string" ? ptr.run_bundle_full : "";
      const rel = typeof ptr?.run_bundle === "string" ? ptr.run_bundle : "";
      if (full && fs.existsSync(full)) return { ok: true, session_id, run_bundle_full: full };
      if (rel) {
        const layout = ensureWorkspaceLayout();
        const candidate = path.join(layout.root, rel.replace(/\//g, path.sep));
        if (fs.existsSync(candidate)) return { ok: true, session_id, run_bundle_full: candidate };
      }
    }

    // Fall back to standard run bundle path under workspace root.
    const layout = ensureWorkspaceLayout();
    const candidate = path.join(layout.root, "runs", "sessions", session_id);
    if (fs.existsSync(candidate)) return { ok: true, session_id, run_bundle_full: candidate };

    return { ok: false, error: "Run bundle not found for queued item." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function buildImprovementUploadPayload(args: {
  queue_dir_full: string;
  queued_at?: string;
  created_at?: string;
  max_lines_per_file?: number;
}): { ok: true; payload: ImprovementUploadPayload } | { ok: false; error: string } {
  try {
    const layout = ensureWorkspaceLayout();
    const queue_dir_full = path.resolve(args.queue_dir_full);

    const queued_at = (args.queued_at ?? safeNowIso()).toString();
    const created_at = (args.created_at ?? safeNowIso()).toString();
    const maxLines = Math.max(50, Math.min(50_000, Number(args.max_lines_per_file ?? 4000) || 4000));

    const resolved = resolveRunBundleDir(queue_dir_full);
    if (!resolved.ok) return resolved;
    const { session_id, run_bundle_full } = resolved;

    const manifest = readJsonIfExists(path.join(run_bundle_full, "manifest.json"));

    const truncation: Record<string, { max_lines: number; dropped_lines: number }> = {};
    const files: ImprovementUploadPayload["run_bundle"]["files"] = {};

    const fileSpecs = [
      { key: "request_log", filename: "request_log.jsonl" },
      { key: "agent_log", filename: "agent_log.jsonl" },
      { key: "tool_calls", filename: "tool_calls.jsonl" },
      { key: "tool_outputs", filename: "tool_outputs.jsonl" }
    ] as const;

    for (const spec of fileSpecs) {
      const p = path.join(run_bundle_full, spec.filename);
      const r = readJsonlIfExists(p, { maxLines, workspaceRoot: layout.root });
      if (r.items) (files as any)[spec.key] = r.items;
      if (typeof r.dropped === "number" && r.dropped > 0) truncation[spec.filename] = { max_lines: maxLines, dropped_lines: r.dropped };
    }

    const feedback = findLatestFeedbackForSession(session_id, { workspaceRoot: layout.root });

    const payload: ImprovementUploadPayload = redactUnknown(
      {
        schema_version: 1,
        queued_at,
        created_at,
        session_id,
        queue_dir_rel: tryWorkspaceRelative(queue_dir_full),
        backend: { node: process.version, platform: process.platform },
        ...(feedback ? { feedback } : {}),
        run_bundle: { ...(manifest ? { manifest } : {}), files, ...(Object.keys(truncation).length ? { truncation } : {}) }
      } satisfies ImprovementUploadPayload,
      { workspaceRoot: layout.root }
    );

    return { ok: true, payload };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function encodeUploadPayload(payload: ImprovementUploadPayload, opts?: { gzip?: boolean }): { contentType: string; contentEncoding?: string; body: Buffer } {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  if (opts?.gzip === false) return { contentType: "application/json", body: raw };
  const gz = zlib.gzipSync(raw, { level: 9 });
  return { contentType: "application/json", contentEncoding: "gzip", body: gz };
}

