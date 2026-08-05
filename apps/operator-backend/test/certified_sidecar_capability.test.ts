import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import {
  CERTIFIED_SIDECAR_BOOTSTRAP_SCHEMA,
  filterCertifiedSidecarActions,
  isCertifiedSidecarRequest
} from "../src/capabilities/certified_sidecar_capability.js";
import { __testOnlyFinalizeDecision, decide, decideStreaming } from "../src/brain.js";

function request(context: unknown): ChatRequest {
  return { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "certified-sidecar", message_id: "message-1", user_text: "project profile", context };
}

const binding = {
  schema: CERTIFIED_SIDECAR_BOOTSTRAP_SCHEMA,
  method: "GET",
  path: "/revit/context",
  request: {},
  effect: "read",
  channel: "typed_mcp",
  alias: "revit_get_context"
} as const;

test("certified sidecar bootstrap is exact and caller variations can only fail closed", () => {
  assert.equal(isCertifiedSidecarRequest(request({ operator_brain_route: "direct", certified_sidecar_bootstrap: binding })), true);
  assert.equal(isCertifiedSidecarRequest(request({ operator_brain_route: "direct", certified_sidecar_bootstrap: { ...binding, alias: "revit_find_elements" } })), false);
  assert.equal(isCertifiedSidecarRequest(request({ operator_brain_route: "direct", certified_sidecar_bootstrap: { ...binding, request: { query: "spoof" } } })), false);
  assert.equal(isCertifiedSidecarRequest(request({ operator_brain_route: "direct", certified_sidecar_bootstrap: { ...binding, policy_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } })), false);
});

test("trusted policy intersects the only direct certified action identity", () => {
  const result = filterCertifiedSidecarActions([
    { action_id: "context", method: "GET", path: "/revit/context" },
    { action_id: "find", method: "POST", path: "/revit/find-elements", body: { query: "doors" } },
    { action_id: "capabilities", method: "GET", path: "/revit/capabilities" }
  ]);
  assert.equal(result.controlPlaneFailure, undefined);
  assert.equal(result.denied, true);
  assert.deepEqual(result.actions.map(action => action.action_id), ["context"]);
  assert.match(result.policyHash ?? "", /^sha256:/);
});

test("missing trusted policy is a control-plane failure, not a fallback allowlist", () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "certified-sidecar-policy-")), "missing.json");
  const result = filterCertifiedSidecarActions([{ action_id: "context", method: "GET", path: "/revit/context" }], {
    OPERATOR_TOOL_EXPOSURE_POLICY_PATH: missing,
    OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  assert.equal(result.actions.length, 0);
  assert.equal(result.controlPlaneFailure, "CERTIFICATION_POLICY_UNAVAILABLE");
});

test("certified direct lane bypasses the phrase preflight in both modes but centrally denies provider actions", async () => {
  const certifiedRequest = request({ operator_brain_route: "direct", certified_sidecar_bootstrap: binding });
  let preflightCalls = 0;
  let providerCalls = 0;
  const provider = async () => {
    providerCalls += 1;
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: "I will discover elements.",
      actions: [{ action_id: "find", method: "POST" as const, path: "/revit/find-elements", body: { query: "doors" } }]
    };
  };
  const dependencies = {
    mepServiceAccessoryPreflight: () => { preflightCalls += 1; return null; },
    ruleBrain: provider
  };
  const prior = process.env.OPERATOR_BRAIN;
  process.env.OPERATOR_BRAIN = "rule";
  try {
    const nonStreaming = await decide(certifiedRequest, dependencies);
    const streaming = await decideStreaming(certifiedRequest, {}, dependencies);
    assert.equal(preflightCalls, 0);
    assert.equal(providerCalls, 2);
    assert.equal(nonStreaming.actions.length, 0);
    assert.equal(streaming.actions.length, 0);
    assert.equal(nonStreaming.assistant_message, "I will discover elements.");
    assert.equal(nonStreaming.certified_capability_limitations?.[0]?.code, "CERTIFIED_ACTION_DENIED");
    assert.deepEqual(nonStreaming.certified_capability_limitations?.[0]?.action_ids, ["find"]);
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_BRAIN;
    else process.env.OPERATOR_BRAIN = prior;
  }
});

test("only a proven predispatch certified read denial receives a structural degraded receipt", () => {
  const base = request({
    operator_brain_route: "direct",
    certified_sidecar_bootstrap: binding,
    revit: { process_id: 42, courier_executor_id: "executor-a", document: { title: "Model", path: "C:/Model.rvt" } }
  });
  const eligible = __testOnlyFinalizeDecision({ ...base, tool_results: [{
    action_id: "read-1", method: "GET", path: "/revit/context", request_effect: "read", status: "failed",
    request_dispatched: false, outcome_unknown: false, reconciliation_required: false, failure_code: "revit_execution_denied"
  }] }, { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "The injected context is still available.", actions: [] });
  assert.equal(eligible.certified_read_disposition?.status, "degraded");
  assert.deepEqual(eligible.certified_read_disposition?.action_ids, ["read-1"]);
  for (const unsafe of [
    { request_effect: "apply", request_dispatched: false, outcome_unknown: false, reconciliation_required: false },
    { request_effect: "read", request_dispatched: true, outcome_unknown: false, reconciliation_required: false },
    { request_effect: "read", request_dispatched: false, outcome_unknown: true, reconciliation_required: true }
  ]) {
    const response = __testOnlyFinalizeDecision({ ...base, tool_results: [{ action_id: "unsafe", method: "GET", path: "/revit/context", status: "failed", failure_code: "revit_execution_denied", ...unsafe }] }, { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "No action.", actions: [] });
    assert.equal(response.certified_read_disposition, undefined);
  }
});

test("final certified fence permits only the exact context identity", () => {
  const response = __testOnlyFinalizeDecision(
    request({ operator_brain_route: "direct", certified_sidecar_bootstrap: binding }),
    { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "", actions: [{ action_id: "context", method: "GET", path: "/revit/context" }] }
  );
  assert.deepEqual(response.actions.map(action => action.action_id), ["context"]);
});
