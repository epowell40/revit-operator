import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureWorkspaceLayout, resolveExistingFileUnderWorkspace } from "../workspace.js";

export type ArtifactListItem = {
  relative_path: string;
  bytes: number;
  mtime_utc: string;
};

type ShareRecord = {
  token: string;
  fullPath: string;
  relativePath: string;
  fileName: string;
  expiresAtMs: number;
  createdAtMs: number;
};

const shareRecords = new Map<string, ShareRecord>();

function nowMs(): number {
  return Date.now();
}

function normalizeRel(fullPath: string): string {
  const root = ensureWorkspaceLayout().root;
  return path.relative(root, fullPath).replace(/\\/g, "/");
}

function normalizeArtifactsPrefix(prefix: string | undefined): string {
  const p = (prefix ?? "").trim().replace(/\\/g, "/");
  if (!p) return "artifacts";
  if (p === "artifacts" || p.startsWith("artifacts/")) return p;
  return `artifacts/${p.replace(/^\/+/, "")}`;
}

function isUnder(baseDir: string, candidate: string): boolean {
  const b = path.resolve(baseDir);
  const c = path.resolve(candidate);
  if (process.platform === "win32") {
    const bn = b.toLowerCase();
    const cn = c.toLowerCase();
    return cn === bn || cn.startsWith(bn.endsWith(path.sep) ? bn : bn + path.sep);
  }
  return c === b || c.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function purgeExpiredShares(): void {
  const n = nowMs();
  for (const [token, rec] of shareRecords.entries()) {
    if (rec.expiresAtMs <= n) shareRecords.delete(token);
  }
}

export function listArtifacts(args: {
  prefix?: string;
  recursive?: boolean;
  limit?: number;
}): { prefix: string; items: ArtifactListItem[] } {
  const layout = ensureWorkspaceLayout();
  const artifactsRoot = layout.artifacts;
  const relPrefix = normalizeArtifactsPrefix(args.prefix);
  const fullPrefix = path.resolve(path.join(layout.root, relPrefix));
  if (!isUnder(artifactsRoot, fullPrefix)) throw new Error("prefix must be under artifacts/.");

  const recursive = !!args.recursive;
  const limit = Math.max(1, Math.min(1000, Number(args.limit ?? 200) || 200));
  const items: ArtifactListItem[] = [];

  const walk = (dir: string) => {
    if (items.length >= limit) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (items.length >= limit) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(full);
        items.push({
          relative_path: normalizeRel(full),
          bytes: st.size,
          mtime_utc: st.mtime.toISOString()
        });
      } catch {
        // ignore
      }
    }
  };

  walk(fullPrefix);
  return { prefix: relPrefix, items };
}

export function createArtifactShare(args: {
  relativePath: string;
  ttlSeconds?: number;
  fileName?: string;
}): { token: string; relative_path: string; file_name: string; expires_at_utc: string } {
  purgeExpiredShares();

  const layout = ensureWorkspaceLayout();
  const artifactsRoot = layout.artifacts;
  const full = resolveExistingFileUnderWorkspace(args.relativePath);
  if (!isUnder(artifactsRoot, full)) throw new Error("Only files under artifacts/ can be shared.");

  const st = fs.statSync(full);
  if (!st.isFile()) throw new Error("Path is not a file.");

  const ttl = Math.max(60, Math.min(24 * 60 * 60, Number(args.ttlSeconds ?? 15 * 60) || 15 * 60));
  const token = randomUUID().replace(/-/g, "");
  const rec: ShareRecord = {
    token,
    fullPath: full,
    relativePath: normalizeRel(full),
    fileName: (args.fileName ?? path.basename(full)).trim() || path.basename(full),
    createdAtMs: nowMs(),
    expiresAtMs: nowMs() + ttl * 1000
  };
  shareRecords.set(token, rec);
  return {
    token,
    relative_path: rec.relativePath,
    file_name: rec.fileName,
    expires_at_utc: new Date(rec.expiresAtMs).toISOString()
  };
}

export function resolveArtifactShare(token: string): { full_path: string; relative_path: string; file_name: string; expires_at_utc: string } | null {
  purgeExpiredShares();
  const t = (token ?? "").trim();
  if (!t) return null;
  const rec = shareRecords.get(t);
  if (!rec) return null;
  if (!fs.existsSync(rec.fullPath)) {
    shareRecords.delete(t);
    return null;
  }
  return {
    full_path: rec.fullPath,
    relative_path: rec.relativePath,
    file_name: rec.fileName,
    expires_at_utc: new Date(rec.expiresAtMs).toISOString()
  };
}

