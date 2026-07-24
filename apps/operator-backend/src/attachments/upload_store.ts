import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureWorkspaceLayout, resolveFileUnderWorkspace } from "../workspace.js";
import { appendUploadIndexRecord } from "./upload_index.js";

export type AttachmentUploadInput = {
  id?: string;
  filename?: string;
  relative_path?: string;
  sha256?: string;
  mime?: string;
  created_at?: string;
  session_id?: string;
  data_base64: string;
};

export type StoredAttachment = {
  id: string;
  relative_path: string;
  filename: string;
  bytes: number;
  sha256: string;
  mime?: string;
  created_at: string;
  session_id?: string;
};

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const REQUEST_OVERHEAD_FACTOR = 2.2;

const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".xls", ".txt", ".csv", ".jpg", ".jpeg", ".png", ".json"]);

function maxFileBytes(): number {
  const raw = (process.env.OPERATOR_ATTACHMENT_UPLOAD_MAX_FILE_BYTES ?? "").trim();
  if (!raw) return DEFAULT_MAX_FILE_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_FILE_BYTES;
  return Math.max(256 * 1024, Math.min(parsed, 200 * 1024 * 1024));
}

export function getAttachmentUploadRequestLimitBytes(): number {
  return Math.ceil(maxFileBytes() * REQUEST_OVERHEAD_FACTOR);
}

