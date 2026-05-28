import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";

export type UploadIndexRecord = {
  id?: string;
  relative_path?: string;
  filename?: string;
  bytes?: number;
  sha256?: string;
  mime?: string;
  created_at?: string;
  kind?: string;
  context_relative_path?: string;
  related_image_relative_path?: string;
};

function uploadsIndexPath(): string {
  const root = ensureWorkspaceLayout().root;
  return path.join(root, "artifacts", "uploads", "_uploads.jsonl");
}

export function appendUploadIndexRecord(record: Record<string, unknown>): void {
  const full = uploadsIndexPath();
  const dir = path.dirname(full);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(full, line, "utf8");
}

function readTailBytes(filePath: string, maxBytes: number): Buffer {
  const st = fs.statSync(filePath);
  const size = st.size;
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

export function readLatestUploadIndexRecords(limit: number): UploadIndexRecord[] {
  const out: UploadIndexRecord[] = [];
  const full = uploadsIndexPath();
  try {
    if (!fs.existsSync(full)) return [];
    const st = fs.statSync(full);
    if (!st.isFile() || st.size <= 0) return [];

    const buf = st.size <= 256 * 1024 ? fs.readFileSync(full) : readTailBytes(full, 256 * 1024);
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);

    // If we started mid-file, the first "line" might be a partial JSON object; drop it.
    if (st.size > 256 * 1024 && lines.length > 0) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = (lines[i] ?? "").trim();
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw);
        if (!rec || typeof rec !== "object") continue;
        out.push(rec as UploadIndexRecord);
        if (out.length >= limit) break;
      } catch {
        // ignore malformed lines
      }
    }

    return out;
  } catch {
    return [];
  }
}

function looksLikeImagePath(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg";
}

function uploadRelativePathExists(relPath: string): boolean {
  const rp = (relPath ?? "").toString().trim();
  if (!rp) return false;
  try {
    const root = ensureWorkspaceLayout().root;
    const full = path.resolve(root, rp.replace(/\//g, path.sep));
    const rootResolved = path.resolve(root);
    const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
    const fullNorm = process.platform === "win32" ? full.toLowerCase() : full;
    const prefixNorm = process.platform === "win32" ? prefix.toLowerCase() : prefix;
    if (!fullNorm.startsWith(prefixNorm)) return false;
    return fs.existsSync(full);
  } catch {
    return false;
  }
}

export function getLatestImageUploadWithContext(): { image?: UploadIndexRecord; context?: UploadIndexRecord } {
  const latest = readLatestUploadIndexRecords(40);
  const image = latest.find(r => {
    const rp = (r.relative_path ?? "").toString().trim();
    if (!rp || !uploadRelativePathExists(rp)) return false;
    const mime = (r.mime ?? "").toString().trim().toLowerCase();
    if (mime.startsWith("image/")) return true;
    return rp ? looksLikeImagePath(rp) : false;
  });
  if (!image) return {};

  const ctxRel = (image.context_relative_path ?? "").toString().trim();
  if (ctxRel) {
    const ctx = latest.find(r => {
      const rp = (r.relative_path ?? "").toString().trim();
      return rp === ctxRel && uploadRelativePathExists(rp);
    });
    return { image, context: ctx };
  }

  const imgRel = (image.relative_path ?? "").toString().trim();
  if (!imgRel) return { image };

  const ctx = latest.find(r => {
    const rp = (r.relative_path ?? "").toString().trim();
    return (r.related_image_relative_path ?? "").toString().trim() === imgRel && rp && uploadRelativePathExists(rp);
  });
  return { image, context: ctx };
}

export function findLatestUploadIndexRecord(args: {
  id?: string | null;
  sha256?: string | null;
  relative_path?: string | null;
  limit?: number;
}): UploadIndexRecord | null {
  const id = (args.id ?? "").toString().trim();
  const sha = (args.sha256 ?? "").toString().trim().toLowerCase();
  const rel = (args.relative_path ?? "").toString().trim().replace(/\\/g, "/");
  if (!id && !sha && !rel) return null;

  const latest = readLatestUploadIndexRecords(Math.max(20, Math.min(500, args.limit ?? 120)));
  const usable = latest.filter((r) => {
    const rp = (r.relative_path ?? "").toString().trim();
    return rp && uploadRelativePathExists(rp);
  });

  if (id) {
    const byId = usable.find((r) => (r.id ?? "").toString().trim() === id);
    if (byId) return byId;
  }
  if (sha) {
    const bySha = usable.find((r) => (r.sha256 ?? "").toString().trim().toLowerCase() === sha);
    if (bySha) return bySha;
  }
  if (rel) {
    const byRel = usable.find((r) => (r.relative_path ?? "").toString().trim().replace(/\\/g, "/") === rel);
    if (byRel) return byRel;
  }
  return null;
}

export function uploadIndexRelativePathExists(relPath: string | null | undefined): boolean {
  return uploadRelativePathExists((relPath ?? "").toString());
}

