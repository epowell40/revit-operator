import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolResult } from "../src/contracts.js";
import {
  applyEnvironmentPolicyToActions,
  buildCapabilityManifest,
  ensureEnvironmentProfile,
  formatEnvironmentSummaryForPrompt,
  recordToolResultsEnvironmentMemory,
  refreshEnvironmentProfile
} from "../src/environment_profile.js";

function tempProfilePath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `operator-env-${name}-`));
  return path.join(dir, "environment_profile.json");
}

test("environment profile creates persistent local profile and prompt summary", async () => {
  process.env.OPERATOR_ENV_PROFILE_PATH = tempProfilePath("create");
  const profile = refreshEnvironmentProfile();
  assert.equal(profile.schema_version, 1);
  assert.ok(fs.existsSync(process.env.OPERATOR_ENV_PROFILE_PATH));
  assert.match(profile.paths.preferred_exports, /RevitOperator[\\/]Exports/);
  const summary = formatEnvironmentSummaryForPrompt(profile);
  assert.match(summary, /Local Operator Environment Summary/);
  assert.match(summary, /Preferred exports:/);
});

test("path policy defaults Revit PDF exports to preferred exports folder", async () => {
  process.env.OPERATOR_ENV_PROFILE_PATH = tempProfilePath("actions");
  const profile = refreshEnvironmentProfile();
  const actions = applyEnvironmentPolicyToActions([
    { action_id: "a1", method: "POST", path: "/revit/export-pdf", body: { fileName: "A101.pdf" } }
  ], profile);
  assert.equal((actions[0].body as any).outputFolder, profile.paths.preferred_exports);
});

test("environment memory records failed tool results and capability manifest", async () => {
  process.env.OPERATOR_ENV_PROFILE_PATH = tempProfilePath("memory");
  refreshEnvironmentProfile();
  const failed: ToolResult = {
    action_id: "a1",
    method: "POST",
    path: "/revit/export-pdf",
    status: "failed",
    error: "Access is denied writing C:\\Program Files\\out.pdf"
  };
  recordToolResultsEnvironmentMemory([failed]);
  const profile = ensureEnvironmentProfile();
  assert.equal(profile.known_failed_operations.some((x: any) => x.error_type === "permission_denied"), true);
  const manifest = buildCapabilityManifest(profile);
  assert.ok(Array.isArray(manifest.restrictions));
});

test("a successful live Revit result marks the Revit API available", () => {
  process.env.OPERATOR_ENV_PROFILE_PATH = tempProfilePath("revit-success");
  refreshEnvironmentProfile();
  recordToolResultsEnvironmentMemory([{
    action_id: "a1",
    method: "POST",
    path: "/revit/sheets",
    status: "done",
    result_json: { count: 345 }
  }]);
  const profile = ensureEnvironmentProfile();
  assert.equal(profile.capabilities.can_use_revit_api, true);
  assert.equal(profile.tools.revit_api?.available, true);
});
