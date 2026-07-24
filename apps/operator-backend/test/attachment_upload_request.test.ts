import test from "node:test";
import assert from "node:assert/strict";
import { parseAttachmentUploadInput } from "../src/attachments/upload_request.js";

test("attachment upload request: normalizes legacy and camel-case aliases", () => {
  assert.deepEqual(
    parseAttachmentUploadInput({
      id: " att-1 ",
      file_name: " model.pdf ",
      relativePath: " artifacts/model.pdf ",
      sha256: " abc123 ",
      mime: " application/pdf ",
      createdAt: " 2026-07-24T00:00:00.000Z ",
      sessionId: " session-1 ",
      dataBase64: " cGRm "
    }),
    {
      id: "att-1",
      filename: "model.pdf",
      relative_path: "artifacts/model.pdf",
      sha256: "abc123",
      mime: "application/pdf",
      created_at: "2026-07-24T00:00:00.000Z",
      session_id: "session-1",
      data_base64: " cGRm "
    }
  );
});

test("attachment upload request: snake-case fields win and empty session is rejected upstream", () => {
  const parsed = parseAttachmentUploadInput({
    filename: "primary.pdf",
    file_name: "fallback.pdf",
    session_id: "   ",
    sessionId: " fallback-session ",
    data_base64: "cGRm",
    dataBase64: "ignored"
  });

  assert.equal(parsed.filename, "primary.pdf");
  assert.equal(parsed.session_id, "fallback-session");
  assert.equal(parsed.data_base64, "cGRm");
});