function sanitizeFileName(raw: string): string {
  const fallback = "upload";
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  const base = path.basename(trimmed).replace(/[\\/:*?"<>|\r\n]+/g, "_");
  return base || fallback;
}

function extensionFromMime(mime: string): string | null {
  const m = (mime ?? "").trim().toLowerCase();
  if (m === "application/pdf") return ".pdf";
  if (m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return ".docx";
  if (m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return ".xlsx";
  if (m === "application/vnd.ms-excel") return ".xls";
  if (m === "text/plain") return ".txt";
  if (m === "text/csv") return ".csv";
  if (m === "image/jpeg") return ".jpg";
  if (m === "image/png") return ".png";
  if (m === "application/json") return ".json";
  return null;
}

function mimeFromExtension(ext: string): string | undefined {
  const e = (ext ?? "").toLowerCase();
  if (e === ".pdf") return "application/pdf";
  if (e === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (e === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (e === ".xls") return "application/vnd.ms-excel";
  if (e === ".txt") return "text/plain";
  if (e === ".csv") return "text/csv";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".png") return "image/png";
  if (e === ".json") return "application/json";
  return undefined;
}

function normalizeDataBase64(raw: string): string {
  const value = (raw ?? "").trim();
  if (!value) throw new Error("data_base64 is required.");
  const normalized = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) throw new Error("data_base64 contains invalid characters.");
  return normalized;
}

function decodeUploadBytes(dataBase64: string): Buffer {
  const normalized = normalizeDataBase64(dataBase64);
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes || bytes.length === 0) throw new Error("Decoded attachment is empty.");
  return bytes;
}

function ensureAllowedExtension(fileName: string, mime?: string): string {
  const name = sanitizeFileName(fileName);
  let ext = path.extname(name).toLowerCase();
  if (!ext && mime) ext = extensionFromMime(mime) ?? "";
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported attachment type: ${ext || "unknown"}.`);
  }
  return ext;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRelativeHint(relativePath: string | undefined): string {
  const rp = (relativePath ?? "").trim().replace(/\\/g, "/");
  if (!rp) return "";
  return path.basename(rp);
}

function sanitizePathSegment(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return "";
  return trimmed.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim();
}

function tryNormalizePreferredPrintsRelativePath(relativePath: string | undefined, ext: string): string | null {
  const rp = (relativePath ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rp) return null;
  if (!/^artifacts\/prints\//i.test(rp)) return null;

  const parts = rp.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  if (parts[0]!.toLowerCase() !== "artifacts" || parts[1]!.toLowerCase() !== "prints") return null;

  const tail = parts
    .slice(2)
    .map(sanitizePathSegment)
    .filter(Boolean);
  if (tail.length === 0) return null;

  let leaf = tail[tail.length - 1]!;
  if (!path.extname(leaf)) leaf = `${leaf}${ext}`;
  const leafExt = path.extname(leaf).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(leafExt)) return null;
  tail[tail.length - 1] = leaf;

  return ["artifacts", "prints", ...tail].join("/");
}

function buildDestinationName(fileName: string, ext: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const base = path.basename(fileName, path.extname(fileName)).trim() || "upload";
  const safeBase = base.replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 140) || "upload";
  return `${stamp}_${safeBase}${ext}`;
}

function reserveRelativePath(relativePath: string): { fullPath: string; relativePath: string } {
  const normalized = (relativePath ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) throw new Error("relativePath is required.");
  let candidateRel = normalized;
  let full = resolveFileUnderWorkspace(candidateRel);
  let tryN = 2;
  while (fs.existsSync(full) && tryN <= 100) {
    const dirRel = path.dirname(normalized).replace(/\\/g, "/");
    const base = path.basename(normalized, path.extname(normalized));
    const ext = path.extname(normalized);
    const nextName = `${base} (${tryN})${ext}`;
    candidateRel = dirRel === "." ? nextName : `${dirRel}/${nextName}`;
    full = resolveFileUnderWorkspace(candidateRel);
    tryN++;
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return { fullPath: full, relativePath: candidateRel };
}

function reserveUploadPath(destName: string): { fullPath: string; relativePath: string } {
  const uploadsDir = ensureWorkspaceLayout().artifacts;
  const uploadsRoot = path.join(uploadsDir, "uploads");
  fs.mkdirSync(uploadsRoot, { recursive: true });
  let candidate = destName;
  let tryN = 2;
  let full = resolveFileUnderWorkspace(path.join("artifacts", "uploads", candidate));
  while (fs.existsSync(full) && tryN <= 100) {
    const base = path.basename(destName, path.extname(destName));
    const ext = path.extname(destName);
    candidate = `${base} (${tryN})${ext}`;
    full = resolveFileUnderWorkspace(path.join("artifacts", "uploads", candidate));
    tryN++;
  }
  return {
    fullPath: full,
    relativePath: path.join("artifacts", "uploads", candidate).replace(/\\/g, "/")
  };
}

export function storeAttachmentUpload(input: AttachmentUploadInput): StoredAttachment {
  if (!input || typeof input !== "object") throw new Error("Invalid upload payload.");
  const bytes = decodeUploadBytes(input.data_base64);
  const maxBytes = maxFileBytes();
  if (bytes.length > maxBytes) throw new Error(`Attachment exceeds max size (${maxBytes} bytes).`);

  const relativeHintName = normalizeRelativeHint(input.relative_path);
  const rawName = sanitizeFileName(input.filename || relativeHintName || "upload");
  const ext = ensureAllowedExtension(rawName, input.mime);
  const finalName = path.extname(rawName) ? rawName : `${path.basename(rawName)}${ext}`;
  const mime = (input.mime ?? "").trim() || mimeFromExtension(ext);
  const sha = sha256Hex(bytes);

  const expectedSha = (input.sha256 ?? "").trim().toLowerCase();
  if (expectedSha && expectedSha !== sha) {
    throw new Error("Attachment sha256 mismatch.");
  }

  const preferredRelativePath = tryNormalizePreferredPrintsRelativePath(input.relative_path, ext);
  const reserved = preferredRelativePath
    ? reserveRelativePath(preferredRelativePath)
    : reserveUploadPath(buildDestinationName(finalName, ext));
  fs.writeFileSync(reserved.fullPath, bytes);

  const created_at = (input.created_at ?? "").trim() || new Date().toISOString();
  const id = (input.id ?? "").trim() || randomUUID().replace(/-/g, "");
  const session_id = (input.session_id ?? "").trim();

  const rec: StoredAttachment = {
    id,
    relative_path: reserved.relativePath,
    filename: finalName,
    bytes: bytes.length,
    sha256: sha,
    ...(mime ? { mime } : {}),
    created_at,
    ...(session_id ? { session_id } : {})
  };

  appendUploadIndexRecord(rec as unknown as Record<string, unknown>);
  return rec;
}
