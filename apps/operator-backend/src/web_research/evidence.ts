import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureWorkspaceLayout, getWorkspaceRoot } from "../workspace.js";

export type WebEvidencePaths = {
  evidenceId: string;
  evidenceDirFull: string;
  evidenceDirRel: string;
  metaPathFull: string;
  metaPathRel: string;
  snapshotPathFull: string | null;
  snapshotPathRel: string | null;
  textPathFull: string | null;
  textPathRel: string | null;
};

function nowDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function tryWorkspaceRelative(fullPath: string): string | null {
  try {
    const root = path.resolve(getWorkspaceRoot());
    const full = path.resolve(fullPath);
    const rootNorm = process.platform === "win32" ? root.toLowerCase() : root;
    const fullNorm = process.platform === "win32" ? full.toLowerCase() : full;
    if (fullNorm === rootNorm) return ".";
    const prefix = rootNorm.endsWith(path.sep) ? rootNorm : rootNorm + path.sep;
    if (!fullNorm.startsWith(prefix)) return null;
    const rel = path.relative(root, full);
    return rel.replace(/\\/g, "/");
  } catch {
    return null;
  }
}

function sha256Hex(buf: Buffer): string {
  const h = createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

function extFromContentType(ct: string | null): string {
  const c = (ct ?? "").toLowerCase();
  if (c.includes("text/html")) return ".html";
  if (c.includes("application/pdf")) return ".pdf";
  if (c.includes("application/json")) return ".json";
  if (c.includes("text/plain")) return ".txt";
  return ".bin";
}

export function createWebEvidenceDir(): { evidenceId: string; dirFull: string; dirRel: string } {
  const layout = ensureWorkspaceLayout();
  const evidenceId = randomUUID();
  const dir = path.join(layout.evidenceWeb, nowDate(), evidenceId);
  fs.mkdirSync(dir, { recursive: true });
  const rel = tryWorkspaceRelative(dir) ?? dir;
  return { evidenceId, dirFull: dir, dirRel: rel };
}

export function writeWebEvidenceBundle(args: {
  url: string;
  finalUrl?: string | null;
  ok: boolean;
  fetchedAtIso: string;
  policy: { mode: string; host?: string | null; decision?: string };
  http?: { status: number | null; contentType: string | null; headers?: Record<string, string> };
  error?: string | null;
  paywall?: boolean;
  title?: string | null;
  snapshotBytes?: Buffer | null;
  snapshotContentType?: string | null;
  extractedText?: string | null;
  extractedTextMethod?: string | null;
}): WebEvidencePaths {
  const created = createWebEvidenceDir();
  const metaPath = path.join(created.dirFull, "meta.json");

  let snapshotPath: string | null = null;
  let snapshotSha: string | null = null;
  if (args.snapshotBytes && args.snapshotBytes.length > 0) {
    const ext = extFromContentType(args.snapshotContentType ?? args.http?.contentType ?? null);
    snapshotPath = path.join(created.dirFull, "snapshot" + ext);
    fs.writeFileSync(snapshotPath, args.snapshotBytes);
    snapshotSha = sha256Hex(args.snapshotBytes);
  }

  let textPath: string | null = null;
  let textSha: string | null = null;
  if (typeof args.extractedText === "string" && args.extractedText.trim()) {
    const t = args.extractedText.replace(/\r\n/g, "\n");
    textPath = path.join(created.dirFull, "text.txt");
    fs.writeFileSync(textPath, t, "utf8");
    textSha = sha256Hex(Buffer.from(t, "utf8"));
  }

  const meta = {
    schema_version: 1,
    evidence_id: created.evidenceId,
    fetched_at: args.fetchedAtIso,
    url: args.url,
    final_url: args.finalUrl ?? null,
    ok: args.ok,
    policy: args.policy,
    http: args.http ?? null,
    title: args.title ?? null,
    paywall: !!args.paywall,
    error: args.error ?? null,
    snapshot: snapshotPath ? { path: path.basename(snapshotPath), sha256: snapshotSha } : null,
    extracted_text: textPath
      ? { path: path.basename(textPath), sha256: textSha, method: args.extractedTextMethod ?? null, chars: (args.extractedText ?? "").length }
      : null
  };

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

  const metaRel = tryWorkspaceRelative(metaPath) ?? metaPath;
  const snapRel = snapshotPath ? tryWorkspaceRelative(snapshotPath) ?? snapshotPath : null;
  const textRel = textPath ? tryWorkspaceRelative(textPath) ?? textPath : null;

  return {
    evidenceId: created.evidenceId,
    evidenceDirFull: created.dirFull,
    evidenceDirRel: created.dirRel,
    metaPathFull: metaPath,
    metaPathRel: metaRel,
    snapshotPathFull: snapshotPath,
    snapshotPathRel: snapRel,
    textPathFull: textPath,
    textPathRel: textRel
  };
}

