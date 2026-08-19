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
  assert.deepEqual(failure, {
    schema: "revit-operator.mcp-pre-dispatch-failure.v1",
    ok: false,
    code: "mcp_request_validation_failed",
    phase: "request_validation",
    retryable: true,
    request_dispatched: false,
    outcome_unknown: false,
    method: "POST",
    path: "/revit/open-model",
    missing_required_fields: ["filePath"],
    error: "POST /revit/open-model is missing required field: filePath. Inspect the exact tool contract and retry with a corrected request."
  });
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

  assert.equal(preflightKnownGenericToolBody(contract, {
    intent: "count_and_list",
    scope: "host",
    categories: ["OST_DuctTerminal"],
    maxRows: 500
  }), null);
});
