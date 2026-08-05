import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ChatResponse, type ToolResult } from "../src/contracts.js";
import {
  CERTIFIED_SIDECAR_BOOTSTRAP_SCHEMA,
  filterCertifiedSidecarActions,
  isCertifiedSidecarRequest
} from "../src/capabilities/certified_sidecar_capability.js";
import { __testOnlyFinalizeDecision, decide, decideStreaming } from "../src/brain.js";
import { __testOnlyBuildPromptForRequest } from "../src/brains/openai_brain.js";
import { normalizeIncomingToolResults } from "../src/revit_batch/tool_result_normalization.js";

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
  assert.match(result.state?.policy_hash ?? "", /^sha256:/);
  assert.equal(result.state?.channel, "typed_mcp");
  assert.equal(result.state?.alias, "revit_get_context");
});

test("missing trusted policy is a control-plane failure, not a fallback allowlist", () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "certified-sidecar-policy-")), "missing.json");
  const result = filterCertifiedSidecarActions([{ action_id: "context", method: "GET", path: "/revit/context" }], {
    OPERATOR_TOOL_EXPOSURE_POLICY_PATH: missing,
    OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  assert.equal(result.actions.length, 0);
  assert.equal(result.controlPlaneFailure, "CERTIFICATION_POLICY_UNAVAILABLE");
  const priorPath = process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH;
  const priorHash = process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = missing;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  try {
    const response = __testOnlyFinalizeDecision(
      request({ operator_brain_route: "direct", certified_sidecar_bootstrap: binding }),
      { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "ordinary provider prose", actions: [] }
    );
    assert.equal(response.ok, false);
    assert.equal(response.actions.length, 0);
    assert.equal(response.request_dispatched, false);
    assert.equal(response.outcome_unknown, false);
    assert.equal(response.reconciliation_required, false);
  } finally {
    if (priorPath === undefined) delete process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH; else process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = priorPath;
    if (priorHash === undefined) delete process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256; else process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = priorHash;
  }
});

test("certified direct lane bypasses the phrase preflight in both modes but centrally denies provider actions", async () => {
  const certifiedRequest = request({ operator_brain_route: "direct", certified_sidecar_bootstrap: binding });
  let preflightCalls = 0;
  let providerCalls = 0;
  const provider = async (): Promise<ChatResponse> => {
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
    assert.deepEqual(nonStreaming.certified_capability_limitations?.[0]?.actions, [{ action_id: "find", method: "POST", path: "/revit/find-elements", body: { query: "doors" } }]);
    assert.deepEqual(streaming.certified_capability_limitations, nonStreaming.certified_capability_limitations);
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
    request_dispatched: false, outcome_unknown: false, reconciliation_required: false, failure_code: "certified_action_denied"
  }] }, { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "The injected context establishes the open Model project.", actions: [] });
  assert.equal(eligible.certified_read_disposition?.status, "degraded");
  assert.deepEqual(eligible.certified_read_disposition?.action_ids, ["read-1"]);
  assert.deepEqual(eligible.certified_read_disposition?.evidence_ids, ["certified-context"]);
  assert.equal(eligible.certified_read_disposition?.answer_status, "grounded_evidence_summary");
  assert.deepEqual(eligible.certified_read_disposition?.answer_evidence_ids, ["certified-context"]);
  const unsafeCases: Array<Pick<ToolResult, "request_effect" | "request_dispatched" | "outcome_unknown" | "reconciliation_required">> = [
    { request_effect: "apply", request_dispatched: false, outcome_unknown: false, reconciliation_required: false },
    { request_effect: "read", request_dispatched: true, outcome_unknown: false, reconciliation_required: false },
    { request_effect: "read", request_dispatched: false, outcome_unknown: true, reconciliation_required: true }
  ];
  for (const unsafe of unsafeCases) {
    const response = __testOnlyFinalizeDecision({ ...base, tool_results: [{ action_id: "unsafe", method: "GET", path: "/revit/context", status: "failed", failure_code: "certified_action_denied", ...unsafe }] }, { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "The open Model project remains available.", actions: [] });
    assert.equal(response.certified_read_disposition, undefined);
  }
  const priorApply = __testOnlyFinalizeDecision({ ...base, tool_results: [
    { action_id: "write", method: "POST", path: "/revit/set-parameter", request_effect: "apply", status: "done", request_dispatched: true, outcome_unknown: false, reconciliation_required: false },
    { action_id: "read-2", method: "GET", path: "/revit/context", request_effect: "read", status: "failed", request_dispatched: false, outcome_unknown: false, reconciliation_required: false, failure_code: "certified_action_denied" }
  ] }, { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "No action.", actions: [] });
  assert.equal(priorApply.certified_read_disposition, undefined);
  for (const failureCode of ["revit_execution_denied", "revit_execution_not_dispatched", "revit_execution_authorization_unavailable", "revit_execution_authorization_endpoint_missing"]) {
    const infrastructure = __testOnlyFinalizeDecision({ ...base, tool_results: [{
      action_id: failureCode, method: "GET", path: "/revit/context", request_effect: "read", status: "failed",
      request_dispatched: false, outcome_unknown: false, reconciliation_required: false, failure_code: failureCode
    }] }, { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "The open Model project remains available.", actions: [] });
    assert.equal(infrastructure.certified_read_disposition, undefined, failureCode);
  }
  const planningOnly = __testOnlyFinalizeDecision({ ...base, tool_results: [{
    action_id: "planning", method: "GET", path: "/revit/context", request_effect: "read", status: "failed",
    request_dispatched: false, outcome_unknown: false, reconciliation_required: false, failure_code: "certified_action_denied"
  }] }, { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "I will inspect further.", actions: [] });
  assert.equal(planningOnly.certified_read_disposition, undefined);
});

