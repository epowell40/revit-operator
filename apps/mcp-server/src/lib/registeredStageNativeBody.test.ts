import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { preflightKnownGenericToolBody } from "./genericToolPreflight.js";
import { registeredStageNativeBody } from "./registeredStageNativeBody.js";

test("the retained C103 planner envelope projects to native Params without changing route geometry", () => {
  const exact = JSON.parse(readFileSync(new URL("../../src/lib/fixtures/c103-registered-stage-native-envelope.json", import.meta.url), "utf8"));
  const native = registeredStageNativeBody(exact) as Record<string, any>;
  assert.equal(exact.dryRun, true);
  assert.equal(native.dryRun, true);
  assert.equal(native.inputFingerprintSha256, exact.inputFingerprintSha256);
  assert.equal(native.stageKey, exact.stageKey);
  assert.deepEqual(native.operations[0].apply_body, exact.operations[0].apply_body);
  assert.equal(Object.hasOwn(native, "authorizationBasis"), false);
  assert.equal(Object.hasOwn(native, "benchmarkCredit"), false);
  assert.equal(Object.hasOwn(native, "provisionalObservationIds"), false);
  assert.equal(Object.hasOwn(native.operations[0], "continuation_endpoints"), false);
  assert.equal(Object.hasOwn(native.operations[0], "execution_mode"), false);
  assert.equal(Object.hasOwn(native.operations[0], "observation_ids"), false);
});

test("registered PDF stage keeps host provenance out of the native wire body", () => {
  const registered = {
    inputFingerprintSha256: "a".repeat(64), stageKey: "operation:sa-next",
    provisionalObservationIds: ["obsv2_1"], authorizationBasis: "source_registered",
    benchmarkCredit: false, dryRun: true, verify: true, maximumCreatedElements: 12,
    targetViewId: 1363433, applyTargetViewPhase: false,
    requireAllCreatedElementsVisibleInTargetView: true,
    operations: [{
      action_key: "sa-next", path: "/revit/mep-route-workflow",
      apply_body: { routingMode: "orthogonal" },
      expected_created_min: 1, expected_created_max: 5,
      continuation_endpoints: [{ endpoint_key: "far-end" }],
      execution_mode: "provisional_backbone_batch", observation_ids: ["obsv2_2"]
    }],
    priorActionOutputs: [{
      action_key: "prior", created_element_ids: [101],
      continuation_endpoints: [{ endpoint_key: "prior-end" }]
    }]
  };
  const native = registeredStageNativeBody(registered) as Record<string, any>;
  assert.equal(registered.operations[0].execution_mode, "provisional_backbone_batch");
  assert.equal(Object.hasOwn(native, "authorizationBasis"), false);
  assert.equal(Object.hasOwn(native, "provisionalObservationIds"), false);
  assert.equal(Object.hasOwn(native.operations[0], "continuation_endpoints"), false);
  assert.equal(Object.hasOwn(native.priorActionOutputs[0], "continuation_endpoints"), false);
  assert.deepEqual(native.operations[0].apply_body, registered.operations[0].apply_body);
  const contract = {
    method: "POST", path: "/revit/existing-conditions-mep-draft-workflow",
    request_schema: {
      type: "object", additionalProperties: false,
      properties: {
        inputFingerprintSha256: { type: "string" }, stageKey: { type: "string" },
        dryRun: { type: "boolean" }, verify: { type: "boolean" },
        maximumCreatedElements: { type: "integer" }, targetViewId: { type: "integer" },
        applyTargetViewPhase: { type: "boolean" },
        requireAllCreatedElementsVisibleInTargetView: { type: "boolean" },
        operations: { type: "array", items: { type: "object", additionalProperties: false,
          properties: {
            action_key: { type: "string" }, path: { type: "string" },
            apply_body: {}, expected_created_min: { type: "integer" },
            expected_created_max: { type: "integer" }
          } } },
        priorActionOutputs: { type: "array", items: { type: "object", additionalProperties: false,
          properties: { action_key: { type: "string" }, created_element_ids: { type: "array", items: { type: "integer" } } }
        } }
      }
    }
  };
  assert.ok(preflightKnownGenericToolBody(contract, registered)?.invalid_fields?.includes("body.authorizationBasis"));
  assert.equal(preflightKnownGenericToolBody(contract, native), null);
});
