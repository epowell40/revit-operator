import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";
import type { RequestPrincipal } from "../request_context.js";
import { cosineSimilarity, createEmbeddingProvider } from "./embeddings.js";
import { readKnowledgeBaseConfig } from "./config.js";
import { createDocument, findDocumentByHash, getChunksForOwner, getDocument, getLatestJob, listDocuments, replaceChunks, replacePages, updateDocumentStatus, updateJob } from "./store.js";

function sanitizeOwnerPart(value: string, fallback: string): string {
  const safe = `${value ?? ""}`
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return safe || fallback;
}

export function knowledgeBaseOwnerIdForPrincipal(principal: RequestPrincipal | undefined): string {
  if (!principal) return "";
  const licenseId = sanitizeOwnerPart(principal.license_id, "unknown_license");
  const userId = sanitizeOwnerPart(principal.user_id, "unknown_user");
  return `${licenseId}__${userId}`;
}

function ensureKbDirs(rootPath: string): void {
  for (const rel of ["originals", "parsed", "previews", "tmp"]) fs.mkdirSync(path.join(rootPath, rel), { recursive: true });
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tokenCountApprox(text: string): number {
  return Math.max(1, Math.ceil((text ?? "").length / 4));
}

function chunkPages(pages: Array<{ pageNumber: number; text: string }>): any[] {
  const targetTokens = 900;
  const overlapTokens = 120;
  const perPage = pages.map(p => ({ ...p, tokens: tokenCountApprox(p.text) }));
  const chunks: any[] = [];
  let i = 0;
  while (i < perPage.length) {
    let j = i;
    let acc = 0;
    const parts: string[] = [];
    while (j < perPage.length && (acc < targetTokens || j === i)) {
      parts.push(perPage[j]!.text);
      acc += perPage[j]!.tokens;
      j++;
      if (acc >= 1200) break;
    }
    const pageStart = perPage[i]!.pageNumber;
    const pageEnd = perPage[j - 1]!.pageNumber;
    const chunkText = parts.join("\n\n").trim();
    const firstLine = chunkText.split(/\n+/g).map(x => x.trim()).find(Boolean) ?? "";
    const headingGuess = /^[\d\.]+\s+/.test(firstLine) ? firstLine.slice(0, 120) : null;
    chunks.push({ pageStart, pageEnd, sectionPath: headingGuess ? headingGuess.split(" ")[0] : null, heading: headingGuess, chunkIndex: chunks.length, chunkText, tokenCount: tokenCountApprox(chunkText), metadata: { source: "pdf", strategy: "page-window" } });
    if (j >= perPage.length) break;
    let backtrack = j - 1;
    let overlap = 0;
    while (backtrack > i && overlap < overlapTokens) {
      overlap += perPage[backtrack]!.tokens;
      backtrack--;
    }
    i = Math.max(i + 1, backtrack + 1);
  }
  return chunks;
}

async function parsePdfPages(fullPath: string): Promise<Array<{ pageNumber: number; text: string }>> {
  const bytes = fs.readFileSync(fullPath);
  const pdfjs = await loadPdfJsForNode();
  const doc = await pdfjs.getDocument(buildPdfJsDocumentOptions(new Uint8Array(bytes))).promise;
  const pages: Array<{ pageNumber: number; text: string }> = [];
  for (let p = 1; p <= (doc.numPages || 0); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = (content?.items ?? []).map((it: any) => (typeof it?.str === "string" ? it.str : "")).join(" ").replace(/\s+/g, " ").trim();
    pages.push({ pageNumber: p, text });
  }
  return pages;
}

export async function ingestDocument(input: { ownerUserId: string; filename: string; mimeType: string; bytes: Buffer; title?: string; scopeType?: "user" | "project"; tags?: string[]; allowDuplicate?: boolean }) {
  const cfg = readKnowledgeBaseConfig();
  ensureKbDirs(cfg.rootPath);
  if (!cfg.allowedMimeTypes.has(input.mimeType.toLowerCase())) throw new Error(`Unsupported mime type: ${input.mimeType}`);
  if (input.bytes.length > cfg.maxUploadBytes) throw new Error(`Upload exceeds KB_MAX_UPLOAD_MB limit.`);

  const fileSha256 = sha256Hex(input.bytes);
  const dupe = findDocumentByHash(input.ownerUserId, fileSha256);
  if (dupe && !input.allowDuplicate) {
    return { duplicate: true as const, existingDocumentId: dupe.id };
  }

  const documentId = randomUUID();
  const storedFilename = `original.pdf`;
  const storagePath = path.join(cfg.rootPath, "originals", input.ownerUserId, documentId, storedFilename);
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.writeFileSync(storagePath, input.bytes);

  const created = createDocument({ id: documentId, ownerUserId: input.ownerUserId, scopeType: input.scopeType ?? "user", originalFilename: input.filename, storedFilename, storagePath, fileSha256, mimeType: input.mimeType, title: input.title ?? input.filename, disciplineTags: input.tags ?? [] });

  const run = async () => {
    try {
      updateDocumentStatus(created.id, "parsing", null);
      updateJob(created.jobId, { status: "running", stage: "parsing", progressPercent: 15, message: "Parsing PDF" });
      const pages = await parsePdfPages(path.join(cfg.rootPath, "originals", input.ownerUserId, created.id, storedFilename));
      replacePages(created.id, pages.map(p => ({ pageNumber: p.pageNumber, text: p.text })));

      updateDocumentStatus(created.id, "chunking", null, pages.length);
      updateJob(created.jobId, { status: "running", stage: "chunking", progressPercent: 45, message: `Chunking ${pages.length} pages` });
      const chunks = chunkPages(pages);

      updateDocumentStatus(created.id, "embedding", null, pages.length);
      updateJob(created.jobId, { status: "running", stage: "embedding", progressPercent: 70, message: `Embedding ${chunks.length} chunks` });
      const embeddings = await createEmbeddingProvider().embedTexts(chunks.map(c => c.chunkText));
      const withEmb = chunks.map((c, idx) => ({ ...c, embedding: embeddings[idx] ?? [] }));
      replaceChunks(created.id, withEmb);

      updateDocumentStatus(created.id, "ready", null, pages.length);
      updateJob(created.jobId, { status: "done", stage: "ready", progressPercent: 100, message: "Document ready", finished: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      updateDocumentStatus(created.id, "failed", message);
      updateJob(created.jobId, { status: "failed", stage: "failed", progressPercent: 100, message, finished: true });
    }
  };

  void run();
  return { duplicate: false as const, documentId: created.id, jobId: created.jobId, status: "uploaded" };
}

export function listKnowledgeBaseDocuments(ownerUserId: string, scopeType: "user" | "project" = "user") {
  return listDocuments(ownerUserId, scopeType).map((d: any) => ({
    documentId: d.id,
    title: d.title || d.original_filename,
    status: d.ingestion_status,
    pageCount: d.page_count,
    createdAt: d.created_at,
    originalFilename: d.original_filename
  }));
}

export function getKnowledgeBaseDocumentStatus(documentId: string, ownerUserId: string) {
  const doc = getDocument(documentId, ownerUserId);
  if (!doc) return null;
  const job = getLatestJob(documentId);
  return {
    documentId: doc.id,
    title: doc.title || doc.original_filename,
    ingestionStatus: doc.ingestion_status,
    ingestionError: doc.ingestion_error,
    pageCount: doc.page_count,
    stage: job?.stage ?? doc.ingestion_status,
    progressPercent: job?.progress_percent ?? (doc.ingestion_status === "ready" ? 100 : 0),
    message: job?.message ?? null
  };
}

export async function searchKnowledgeBase(input: { query: string; ownerUserId: string; scopeType?: "user" | "project"; maxResults?: number; documentIds?: string[]; citationStyle?: "short" | "full" }) {
  const scopeType = input.scopeType ?? "user";
  const rows = getChunksForOwner(input.ownerUserId, scopeType, input.documentIds);
  const queryEmbedding = await createEmbeddingProvider().embedQuery(input.query);
  const scored: Array<{ r: any; score: number }> = rows.map((r: any) => {
    const emb = JSON.parse(r.embedding_json ?? "[]") as number[];
    const score = cosineSimilarity(queryEmbedding, emb);
    return { r, score };
  }).sort((a: {score:number}, b: {score:number}) => b.score - a.score).slice(0, Math.max(1, Math.min(20, input.maxResults ?? readKnowledgeBaseConfig().defaultTopK)));

  return {
    results: scored.map(({ r, score }: { r: any; score: number }) => ({
      chunkId: r.id,
      documentId: r.document_id,
      title: r.title ?? "Untitled",
      heading: r.heading ?? null,
      pageStart: r.page_start,
      pageEnd: r.page_end,
      score: Number(score.toFixed(4)),
      confidence: Number(Math.max(0, Math.min(1, score)).toFixed(4)),
      text: r.chunk_text,
      sectionPath: r.section_path ?? null
    }))
  };
}
