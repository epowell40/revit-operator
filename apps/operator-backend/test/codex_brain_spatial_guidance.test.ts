import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  __testOnlyTrackCodexBrainTurnAbort,
  assertCertifiedMcpServerStatus,
  cancelCodexBrainTurn,
  formatCodexRequestEnvelope,
  formatCertifiedCodexContinuationForTest,
  formatToolResultsForCodexForTest,
  getCodexThreadStartProfileForTest,
  handleCertifiedCodexServerRequest,
  getCodexBaseInstructionsForTest
} from "../src/brains/codex_brain.js";

const certifiedBinding = {
  schema: "revit-operator.certified-sidecar-bootstrap.v1",
  method: "GET",
  path: "/revit/context",
  request: {},
  effect: "read",
  channel: "typed_mcp",
  alias: "revit_get_context"
};

test("certified Codex threads are isolated from MCP and Revit turn runtimes", () => {
  const certified = getCodexThreadStartProfileForTest({
    session_id: "session-profile",
    context: { operator_brain_route: "direct", certified_sidecar_bootstrap: certifiedBinding }
  });
  assert.equal(certified.certified, true);
  assert.equal(certified.threadKey, "certified-v1:15:session-profile");
  assert.equal(certified.sandbox, "read-only");
  assert.equal(certified.approvalPolicy, "never");
  assert.equal(certified.dynamicToolMode, "none");
  assert.equal(certified.startRevitTurnRuntime, false);
  assert.match(certified.baseInstructions, /only executable Revit action.*GET \/revit\/context/i);
  assert.doesNotMatch(certified.baseInstructions, /revit_search_tools|Execution ladder/i);

  const normal = getCodexThreadStartProfileForTest({ session_id: "session-profile", context: {} });
  assert.equal(normal.certified, false);
  assert.equal(normal.threadKey, "normal-v1:15:session-profile");
  assert.equal(normal.sandbox, "workspace-write");
  assert.equal(normal.dynamicToolMode, "revit_runtime");
  assert.equal(normal.startRevitTurnRuntime, true);
});

test("executable Codex turns bind backend auth before provider start and clean the lease", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "brains", "codex_brain.ts"), "utf8");
  const start = source.indexOf("export async function decideCodexStreaming");
  const end = source.indexOf("\nexport ", start + 10);
  const body = source.slice(start, end > start ? end : undefined);
  const authGuard = body.indexOf("if (threadProfile.startRevitTurnRuntime && !backendAuth)");
  const leaseOpen = body.indexOf("beginBackendAuthLease(req.session_id, backendAuth!)");
  const providerStart = body.indexOf("return await activeClient.startTurn({");
  const leaseCleanup = body.lastIndexOf("endBackendAuthLease(backendAuthLease)");
  assert.ok(authGuard >= 0 && authGuard < providerStart, "missing auth must stop before provider call 1");
  assert.ok(leaseOpen > authGuard && leaseOpen < providerStart, "the turn-scoped auth lease must open before provider call 1");
  assert.ok(leaseCleanup > providerStart, "the credential lease must be removed during turn cleanup");
});

test("Codex persisted profile keys remain disjoint for adversarial session strings", () => {
  const certified = getCodexThreadStartProfileForTest({
    session_id: "s",
    context: { operator_brain_route: "direct", certified_sidecar_bootstrap: certifiedBinding }
  });
  const normalCollision = getCodexThreadStartProfileForTest({ session_id: "s:certified-direct", context: {} });
  const normalDelimiter = getCodexThreadStartProfileForTest({ session_id: "certified-v1:1:s", context: {} });
  const certifiedDelimiter = getCodexThreadStartProfileForTest({
    session_id: "normal-v1:1:s",
    context: { operator_brain_route: "direct", certified_sidecar_bootstrap: certifiedBinding }
  });
  assert.notEqual(certified.threadKey, normalCollision.threadKey);
  assert.notEqual(normalDelimiter.threadKey, certifiedDelimiter.threadKey);
  assert.match(certified.threadKey, /^certified-v1:1:s$/);
  assert.match(normalCollision.threadKey, /^normal-v1:18:s:certified-direct$/);
});

