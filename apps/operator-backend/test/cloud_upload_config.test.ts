import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cloudUploadConfigPath, readCloudUploadConfig, writeCloudUploadConfig } from "../src/config/cloud_upload.js";

function mkWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  return root;
}

test("cloud upload config: write/read roundtrip", () => {
  mkWorkspace();
  const w = writeCloudUploadConfig({ upload_url: "https://example.invalid/revitoperator/improvements/ingest", upload_token: "tok", mode: "watch" });
  assert.equal(w.ok, true);
  const p = cloudUploadConfigPath();
  assert.ok(fs.existsSync(p));
  const r = readCloudUploadConfig();
  assert.equal(r?.upload_url, "https://example.invalid/revitoperator/improvements/ingest");
  assert.equal(r?.upload_token, "tok");
  assert.equal(r?.mode, "watch");
});

