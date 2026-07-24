import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeAttachmentUpload } from "../src/attachments/upload_store.js";
import { readLatestUploadIndexRecords } from "../src/attachments/upload_index.js";

test("attachment upload store: persists upload + index record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_ws_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const bytes = Buffer.from("%PDF-1.4 sample", "utf8");
  const rec = storeAttachmentUpload({
    id: "att_1",
    session_id: "session-a",
    filename: "M000_Cover_Sheet.pdf",
    mime: "application/pdf",
    data_base64: bytes.toString("base64")
  });

  assert.equal(rec.id, "att_1");
  assert.equal(path.extname(rec.relative_path).toLowerCase(), ".pdf");
  assert.equal(rec.bytes, bytes.length);
  assert.equal(rec.session_id, "session-a");
  const full = path.join(root, rec.relative_path.replace(/\//g, path.sep));
  assert.equal(fs.existsSync(full), true);

  const latest = readLatestUploadIndexRecords(5);
  assert.equal(latest.some(x => x.id === "att_1" && x.relative_path === rec.relative_path && x.session_id === "session-a"), true);
});

test("attachment upload store: rejects unsupported type", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_ws_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  assert.throws(
    () =>
      storeAttachmentUpload({
        filename: "malware.exe",
        data_base64: Buffer.from("boom", "utf8").toString("base64")
      }),
    /unsupported attachment type/i
  );
});

test("attachment upload store: rejects sha mismatch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_ws_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  assert.throws(
    () =>
      storeAttachmentUpload({
        filename: "notes.txt",
        sha256: "deadbeef",
        data_base64: Buffer.from("hello", "utf8").toString("base64")
      }),
    /sha256 mismatch/i
  );
});

test("attachment upload store: preserves artifacts/prints relative_path when provided", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_ws_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const bytes = Buffer.from("%PDF-1.4 clean print", "utf8");
  const rec = storeAttachmentUpload({
    id: "att_print_1",
    filename: "M000_Cover_Sheet_clean.pdf",
    relative_path: "artifacts/prints/M000_Cover_Sheet_clean.pdf",
    mime: "application/pdf",
    data_base64: bytes.toString("base64")
  });

  assert.equal(rec.relative_path.startsWith("artifacts/prints/"), true);
  assert.equal(path.extname(rec.relative_path).toLowerCase(), ".pdf");
  const full = path.join(root, rec.relative_path.replace(/\//g, path.sep));
  assert.equal(fs.existsSync(full), true);
});

test("attachment upload store: strips unsafe prints relative_path traversal segments", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_ws_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const bytes = Buffer.from("%PDF-1.4 clean print", "utf8");
  const rec = storeAttachmentUpload({
    filename: "M000_Cover_Sheet_clean.pdf",
    relative_path: "artifacts/prints/../../evil.pdf",
    mime: "application/pdf",
    data_base64: bytes.toString("base64")
  });

  assert.equal(rec.relative_path.startsWith("artifacts/prints/"), true);
  assert.equal(rec.relative_path.includes(".."), false);
  const full = path.join(root, rec.relative_path.replace(/\//g, path.sep));
  assert.equal(fs.existsSync(full), true);
});