test("certified envelope is canonical, bounded, and omits generic turn guidance", () => {
  const envelope = formatCodexRequestEnvelope({
    version: "operator.backend.v1",
    session_id: "envelope",
    message_id: "m-envelope",
    user_text: "change everything",
    user_attachments: [{ id: "ignored", filename: "ignored.pdf", bytes: 99 }],
    context: {
      unrelated: "x".repeat(35_000),
      operator_brain_route: "direct",
      certified_sidecar_bootstrap: certifiedBinding,
      revit: {
        source: { live: true, provenance: "typed_mcp" },
        process_id: 42,
        courier_executor_id: "executor-a",
        document: { projectIdentity: "project-1", activeView: { id: "v1", name: "COVER", type: "DrawingSheet" } },
        readiness: { active_document_name: "Snowdon Towers", active_document_path: "C:/Model.rvt", active_view_name: "COVER", active_view_type: "DrawingSheet", selection: [1, 2] }
      },
      ui: { revit_document: { process_id: 42 } }
    }
  });
  assert.match(envelope, /"active_document_name":"Snowdon Towers"/);
  assert.match(envelope, /"active_document_path":"C:\/Model\.rvt"/);
  assert.match(envelope, /COVER/);
  assert.doesNotMatch(envelope, /"document":\{"title":"Snowdon Towers"|"document":\{[^}]*"path":"C:\/Model\.rvt"/);
  assert.match(envelope, /certified_sidecar_bootstrap/);
  assert.match(envelope, /revit_get_context/);
  assert.doesNotMatch(envelope, /x{1000}|CURRENT TURN CONTRACT|discover one exact contract|apply once only|ignored\.pdf/);
});

test("normal Codex envelope retains the generic contract and attachment metadata", () => {
  const envelope = formatCodexRequestEnvelope({
    version: "operator.backend.v1",
    session_id: "normal-envelope",
    message_id: "m-normal",
    user_text: "Inspect the model.",
    context: {},
    user_attachments: [{ id: "attachment-1", filename: "normal.pdf", bytes: 99 }]
  });
  assert.match(envelope, /CURRENT TURN CONTRACT/);
  assert.match(envelope, /normal\.pdf/);
});

test("certified Codex handler declines dynamic MCP requests without a runtime dispatch", async () => {
  let callToolCalls = 0;
  const runtime = { callTool: () => { callToolCalls += 1; } };
  for (const method of ["item/tool/call", "item/dynamicTool/call"]) {
    const response = await handleCertifiedCodexServerRequest({
      method,
      params: { namespace: "revit_operator", tool: "revit_find_elements", arguments: {} }
    } as any);
    assert.equal((response as any).success, false);
    assert.match((response as any).contentItems[0].text, /does not permit dynamic, MCP, or Revit tool execution/);
  }
  assert.equal(callToolCalls, 0);
  void runtime;
});

test("certified startup fails closed when MCP status exposes an adversarial server", () => {
  assert.doesNotThrow(() => assertCertifiedMcpServerStatus({ data: [] }));
  assert.doesNotThrow(() => assertCertifiedMcpServerStatus({ data: [], nextCursor: null }));
  for (const malformed of [
    {},
    { data: "not-an-array" },
    { data: [], nextCursor: "page-2" },
    { data: [], mcpServers: [{ name: "evil" }] },
    { data: [], unknown: true },
  ]) {
    assert.throws(
      () => assertCertifiedMcpServerStatus(malformed),
      /Certified Codex MCP status is unavailable or malformed/,
    );
  }
  assert.throws(
    () => assertCertifiedMcpServerStatus({ data: [{ name: "evil", command: "fake-mcp-server" }] }),
    /refused configured MCP servers: evil/
  );
});

test("certified empty Codex continuations retain context and the denied synthetic result", () => {
  const continuation = formatCertifiedCodexContinuationForTest({
    version: "operator.backend.v1",
    session_id: "session-continuation",
    message_id: "message-continuation",
    user_text: "",
    context: { operator_brain_route: "direct", certified_sidecar_bootstrap: certifiedBinding },
    tool_results: [{
      action_id: "certified-correction",
      method: "GET",
      path: "/revit/find-elements",
      status: "failed",
      failure_code: "certified_action_denied",
      request_dispatched: false,
      outcome_unknown: false,
      reconciliation_required: false
    }]
  });
  assert.match(continuation, /certified_sidecar_bootstrap/);
  assert.match(continuation, /revit_get_context/);
  assert.match(continuation, /failure_code: certified_action_denied/);
  assert.match(continuation, /terminal evidence answer/);
  assert.doesNotMatch(continuation, /Execution ladder|revit_search_tools|\(continue\)/);
});

test("Codex planner cancellation requests a protocol interrupt without aborting a healthy wait", async () => {
  const tracked = __testOnlyTrackCodexBrainTurnAbort("session-cancel", "message-cancel");
  try {
    assert.equal(tracked.signal.aborted, false);
    assert.equal(cancelCodexBrainTurn("session-cancel", "message-cancel"), true);
    await tracked.waitForInterrupt();
    assert.equal(tracked.interruptionRequested(), true);
    assert.equal(tracked.signal.aborted, false);
  } finally {
    tracked.cleanup();
  }
  assert.equal(cancelCodexBrainTurn("session-cancel", "message-cancel"), false);
});

test("codex base instructions explicitly steer spatial export workflows", () => {
  const instructions = getCodexBaseInstructionsForTest();
  assert.match(instructions, /Spatial\/object-location rule:/);
  assert.match(instructions, /\/revit\/export-visible-elements/);
  assert.match(instructions, /\/revit\/pick-candidate-cluster/);
  assert.match(instructions, /host-aware\/exemplar-driven workflows/);
});

test("codex tool-result formatting includes compact spatial export summaries", () => {
  const formatted = formatToolResultsForCodexForTest([
    {
      action_id: "a1",
      method: "POST",
      path: "/revit/export-visible-elements",
      status: "done",
      result_json: {
        frameId: "frame-403",
        count: 2,
        items: [
          {
            elementId: 1465049,
            sourceScopedId: "host:1465049",
            categoryToken: "OST_ElectricalFixtures",
            hostBuiltInCategory: "OST_Walls",
            space: { number: "403", name: "Live/Work Unit 403" },
            anchor: {
              image: { x: 849.87, y: 796.4, normalizedX: 0.38648, normalizedY: 0.65171, insideFrame: true }
            },
            orientation: { planAzimuthRadians: 3.14159 }
          }
        ],
        mapping: {
          mode: "2d_affine",
          frameBasis: "exported_raster",
          rasterAspect: 1.7995,
          frameAspect: 1.7995,
          aspectCorrectionApplied: true,
          notes: "Per-element pixel/image coordinates are derived from the same exported-raster affine mapping used for the saved frame."
        }
      }
    }
  ] as any);

  assert.match(formatted, /result_json:/);
  assert.match(formatted, /"frameBasis":"exported_raster"/);
  assert.match(formatted, /"sourceScopedId":"host:1465049"/);
  assert.match(formatted, /"spaceCounts":\[\{"key":"403","count":1\}\]/);
});
