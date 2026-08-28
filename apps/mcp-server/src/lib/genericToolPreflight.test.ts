import assert from "node:assert/strict";
import test from "node:test";
import {
  genericToolRegistryLookupFailure,
  genericToolUnknownPathFailure,
  mcpPreDispatchFailureResult,
  preflightKnownGenericToolBody
} from "./genericToolPreflight.js";

test("known generic tools reject missing required fields before dispatch with retry-safe truth", () => {
  const failure = preflightKnownGenericToolBody({
    method: "POST",
    path: "/revit/open-model",
    required_fields: ["filePath"]
  }, { path: "C:\\models\\plumbing.rvt", audit: false });
  assert.equal(failure?.schema, "revit-operator.mcp-pre-dispatch-failure.v1");
  assert.equal(failure?.code, "mcp_request_validation_failed");
  assert.equal(failure?.request_dispatched, false);
  assert.equal(failure?.outcome_unknown, false);
  assert.deepEqual(failure?.missing_required_fields, ["filePath"]);
  assert.deepEqual(failure?.invalid_fields, ["body.filePath"]);
  assert.match(failure?.input_schema_digest ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(failure?.validation_issues, [{
    field_path: "body.filePath",
    expected_type: "required",
    actual_type: "missing",
    safe_correction_eligibility: "provider_corrected_arguments_required",
    correction_action: "provider_resubmit",
    expected_constraint: { kind: "required" },
    message: "body.filePath is required"
  }]);
  assert.equal(failure?.error, "POST /revit/open-model is missing required field: filePath. Inspect the exact tool contract and retry with a corrected request.");
  const result = mcpPreDispatchFailureResult(failure!);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, failure);
  assert.deepEqual(JSON.parse(result.content[0]!.text), failure);
});

test("registry admission failures preserve that the target mutation was not dispatched", () => {
  const failure = genericToolRegistryLookupFailure(
    "POST",
    "/revit/open-model",
    "courier deadline elapsed; outcome_unknown=true for GET /revit/tool-registry"
  );
  assert.equal(failure.code, "mcp_registry_validation_unavailable");
  assert.equal(failure.phase, "registry_validation");
  assert.equal(failure.request_dispatched, false);
  assert.equal(failure.outcome_unknown, false);
  assert.match(failure.error, /before the target request was dispatched/);
  assert.match(failure.error, /outcome_unknown=true for GET \/revit\/tool-registry/);
});

test("unknown generic routes are retry-safe admission failures rather than model-operation failures", () => {
  const failure = genericToolUnknownPathFailure("GET", "/revit/not-a-route");
  assert.equal(failure.code, "mcp_unknown_tool_path");
  assert.equal(failure.method, "GET");
  assert.equal(failure.request_dispatched, false);
  assert.equal(failure.outcome_unknown, false);
  assert.match(failure.error, /target request was not dispatched/);
});

test("valid bodies, GET tools, and contracts without unconditional requirements pass preflight", () => {
  assert.equal(preflightKnownGenericToolBody({
    method: "POST", path: "/revit/open-model", required_fields: ["filePath"]
  }, { filePath: "C:\\models\\plumbing.rvt", audit: false }), null);
  assert.equal(preflightKnownGenericToolBody({
    method: "GET", path: "/revit/context", required_fields: ["ignored"]
  }, undefined), null);
  assert.equal(preflightKnownGenericToolBody({
    method: "POST", path: "/revit/custom", required_fields: []
  }, undefined), null);
});

