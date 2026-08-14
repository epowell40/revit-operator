import assert from "node:assert/strict";
import test from "node:test";
import { mcpPreDispatchFailureResult, preflightKnownGenericToolBody } from "./genericToolPreflight.js";

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
