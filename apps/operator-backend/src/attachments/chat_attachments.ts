import type { ChatRequest } from "../contracts.js";
import { findLatestUploadIndexRecord, uploadIndexRelativePathExists } from "./upload_index.js";

export function normalizeUserAttachments(input: unknown): NonNullable<ChatRequest["user_attachments"]> {
  if (!Array.isArray(input)) return [];
  const out: any[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const a = item as any;
    const id = typeof a.id === "string" ? a.id.trim() : "";
    if (!id) continue;
    const rawRelativePath = typeof a.relative_path === "string" ? a.relative_path.trim() : "";
    const sha256 = typeof a.sha256 === "string" ? a.sha256.trim() : "";
    const indexed =
      rawRelativePath && uploadIndexRelativePathExists(rawRelativePath)
        ? null
        : findLatestUploadIndexRecord({
            id,
            sha256,
            relative_path: rawRelativePath
          });
    out.push({
      id,
      relative_path: indexed?.relative_path ?? (rawRelativePath || undefined),
      filename: typeof a.filename === "string" && a.filename.trim() ? a.filename.trim() : indexed?.filename,
      bytes: typeof a.bytes === "number" ? a.bytes : indexed?.bytes,
      sha256: sha256 || indexed?.sha256,
      mime: typeof a.mime === "string" && a.mime.trim() ? a.mime.trim() : indexed?.mime,
      created_at: typeof a.created_at === "string" && a.created_at.trim() ? a.created_at.trim() : indexed?.created_at,
      external_path: typeof a.external_path === "string" ? a.external_path.trim() : undefined
    });
  }
  return out;
}

function formatAttachmentsForUserText(attachments: NonNullable<ChatRequest["user_attachments"]>): string {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return "";
  const lines: string[] = [];
  lines.push("Attachments:");
  let i = 0;
  for (const a of list) {
    i++;
    const id = a?.id ? String(a.id) : "";
    const p = (a as any)?.relative_path ? String((a as any).relative_path) : "";
    const ext = (a as any)?.external_path ? String((a as any).external_path) : "";
    const name = (a as any)?.filename ? String((a as any).filename) : (p || ext);
    const sha = (a as any)?.sha256 ? String((a as any).sha256).slice(0, 12) : "";
    const bytes = typeof (a as any)?.bytes === "number" ? Math.round((a as any).bytes) : null;
    const loc = p ? `path=${p}` : ext ? `external=${ext}` : "";
    const meta = [id ? `id=${id}` : null, loc || null, sha ? `sha256=${sha}…` : null, bytes !== null ? `bytes=${bytes}` : null]
      .filter(Boolean)
      .join(", ");
    lines.push(`- [${i}] ${name}${meta ? ` (${meta})` : ""}`);
  }
  return lines.join("\n");
}

export function appendAttachmentsToUserText(userText: string, attachments: NonNullable<ChatRequest["user_attachments"]>): string {
  const t = (userText ?? "").trim();
  const block = formatAttachmentsForUserText(attachments);
  if (!block) return t;
  if (!t) return block;
  return `${t}\n\n${block}`;
}
