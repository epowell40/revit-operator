import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNativeProgram } from "./dynamicNativeProgram.js";

const env = { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" };
const doc = "sha256:" + "a".repeat(64);
test("explicit active-document native write does not require predictions of internal changes", () => {
  const result = normalizeNativeProgram({ entry_type: "BuildNetwork", effect_scope: "active_document" } as any, "apply", "2024", doc, env);
  assert.equal((result.program as any).effectScope, "active_document");
  assert.deepEqual(result.program.allowedExistingUniqueIds, []);
  assert.equal(result.program.maxAffectedElements, 0);
  assert.equal(result.expectedDocumentFingerprint, doc);
});
test("document scope cannot silently replace read or explicit legacy effect restrictions", () => {
  for (const input of [
    { entry_type: "X", effect_scope: "active_document", allowed_existing_unique_ids: ["existing"] },
    { entry_type: "X", effect_scope: "active_document", max_affected_elements: 32 },
    { entry_type: "X", effect_scope: "active_document", allow_create: true },
    { entry_type: "X", effect_scope: "invalid" },
    { entry_type: "X", effect_scope: null }
  ]) assert.throws(() => normalizeNativeProgram(input as any, "apply", "2024", doc, env));
  assert.throws(() => normalizeNativeProgram({ entry_type: "X", effect_scope: "active_document" } as any, "read", "2024", doc, env));
  assert.throws(() => normalizeNativeProgram({ entry_type: "X", effect_scope: "active_document" } as any, "apply", "2024", doc, {}));
  assert.throws(() => normalizeNativeProgram({ entry_type: "X" }, "apply", "2024", doc, env));
  const legacy = normalizeNativeProgram({ entry_type: "X", allow_create: true, max_affected_elements: 10 }, "apply", "2024", doc, env);
  assert.equal(legacy.program.maxAffectedElements, 10);
  assert.equal(legacy.program.allowCreate, true);
});
