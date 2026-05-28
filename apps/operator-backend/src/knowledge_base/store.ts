import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readKnowledgeBaseConfig } from "./config.js";

type SqliteDb = {
  pragma: (s: string) => unknown;
  exec: (s: string) => unknown;
  prepare: (s: string) => { run: (...args: any[]) => any; get: (...args: any[]) => any; all: (...args: any[]) => any };
};

function openDb(): SqliteDb {
  const cfg = readKnowledgeBaseConfig();
  const dbDir = path.join(cfg.rootPath, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "knowledge_base.sqlite");
  const require = createRequire(import.meta.url);
  const mod: any = require("better-sqlite3");
  const Database = mod?.default ?? mod;
  const db: SqliteDb = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_documents (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      title TEXT,
      publisher TEXT,
      edition TEXT,
      publication_year TEXT,
      discipline_tag_json TEXT,
      license_note TEXT,
      page_count INTEGER,
      file_sha256 TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      ingestion_status TEXT NOT NULL,
      ingestion_error TEXT,
      warnings_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_documents_owner_status ON kb_documents(owner_user_id, ingestion_status);

    CREATE TABLE IF NOT EXISTS kb_pages (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      extracted_text TEXT NOT NULL,
      preview_image_path TEXT,
      page_metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      page_start INTEGER NOT NULL,
      page_end INTEGER NOT NULL,
      section_path TEXT,
      heading TEXT,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      metadata_json TEXT,
      embedding_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc_idx ON kb_chunks(document_id, chunk_index);

    CREATE TABLE IF NOT EXISTS kb_ingestion_jobs (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      progress_percent INTEGER NOT NULL,
      message TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function nowIso(): string { return new Date().toISOString(); }

const db = openDb();

export function createDocument(input: any) {
  const id = typeof input?.id === "string" && input.id.trim() ? input.id.trim() : randomUUID();
  const ts = nowIso();
  db.prepare(`INSERT INTO kb_documents(id, owner_user_id, scope_type, scope_id, original_filename, stored_filename, storage_path, title, discipline_tag_json, file_sha256, mime_type, ingestion_status, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.ownerUserId, input.scopeType ?? "user", input.scopeId ?? null, input.originalFilename, input.storedFilename, input.storagePath,
    input.title ?? null, JSON.stringify(input.disciplineTags ?? []), input.fileSha256, input.mimeType, "uploaded", ts, ts
  );
  const jobId = randomUUID();
  db.prepare(`INSERT INTO kb_ingestion_jobs(id, document_id, status, stage, progress_percent, message, created_at, started_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(jobId, id, "queued", "uploaded", 0, "Queued for ingestion", ts, ts);
  return { id, jobId };
}

export function getDocument(documentId: string, ownerUserId: string) {
  return db.prepare(`SELECT * FROM kb_documents WHERE id=? AND owner_user_id=?`).get(documentId, ownerUserId);
}

export function listDocuments(ownerUserId: string, scopeType = "user") {
  return db.prepare(`SELECT * FROM kb_documents WHERE owner_user_id=? AND scope_type=? ORDER BY created_at DESC`).all(ownerUserId, scopeType);
}

export function updateDocumentStatus(documentId: string, status: string, ingestionError?: string | null, pageCount?: number) {
  db.prepare(`UPDATE kb_documents SET ingestion_status=?, ingestion_error=?, page_count=COALESCE(?, page_count), updated_at=? WHERE id=?`)
    .run(status, ingestionError ?? null, pageCount ?? null, nowIso(), documentId);
}

export function updateJob(jobId: string, patch: { status: string; stage: string; progressPercent: number; message?: string; finished?: boolean }) {
  db.prepare(`UPDATE kb_ingestion_jobs SET status=?, stage=?, progress_percent=?, message=?, finished_at=CASE WHEN ? THEN ? ELSE finished_at END WHERE id=?`)
    .run(patch.status, patch.stage, patch.progressPercent, patch.message ?? null, patch.finished ? 1 : 0, patch.finished ? nowIso() : null, jobId);
}

export function getLatestJob(documentId: string) {
  return db.prepare(`SELECT * FROM kb_ingestion_jobs WHERE document_id=? ORDER BY created_at DESC LIMIT 1`).get(documentId);
}

export function replacePages(documentId: string, pages: Array<{ pageNumber: number; text: string; metadata?: unknown }>) {
  db.prepare(`DELETE FROM kb_pages WHERE document_id=?`).run(documentId);
  const stmt = db.prepare(`INSERT INTO kb_pages(id, document_id, page_number, extracted_text, page_metadata_json, created_at) VALUES(?,?,?,?,?,?)`);
  const ts = nowIso();
  for (const p of pages) stmt.run(randomUUID(), documentId, p.pageNumber, p.text, JSON.stringify(p.metadata ?? {}), ts);
}

export function replaceChunks(documentId: string, chunks: any[]) {
  db.prepare(`DELETE FROM kb_chunks WHERE document_id=?`).run(documentId);
  const stmt = db.prepare(`INSERT INTO kb_chunks(id, document_id, page_start, page_end, section_path, heading, chunk_index, chunk_text, token_count, metadata_json, embedding_json, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ts = nowIso();
  for (const c of chunks) stmt.run(randomUUID(), documentId, c.pageStart, c.pageEnd, c.sectionPath ?? null, c.heading ?? null, c.chunkIndex, c.chunkText, c.tokenCount, JSON.stringify(c.metadata ?? {}), JSON.stringify(c.embedding ?? []), ts);
}

export function getChunksForOwner(ownerUserId: string, scopeType = "user", documentIds?: string[]) {
  if (Array.isArray(documentIds) && documentIds.length > 0) {
    const placeholders = documentIds.map(() => "?").join(",");
    return db.prepare(`SELECT c.*, d.title, d.owner_user_id, d.ingestion_status FROM kb_chunks c JOIN kb_documents d ON d.id=c.document_id
      WHERE d.owner_user_id=? AND d.scope_type=? AND d.ingestion_status='ready' AND d.id IN (${placeholders})`).all(ownerUserId, scopeType, ...documentIds);
  }
  return db.prepare(`SELECT c.*, d.title, d.owner_user_id, d.ingestion_status FROM kb_chunks c JOIN kb_documents d ON d.id=c.document_id
      WHERE d.owner_user_id=? AND d.scope_type=? AND d.ingestion_status='ready'`).all(ownerUserId, scopeType);
}

export function findDocumentByHash(ownerUserId: string, sha256: string) {
  return db.prepare(`SELECT * FROM kb_documents WHERE owner_user_id=? AND file_sha256=? LIMIT 1`).get(ownerUserId, sha256);
}

export function __resetForTests() {
  db.exec(`DELETE FROM kb_ingestion_jobs; DELETE FROM kb_chunks; DELETE FROM kb_pages; DELETE FROM kb_documents;`);
}