test("known generic tools enforce published enum, range, and nested collection constraints before dispatch", () => {
  const contract = {
    method: "POST",
    path: "/revit/quantify",
    required_fields: ["intent", "categories"],
    request_schema: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["count", "list", "count_and_list"] },
        scope: { type: "string", enum: ["host", "links", "both"] },
        categories: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } },
        maxRows: { type: "integer", minimum: 1, maximum: 500 }
      }
    }
  };
  const failure = preflightKnownGenericToolBody(contract, {
    intent: "count",
    scope: "project",
    categories: ["OST_DuctTerminal"],
    maxRows: 1000
  });
  assert.equal(failure?.code, "mcp_request_validation_failed");
  assert.equal(failure?.request_dispatched, false);
  assert.deepEqual(failure?.invalid_fields, ["body.scope", "body.maxRows"]);
  assert.match(failure?.error || "", /body\.scope must be one of "host", "links", "both"/);
  assert.match(failure?.error || "", /body\.maxRows must be at most 500/);

  const scalarArrayFailure = preflightKnownGenericToolBody(contract, {
    intent: "count_and_list",
    scope: "host",
    categories: "OST_DuctTerminal",
    maxRows: 500
  });
  assert.deepEqual(scalarArrayFailure?.validation_issues, [{
    field_path: "body.categories",
    expected_type: "array",
    actual_type: "string",
    safe_correction_eligibility: "provider_corrected_arguments_required",
    correction_action: "provider_resubmit",
    expected_constraint: { kind: "json_type", type: "array" },
    message: "body.categories must be of type array"
  }]);
  assert.equal(scalarArrayFailure?.input_schema_id, "operator-native/POST:/revit/quantify/input/v1");
  assert.deepEqual(failure?.validation_issues?.find(issue => issue.field_path === "body.scope")?.expected_constraint, {
    kind: "enum", allowed_values: ["host", "links", "both"]
  });

  assert.equal(preflightKnownGenericToolBody(contract, {
    intent: "count_and_list",
    scope: "host",
    categories: ["OST_DuctTerminal"],
    maxRows: 500
  }), null);
});

test("Candidate 11 exact find-text-notes elementIds request is admitted by its optional-selector contract", () => {
  const contract = {
    method: "POST",
    path: "/revit/find-text-notes",
    required_fields: [],
    request_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        docId: { type: "string" },
        familyDocumentId: { type: "string" },
        textContains: { type: "string" },
        contains: { type: "string" },
        regex: { type: "string" },
        viewId: { type: "integer" },
        elementId: { type: "integer" },
        elementIds: { type: "array", maxItems: 500, items: { type: "integer" } },
        max: { type: "integer", minimum: 1, maximum: 500 }
      },
      required: []
    }
  };

  assert.equal(preflightKnownGenericToolBody(contract, {
    elementIds: [1478627],
    max: 10
  }), null);

  const invalid = preflightKnownGenericToolBody(contract, {
    elementIds: 1478627,
    max: 10
  });
  assert.deepEqual(invalid?.invalid_fields, ["body.elementIds"]);
  assert.equal(invalid?.validation_issues?.[0]?.expected_type, "array");
  assert.equal(invalid?.request_dispatched, false);

  const outOfRange = preflightKnownGenericToolBody(contract, {
    elementIds: [1478627],
    max: 501
  });
  assert.deepEqual(outOfRange?.invalid_fields, ["body.max"]);
  assert.equal(outOfRange?.validation_issues?.[0]?.expected_type, "maximum:500");
});

test("schema diagnostics fail closed within bounded issue and field-path limits", () => {
  const tooMany = preflightKnownGenericToolBody({
    method: "POST",
    path: "/revit/bounded-contract",
    required_fields: Array.from({ length: 65 }, (_, index) => `field_${index}`)
  }, {});
  assert.equal(tooMany?.validation_issues?.length, 1);
  assert.equal(tooMany?.validation_issues?.[0]?.expected_constraint.kind, "schema_bounds");
  assert.ok((tooMany?.error.length ?? 0) <= 2_000);

  const oversizedPath = preflightKnownGenericToolBody({
    method: "POST",
    path: "/revit/bounded-contract",
    required_fields: ["x".repeat(600)]
  }, {});
  assert.equal(oversizedPath?.validation_issues?.[0]?.field_path, "body");
  assert.equal(oversizedPath?.validation_issues?.[0]?.actual_type, "schema_contract_out_of_bounds");
});
