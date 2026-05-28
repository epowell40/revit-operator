import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";

export type UploadQueueResult =
  | { ok: true; queue_dir_full: string; queue_dir_rel: string; run_bundle_rel: string; link_kind: "junction" | "pointer" }
  | { ok: false; error: string };

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

export function queueRunBundleForUpload(args: { session_id: string; created_at: string; note?: string | null }): UploadQueueResult {
  try {
    const session_id = (args.session_id ?? "").toString().trim();
    if (!session_id) return { ok: false, error: "session_id is required." };

    const layout = ensureWorkspaceLayout();
    const run_bundle_rel = `runs/sessions/${session_id}`;
    const run_bundle_full = path.join(layout.root, "runs", "sessions", session_id);

    const dir = path.join(layout.feedbackUploadQueue, `${session_id}_${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });

    // Prefer a directory junction/symlink (cheap). Fall back to a pointer JSON if blocked.
    try {
      const linkPath = path.join(dir, "run_bundle");
      if (!fs.existsSync(linkPath)) fs.symlinkSync(run_bundle_full, linkPath, "junction");
      return { ok: true, queue_dir_full: dir, queue_dir_rel: tryWorkspaceRelative(dir), run_bundle_rel, link_kind: "junction" };
    } catch {
      const p = path.join(dir, "pointer.json");
      fs.writeFileSync(
        p,
        JSON.stringify(
          { queued_at: args.created_at, session_id, run_bundle: run_bundle_rel, run_bundle_full, note: args.note || undefined },
          null,
          2
        ),
        "utf8"
      );
      return { ok: true, queue_dir_full: dir, queue_dir_rel: tryWorkspaceRelative(dir), run_bundle_rel, link_kind: "pointer" };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

