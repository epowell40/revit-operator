import fs from "node:fs";
import path from "node:path";

import type { ToolAttachment, ToolResult } from "../contracts.js";
import { getWorkspaceRoot } from "../workspace.js";

export type InlineImageCollectOptions = {
  maxImages?: number;
  maxBytes?: number;
};
export type InlineImageReadHooks = {
  afterResolve?: () => void;
  afterOpen?: () => void;
};

function isUnderDir(candidatePath: string, rootDir: string): boolean {
  const root = path.resolve(rootDir);
  const p = path.resolve(candidatePath);
  if (p === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (process.platform === "win32") return p.toLowerCase().startsWith(prefix.toLowerCase());
  return p.startsWith(prefix);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function sniffImageMime(data: Buffer): "image/png" | "image/jpeg" | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  return null;
}

function sameFileIdentity(opened: fs.BigIntStats, current: fs.BigIntStats): boolean {
  return opened.dev !== 0n && opened.ino !== 0n
    && opened.dev === current.dev
    && opened.ino === current.ino;
}

function readOpenedFile(fd: number, st: fs.BigIntStats, maxBytes: number): Buffer | null {
  if (!st.isFile() || st.size <= 0n || st.size > BigInt(maxBytes)) return null;
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset === 0 || offset > maxBytes) return null;
  return buffer.subarray(0, offset);
}

function decodeStrictBase64(value: string, maxBytes: number): Buffer | null {
  if (!value || value.length % 4 !== 0 || /\s/.test(value) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const estimatedBytes = (value.length / 4) * 3 - padding;
  if (estimatedBytes <= 0 || estimatedBytes > maxBytes) return null;
  const data = Buffer.from(value, "base64");
  if (data.length !== estimatedBytes || data.toString("base64") !== value) return null;
  return data;
}

export function readLocalImageAsDataUrl(localPath: string, maxBytes: number, hooks: InlineImageReadHooks = {}): string | null {
  let fd: number | null = null;
  try {
    const p = localPath.trim();
    if (!p) return null;

    const allowedRoots: string[] = [];
    try {
      allowedRoots.push(getWorkspaceRoot());
    } catch {
      // ignore
    }
    const localAppData = (process.env.LOCALAPPDATA || "").trim();
    if (localAppData) allowedRoots.push(path.join(localAppData, "RevitOperator", "Workspace"));

    const candidate = path.resolve(p);
    if (!allowedRoots.some(root => root && isUnderDir(candidate, root))) return null;
    const realRoots = allowedRoots.flatMap(root => {
      try { return [fs.realpathSync(root)]; } catch { return []; }
    });
    const targetRealPath = fs.realpathSync(candidate);
    if (!realRoots.some(root => isUnderDir(targetRealPath, root))) return null;
    const approvedStat = fs.statSync(targetRealPath, { bigint: true });
    if (!approvedStat.isFile() || approvedStat.dev === 0n || approvedStat.ino === 0n) return null;
    hooks.afterResolve?.();
    const noFollow = Number((fs.constants as Record<string, unknown>).O_NOFOLLOW ?? 0);
    fd = fs.openSync(targetRealPath, fs.constants.O_RDONLY | noFollow);
    hooks.afterOpen?.();
    const openedStat = fs.fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(openedStat, approvedStat)) return null;
    const currentRealPath = fs.realpathSync(candidate);
    if (!samePath(currentRealPath, targetRealPath) || !realRoots.some(root => isUnderDir(currentRealPath, root))) return null;
    const currentStat = fs.statSync(candidate, { bigint: true });
    if (!sameFileIdentity(openedStat, currentStat)) return null;
    const data = readOpenedFile(fd, openedStat, maxBytes);
    if (!data) return null;
    const mime = sniffImageMime(data);
    if (!mime) return null;
    return `data:${mime};base64,${data.toString("base64")}`;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function toolAttachmentToDataUrl(attachment: ToolAttachment | unknown, maxBytes: number): string | null {
  if (!attachment || typeof attachment !== "object") return null;
  if (String((attachment as any).kind ?? "").toLowerCase() !== "image") return null;

  const mime = typeof (attachment as any).mime === "string" ? (attachment as any).mime.trim().toLowerCase() : "";
  const b64 = typeof (attachment as any).data_base64 === "string" ? (attachment as any).data_base64.trim() : "";
  if (b64 && (mime === "image/png" || mime === "image/jpeg")) {
    const data = decodeStrictBase64(b64, maxBytes);
    if (!data || sniffImageMime(data) !== mime) return null;
    return `data:${mime};base64,${b64}`;
  }

  const lp = typeof (attachment as any).local_path === "string" ? (attachment as any).local_path.trim() : "";
  if (lp) return readLocalImageAsDataUrl(lp, maxBytes);

  return null;
}

export function collectInlineImagesFromToolResults(toolResults: ToolResult[] | undefined, opts?: InlineImageCollectOptions): string[] {
  const out: string[] = [];
  const maxImages = Number.isFinite(opts?.maxImages) ? Math.max(0, opts!.maxImages!) : 3;
  const seen = new Set<string>();
  const maxBytes = Number.isFinite(opts?.maxBytes) ? Math.max(1, Math.floor(opts!.maxBytes!)) : 5 * 1024 * 1024;
  if (maxImages <= 0) return out;

  const list = Array.isArray(toolResults) ? toolResults : [];
  for (let resultIndex = list.length - 1; resultIndex >= 0; resultIndex -= 1) {
    const r = list[resultIndex];
    const atts: any[] = Array.isArray((r as any)?.attachments) ? ((r as any).attachments as any[]) : [];
    for (const a of atts) {
      if (out.length >= maxImages) return out;
      if (!a || typeof a !== "object") continue;
      if (String((a as any).kind ?? "").toLowerCase() !== "image") continue;

      const dataUrl = toolAttachmentToDataUrl(a as ToolAttachment, maxBytes);
      if (dataUrl && !seen.has(dataUrl)) {
        seen.add(dataUrl);
        out.push(dataUrl);
      }
    }
  }

  return out;
}
