import path from "node:path";
import { getWorkspaceRoot } from "../workspace.js";

export type KnowledgeBaseConfig = {
  rootPath: string;
  maxUploadBytes: number;
  allowedMimeTypes: Set<string>;
  embeddingProvider: string;
  embeddingModel: string;
  defaultTopK: number;
  enablePagePreviews: boolean;
  enableOcrFallback: boolean;
};

const DEFAULT_ROOT = "/opt/revit-operator/knowledge_base";

function parseBool(v: string | undefined, fallback: boolean): boolean {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return fallback;
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function defaultKnowledgeBaseRoot(): string {
  const workspaceOverride =
    `${process.env.OPERATOR_WORKSPACE_ROOT || ""}`.trim() ||
    `${process.env.REVIT_OPERATOR_HOME || ""}`.trim();
  if (process.platform === "win32" || workspaceOverride) {
    return path.join(getWorkspaceRoot(), "knowledge_base");
  }
  return DEFAULT_ROOT;
}

export function readKnowledgeBaseConfig(): KnowledgeBaseConfig {
  const rootPath = path.resolve((process.env.KB_ROOT_PATH ?? "").trim() || defaultKnowledgeBaseRoot());
  const maxUploadMb = Number.parseInt((process.env.KB_MAX_UPLOAD_MB ?? "").trim(), 10);
  const maxUploadBytes = Number.isFinite(maxUploadMb) && maxUploadMb > 0 ? maxUploadMb * 1024 * 1024 : 200 * 1024 * 1024;
  const rawMime = (process.env.KB_ALLOWED_MIME_TYPES ?? "application/pdf").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);

  return {
    rootPath,
    maxUploadBytes,
    allowedMimeTypes: new Set(rawMime.length > 0 ? rawMime : ["application/pdf"]),
    embeddingProvider: (process.env.KB_EMBEDDING_PROVIDER ?? "local-hash").trim() || "local-hash",
    embeddingModel: (process.env.KB_EMBEDDING_MODEL ?? "text-embedding-3-small").trim() || "text-embedding-3-small",
    defaultTopK: Math.max(1, Math.min(20, Number.parseInt((process.env.KB_DEFAULT_TOP_K ?? "5").trim(), 10) || 5)),
    enablePagePreviews: parseBool(process.env.KB_ENABLE_PAGE_PREVIEWS, true),
    enableOcrFallback: parseBool(process.env.KB_ENABLE_OCR_FALLBACK, false)
  };
}
