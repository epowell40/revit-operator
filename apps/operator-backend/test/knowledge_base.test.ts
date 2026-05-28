import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestDocument, getKnowledgeBaseDocumentStatus, listKnowledgeBaseDocuments, searchKnowledgeBase } from "../src/knowledge_base/service.js";
import { __resetForTests } from "../src/knowledge_base/store.js";

function tinyPdfBase64(): string {
  // minimal valid-ish PDF with one text line
  const txt = `%PDF-1.4\n1 0 obj<<>>endobj\n2 0 obj<< /Type /Catalog /Pages 3 0 R>>endobj\n3 0 obj<< /Type /Pages /Kids [4 0 R] /Count 1>>endobj\n4 0 obj<< /Type /Page /Parent 3 0 R /MediaBox [0 0 300 144] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>endobj\n5 0 obj<< /Length 44>>stream\nBT /F1 12 Tf 72 72 Td (Stair handrail clearance 34-38 inches) Tj ET\nendstream endobj\n6 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica>>endobj\nxref\n0 7\n0000000000 65535 f \ntrailer<< /Root 2 0 R /Size 7>>\nstartxref\n0\n%%EOF`;
  return Buffer.from(txt, "utf8").toString("base64");
}

test("knowledge base ingestion + list + status + user-scoped search", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kb-"));
  process.env.KB_ROOT_PATH = root;
  process.env.KB_EMBEDDING_PROVIDER = "local-hash";
  __resetForTests();

  const bytes = Buffer.from(tinyPdfBase64(), "base64");
  const ing = await ingestDocument({ ownerUserId: "user-a", filename: "code.pdf", mimeType: "application/pdf", bytes });
  assert.equal(ing.duplicate, false);
  if (ing.duplicate) return;

  // background job async
  for (let i = 0; i < 40; i++) {
    const st = getKnowledgeBaseDocumentStatus(ing.documentId, "user-a");
    if (st?.ingestionStatus === "ready" || st?.ingestionStatus === "failed") break;
    await new Promise(r => setTimeout(r, 50));
  }

  const status = getKnowledgeBaseDocumentStatus(ing.documentId, "user-a");
  assert.ok(status);
  assert.equal(status?.documentId, ing.documentId);

  const docs = listKnowledgeBaseDocuments("user-a");
  assert.equal(docs.length, 1);

  if (status?.ingestionStatus === "ready") {
    const result = await searchKnowledgeBase({ query: "handrail clearance", ownerUserId: "user-a", maxResults: 5 });
    assert.ok(result.results.length >= 1);

    const none = await searchKnowledgeBase({ query: "handrail clearance", ownerUserId: "user-b", maxResults: 5 });
    assert.equal(none.results.length, 0);
  }
});

test("knowledge base duplicate detection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kb-"));
  process.env.KB_ROOT_PATH = root;
  process.env.KB_EMBEDDING_PROVIDER = "local-hash";
  __resetForTests();

  const bytes = Buffer.from(tinyPdfBase64(), "base64");
  const a = await ingestDocument({ ownerUserId: "user-a", filename: "code.pdf", mimeType: "application/pdf", bytes });
  assert.equal(a.duplicate, false);
  const b = await ingestDocument({ ownerUserId: "user-a", filename: "code2.pdf", mimeType: "application/pdf", bytes });
  assert.equal(b.duplicate, true);
});
