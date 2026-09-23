import assert from "node:assert/strict";
import test from "node:test";
import {
  existingConditionsInterpretationInputSchema,
  handleExistingConditionsInterpretation,
  registerExistingConditionsInterpretationTool
} from "./existingConditionsInterpretationTool.js";
import { ASSIGNMENT_KERNEL_V2_BINDING_META_KEY, runWithAssignmentKernelV2 } from "../lib/assignmentKernelV2.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

const input = {
  packageId: "floor-4-east",
  objective: "Draft all visible duct in this area.",
  views: [
    { viewKey: "sheet", attachmentId: "pdf-1", page: 4, analysisRole: "sheet_context" as const },
    { viewKey: "detail", attachmentId: "pdf-1", page: 4, analysisRole: "region_detail" as const, region: { min_u: 0.2, min_v: 0.3, max_u: 0.7, max_v: 0.8 }, parentContextViewKey: "sheet" }
  ],
  response: {
    schema_version: 1 as const, package_id: "floor-4-east", coordinate_space: "normalized_uv_top_left" as const,
    view_keys: ["sheet", "detail"],
    source_marks: [{ source_mark_id: "m1", source_view_key: "detail", disposition_status: "unresolved" as const, primitive_ids: [], reason: "Size is not legible." }],
    primitives: [], open_questions: ["Size is not legible."]
  }
};

const bindingMeta = {
  [ASSIGNMENT_KERNEL_V2_BINDING_META_KEY]: {
    assignment_id: "assignment-1", run_id: "run-1", generation: 3, session_id: "session-1", principal_id: "principal-1"
  }
};

test("existing-conditions interpretation tool requires the trusted host task binding and forwards it", async () => {
  let received: any;
  const result = await runWithAssignmentKernelV2(bindingMeta, async () => handleExistingConditionsInterpretation(input, {
    async validateExistingConditionsInterpretation(value) { received = value; return { ok: true, native_write_allowed: false }; }
  }));

  assert.equal(received.assignment_id, "assignment-1");
  assert.equal(received.assignment_run_id, "run-1");
  assert.equal(received.assignment_generation, 3);
  assert.equal(received.session_id, "session-1");
  assert.equal(received.views[1].analysis_role, "region_detail");
  assert.deepEqual(JSON.parse(result.content[0]!.text), { ok: true, native_write_allowed: false });
});

test("tool input rejects model-supplied paths and write controls", () => {
  assert.equal(existingConditionsInterpretationInputSchema.safeParse({ ...input, filePath: "C:/secret.pdf" }).success, false);
  assert.equal(existingConditionsInterpretationInputSchema.safeParse({ ...input, apply: true }).success, false);
  assert.equal(existingConditionsInterpretationInputSchema.safeParse({ ...input, views: [{ ...input.views[0], imagePath: "C:/secret.png" }, input.views[1]] }).success, false);
});

test("tool registers a single explicitly read-only MCP surface", () => {
  let registration: any;
  registerExistingConditionsInterpretationTool((name, description, schema, handler) => { registration = { name, description, schema, handler }; });
  assert.equal(registration.name, "operator_validate_existing_conditions_interpretation");
  assert.match(registration.description, /read-only/i);
  assert.match(registration.description, /never creates or changes Revit elements/i);
  assert.match(registration.description, /region_detail viewKey, not the sheet_context/);
  assert.match(registration.description, /visible mark cited by a primitive must have disposition_status candidate/);
  assert.match(registration.description, /annotation may represent a legible note while its implied route/);
  assert.equal(registration.schema, existingConditionsInterpretationInputSchema);
});

test("published tool schema uses homogeneous array items accepted by Codex dynamic tools", () => {
  const schema = toJsonSchemaCompat(existingConditionsInterpretationInputSchema, {
    strictUnions: true, pipeStrategy: "input"
  }) as any;
  const direction = schema.properties.response.properties.primitives.items.properties.endpoints.items.properties.outward_direction_uv;
  assert.equal(direction.type, "array");
  assert.equal(direction.minItems, 2);
  assert.equal(direction.maxItems, 2);
  assert.equal(direction.items.type, "number");
});
