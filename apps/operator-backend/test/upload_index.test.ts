import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findLatestUploadIndexRecord, getLatestImageUploadWithContext, readLatestUploadIndexRecords, uploadIndexRelativePathExists } from "../src/attachments/upload_index.js";

test("upload index: reads latest records from tail", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_ws_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const uploadsDir = path.join(root, "artifacts", "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  const idx = path.join(uploadsDir, "_uploads.jsonl");

  fs.writeFileSync(
    idx,
    [
      JSON.stringify({ id: "a1", relative_path: "artifacts/uploads/old.txt", mime: "text/plain", created_at: "t1" }),
      JSON.stringify({ id: "a2", relative_path: "artifacts/uploads/old2.jpg", mime: "image/jpeg", created_at: "t2" }),
      JSON.stringify({ id: "a3", relative_path: "artifacts/uploads/newer.jpg", mime: "image/jpeg", created_at: "t3" })
    ].join("\n") + "\n",
    "utf8"
  );

  // File-existence checks are part of upload-index selection logic.
  fs.writeFileSync(path.join(root, "artifacts", "uploads", "old2.jpg"), "img", "utf8");
  fs.writeFileSync(path.join(root, "artifacts", "uploads", "newer.jpg"), "img", "utf8");

  const recs = readLatestUploadIndexRecords(2);
  assert.equal(recs.length, 2);
  assert.equal(recs[0]?.id, "a3");
  assert.equal(recs[1]?.id, "a2");
});

test("upload index: finds latest image + context pair", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_ws_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const uploadsDir = path.join(root, "artifacts", "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  const idx = path.join(uploadsDir, "_uploads.jsonl");

  const lines = [
    // Older pair
    { id: "img_old", relative_path: "artifacts/uploads/old.jpg", mime: "image/jpeg", kind: "screenshare", context_relative_path: "artifacts/uploads/old_ctx.json" },
    { id: "ctx_old", relative_path: "artifacts/uploads/old_ctx.json", mime: "application/json", kind: "screenshare_context", related_image_relative_path: "artifacts/uploads/old.jpg" },
    // Newer pair
    { id: "img_new", relative_path: "artifacts/uploads/new.jpg", mime: "image/jpeg", kind: "screenshare", context_relative_path: "artifacts/uploads/new_ctx.json" },
    { id: "ctx_new", relative_path: "artifacts/uploads/new_ctx.json", mime: "application/json", kind: "screenshare_context", related_image_relative_path: "artifacts/uploads/new.jpg" }
  ];

  fs.writeFileSync(idx, lines.map(l => JSON.stringify(l)).join("\n") + "\n", "utf8");

  // getLatestImageUploadWithContext requires referenced files to exist.
  fs.writeFileSync(path.join(root, "artifacts", "uploads", "old.jpg"), "img", "utf8");
  fs.writeFileSync(path.join(root, "artifacts", "uploads", "new.jpg"), "img", "utf8");
  fs.writeFileSync(path.join(root, "artifacts", "uploads", "old_ctx.json"), "{}", "utf8");
  fs.writeFileSync(path.join(root, "artifacts", "uploads", "new_ctx.json"), "{}", "utf8");

  const r = getLatestImageUploadWithContext();
  assert.equal(r.image?.id, "img_new");
  assert.equal(r.image?.context_relative_path, "artifacts/uploads/new_ctx.json");
  assert.equal(r.context?.id, "ctx_new");
});

test("upload index: resolves stale attachment path by id or sha", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_ws_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const uploadsDir = path.join(root, "artifacts", "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  const idx = path.join(uploadsDir, "_uploads.jsonl");
  fs.writeFileSync(
    idx,
    JSON.stringify({
      id: "img_1",
      relative_path: "artifacts/uploads/real.png",
      filename: "redline.png",
      mime: "image/png",
      sha256: "abc123"
    }) + "\n",
    "utf8"
  );
  fs.writeFileSync(path.join(uploadsDir, "real.png"), "img", "utf8");

  assert.equal(uploadIndexRelativePathExists("artifacts/uploads/missing.png"), false);
  assert.equal(uploadIndexRelativePathExists("artifacts/uploads/real.png"), true);
  assert.equal(findLatestUploadIndexRecord({ id: "img_1", relative_path: "artifacts/uploads/missing.png" })?.relative_path, "artifacts/uploads/real.png");
  assert.equal(findLatestUploadIndexRecord({ sha256: "abc123" })?.relative_path, "artifacts/uploads/real.png");
});

