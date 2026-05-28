import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolAttachment, ToolResult } from "../contracts.js";
import { getWorkspaceRoot } from "../workspace.js";

export type InlineImageCollectOptions = {
  maxImages?: number;
  maxBytes?: number;
};

function isUnderDir(candidatePath: string, rootDir: string): boolean {
  const root = path.resolve(rootDir);
  const p = path.resolve(candidatePath);
  if (p === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (process.platform === "win32") return p.toLowerCase().startsWith(prefix.toLowerCase());
  return p.startsWith(prefix);
}

function isSupportedImageExt(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg";
}

function tryReadImageAsDataUrl(localPath: string, maxBytes: number): string | null {
  try {
    const p = localPath.trim();
    if (!p) return null;
    if (!isSupportedImageExt(p)) return null;
    if (!fs.existsSync(p)) return null;

    const allowedRoots: string[] = [];
    try {
      allowedRoots.push(getWorkspaceRoot());
    } catch {
      // ignore
    }
    allowedRoots.push(os.tmpdir());
    if (process.platform === "win32") {
      const localAppData = (process.env.LOCALAPPDATA || "").trim();
      if (localAppData) allowedRoots.push(path.join(localAppData, "RevitOperator"));
    }

    if (!allowedRoots.some(r => r && isUnderDir(p, r))) return null;

    const st = fs.statSync(p);
    if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return null;

    const ext = path.extname(p).toLowerCase();
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    const base64 = fs.readFileSync(p).toString("base64");
    if (!base64) return null;
    return `data:${mime};base64,${base64}`;
  } catch {
    return null;
  }
}

export function toolAttachmentToDataUrl(attachment: ToolAttachment | unknown, maxBytes: number): string | null {
  if (!attachment || typeof attachment !== "object") return null;
  if (String((attachment as any).kind ?? "").toLowerCase() !== "image") return null;

  const mime = typeof (attachment as any).mime === "string" ? (attachment as any).mime.trim() : "";
  const b64 = typeof (attachment as any).data_base64 === "string" ? (attachment as any).data_base64.trim() : "";
  if (b64 && mime) return `data:${mime};base64,${b64}`;

  const lp = typeof (attachment as any).local_path === "string" ? (attachment as any).local_path.trim() : "";
  if (lp) return tryReadImageAsDataUrl(lp, maxBytes);

  return null;
}

export function collectInlineImagesFromToolResults(toolResults: ToolResult[] | undefined, opts?: InlineImageCollectOptions): string[] {
  const out: string[] = [];
  const maxImages = Number.isFinite(opts?.maxImages) ? Math.max(0, opts!.maxImages!) : 3;
  const maxBytes = Number.isFinite(opts?.maxBytes) ? Math.max(256 * 1024, opts!.maxBytes!) : 5 * 1024 * 1024;
  if (maxImages <= 0) return out;

  const list = Array.isArray(toolResults) ? toolResults : [];
  for (const r of list) {
    const atts: any[] = Array.isArray((r as any)?.attachments) ? ((r as any).attachments as any[]) : [];
    for (const a of atts) {
      if (out.length >= maxImages) return out;
      if (!a || typeof a !== "object") continue;
      if (String((a as any).kind ?? "").toLowerCase() !== "image") continue;

      const dataUrl = toolAttachmentToDataUrl(a as ToolAttachment, maxBytes);
      if (dataUrl) out.push(dataUrl);
    }
  }

  return out;
}

