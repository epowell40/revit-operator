import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeCloudUploadConfig } from "../src/config/cloud_upload.js";
import { resolveImprovementUploadSettings } from "../src/improvement/upload_settings.js";

function mkWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  return root;
}

test("upload settings: fall back to workspace config when env missing", () => {
  mkWorkspace();
  writeCloudUploadConfig({ upload_url: "https://example.test/ingest", upload_token: "abc", mode: "watch" });
  const s = resolveImprovementUploadSettings({
    OPERATOR_IMPROVEMENT_UPLOAD_MODE: "",
    OPERATOR_IMPROVEMENT_UPLOAD_URL: "",
    OPERATOR_IMPROVEMENT_UPLOAD_TOKEN: ""
  });
  assert.equal(s.mode, "watch");
  assert.equal(s.upload_url, "https://example.test/ingest");
  assert.equal(s.upload_token, "abc");
});

test("upload settings: env overrides workspace config", () => {
  mkWorkspace();
  writeCloudUploadConfig({ upload_url: "https://example.test/ingest", upload_token: "abc", mode: "watch" });
  const s = resolveImprovementUploadSettings({
    OPERATOR_IMPROVEMENT_UPLOAD_MODE: "off",
    OPERATOR_IMPROVEMENT_UPLOAD_URL: "https://env.test/ingest",
    OPERATOR_IMPROVEMENT_UPLOAD_TOKEN: "envtok"
  });
  assert.equal(s.mode, "off");
  assert.equal(s.upload_url, "https://env.test/ingest");
  assert.equal(s.upload_token, "envtok");
});