test("backend ingress preserves exact predispatch safety facts for a certified correction", () => {
  const [normalized] = normalizeIncomingToolResults([{
    action_id: "certified-correction", method: "GET", path: "/revit/find-elements", request_effect: "read",
    status: "failed", failure_code: "certified_action_denied", request_dispatched: false,
    outcome_unknown: false, reconciliation_required: false, retryable: false
  }], "certified-ingress-session");
  assert.equal(normalized?.request_dispatched, false);
  assert.equal(normalized?.outcome_unknown, false);
  assert.equal(normalized?.reconciliation_required, false);
  assert.equal(normalized?.failure_code, "certified_action_denied");
});

test("certified direct hard-gates the Codex MCP runtime before inference in both modes", async () => {
  const certifiedRequest = request({ operator_brain_route: "direct", certified_sidecar_bootstrap: binding });
  let providerCalls = 0;
  const prior = process.env.OPERATOR_BRAIN;
  process.env.OPERATOR_BRAIN = "codex";
  try {
    const nonStreaming = await decide(certifiedRequest, { codexBrain: async () => { providerCalls += 1; throw new Error("must not run"); } });
    const streaming = await decideStreaming(certifiedRequest, {}, { codexStreamingBrain: async () => { providerCalls += 1; throw new Error("must not run"); } });
    assert.equal(providerCalls, 0);
    assert.equal(nonStreaming.ok, false);
    assert.equal(streaming.ok, false);
    assert.equal(nonStreaming.request_dispatched, false);
    assert.equal(streaming.request_dispatched, false);
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_BRAIN;
    else process.env.OPERATOR_BRAIN = prior;
  }
});

test("final certified fence permits only the exact context identity", () => {
  const response = __testOnlyFinalizeDecision(
    request({ operator_brain_route: "direct", certified_sidecar_bootstrap: binding }),
    { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "", actions: [{ action_id: "context", method: "GET", path: "/revit/context" }] }
  );
  assert.deepEqual(response.actions.map(action => action.action_id), ["context"]);
});

test("certified direct prompt uses injected context and omits the broad discovery ladder", async () => {
  const prompt = await __testOnlyBuildPromptForRequest(request({
    operator_brain_route: "direct",
    certified_sidecar_bootstrap: binding,
    revit: {
      source: { live: true, context_endpoint: "/revit/context" },
      document: { title: "Snowdon Towers" },
      readiness: { active_view_name: "COVER SHEET", active_view_type: "DrawingSheet" }
    }
  }));
  assert.match(prompt, /Certified direct Sidecar lane:/);
  assert.match(prompt, /already observed by the Sidecar/);
  assert.match(prompt, /only executable Revit action.*GET \/revit\/context/i);
  assert.doesNotMatch(prompt, /Execution ladder: try a dedicated \/revit\/\* primitive first/);
  assert.doesNotMatch(prompt, /Fast Revit edit playbooks:/);
});
