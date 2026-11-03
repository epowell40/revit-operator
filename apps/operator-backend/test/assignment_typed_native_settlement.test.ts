import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleCodexServerRequest } from "../src/brains/codex_brain.js";
import { normalizeAssignmentControlPlane, reduceAssignmentControlPlane } from "../src/assignments/control_plane.js";
import { ensureAssignmentRunForTurn } from "../src/assignments/turn_journal.js";
import { createGoal, getGoal } from "../src/goals/service.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner } from "../src/teammate_loop_runtime.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";
import { readEvidenceRef, readAuthoritativeEvidence } from "../src/evidence/evidence_store.js";

async function workspace(fn: () => Promise<void>): Promise<void> {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-typed-native-settlement-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { await fn(); }
  finally {
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("427 missing Legend source retains native no-transaction authority and guidance without settling historical errors", { concurrency: false }, async () => {
  await workspace(async () => {
    for (const variant of ["not-started", "historical-error", "pending"] as const) {
      const known = variant === "not-started";
      const correction = "Create the first Legend through Revit's View > Legends > Legend command. Do not substitute a Drafting view or key schedule.";
      const result = await invokeTyped({
        sessionId: `legend427-${variant}`, tool: "revit_call_tool", nativePath: "/revit/create-view",
        requestedEffect: "apply", nativeRequestedEffect: "apply",
        resultEffect: known ? "none" : "unknown", resultAuthority: known ? "native_transaction" : "native_host",
        args: { method: "POST", path: "/revit/create-view", body: { action: "create_legend", name: "Informational Legend", scale: 1, dryRun: false } },
        nativePayload: {
          status: "Blocked", success: false, applied: false, verified: false, errorCode: "legend_source_required",
          error: "No existing non-template Legend was found. No transaction was started.", correction,
          ...(variant === "historical-error" ? {} : { transaction: { status: known ? "not_started" : "pending", committed: false,
            modified_element_ids: [], affected_element_ids: [], added_element_ids: [], deleted_element_ids: [] } })
        }
      });
      assert.equal(result.current.attempts.length, 1);
      const attempt = result.current.attempts[0]!;
      assert.equal(attempt.effect.state, known ? "none" : "unknown");
      assert.equal(result.current.unresolved_unknown_attempt_ids.length, known ? 0 : 1);
      const ref = readEvidenceRef(attempt.evidence_refs[0]!);
      assert.equal(ref.trust_level, "authoritative_native");
      const retained = JSON.parse(readAuthoritativeEvidence(ref, { session_id: ref.session_id, assignment_id: ref.assignment_id,
        run_id: ref.run_id, attempt_id: ref.attempt_id, generation: ref.generation }).toString("utf8"));
      const payload = JSON.parse(retained.content[0].text);
      assert.equal(payload.success, false);
      assert.equal(payload.applied, false);
      assert.equal(payload.verified, false);
      assert.equal(payload.correction, correction);
      if (known) assert.equal(payload.transaction.status, "not_started");
    }
  });
});

function assignment(sessionId: string, requestedEffect: "read" | "apply" = "read") {
  const goal = createGoal({
    title: "Typed native settlement",
    objective: "Retain authoritative native settlement from a typed MCP operation.",
    acceptance_criteria: ["The exact native result is retained."],
    status: "active",
    related_session_id: sessionId,
    work_budget: { mode: "auto_goal", requested_effect: requestedEffect, document_fingerprint: "document-typed" }
  });
  const run = ensureAssignmentRunForTurn(sessionId, `run:${sessionId}`, "typed-native-settlement", true)!;
  return { goal, run };
}

function projection(goalId: string) {
  const goal = getGoal(goalId)!;
  return reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
}

test("C46 family placement retains unknown writes until native commit or rollback is supplied", { concurrency: false }, async () => {
  await workspace(async () => {
    for (const variant of [
      { name: "old", effect: "unknown" as const, authority: "native_host" as const, dryRun: false },
      { name: "commit", effect: "applied" as const, authority: "native_transaction" as const, dryRun: false },
      { name: "preview", effect: "none" as const, authority: "native_rollback" as const, dryRun: true }
    ]) {
      const result = await invokeTyped({
        sessionId: `c46-family-${variant.name}`, tool: "revit_call_tool", nativePath: "/revit/place-families",
        args: { method: "POST", path: "/revit/place-families", body: {
          familySymbolId: 1380250, levelName: "L4", viewId: 1363433, dryRun: variant.dryRun,
          instances: [{ x: -34.7975, y: -6.688, z: 40.1666666667, coordinateMode: "absolute_model", hostElementId: 1362429, linkedHostElementId: 2095221 }]
        } }, requestedEffect: "apply", nativeRequestedEffect: variant.dryRun ? "preview" : "apply",
        resultEffect: variant.effect, resultAuthority: variant.authority
      });
      assert.equal(result.current.attempts[0]?.effect.state, variant.effect);
      assert.equal(result.current.attempts[0]?.effect.authority, variant.authority);
      assert.equal(result.current.unresolved_unknown_attempt_ids.length, variant.effect === "unknown" ? 1 : 0);
    }
  });
});

function nativeSettlement(input: {
  assignmentId: string;
  runId: string;
  generation: number;
  nativeAttemptId: string;
  path: string;
  method?: "GET" | "POST";
  effect?: "none" | "unknown" | "applied";
  authority?: "native_host" | "native_transaction" | "native_rollback" | "native_receipt";
  requestedEffect?: "read" | "preview" | "apply";
}) {
  return {
    schema: "revit-operator.native-attempt-settlement.v1",
    assignment_id: input.assignmentId,
    attempt_id: input.nativeAttemptId,
    run_id: input.runId,
    generation: input.generation,
    requested_effect: input.requestedEffect ?? (input.effect === "applied" || input.effect === "unknown" ? "apply" : "read"),
    method: input.method ?? "POST",
    path: input.path,
    request_dispatched: true,
    effect_state: input.effect ?? "none",
    effect_reason: input.effect === "applied"
      ? "native_transaction_committed"
      : input.effect === "unknown"
        ? "native_outcome_unknown"
        : input.authority === "native_rollback"
          ? "verified_native_rollback"
          : "read_has_no_persistent_effect",
    effect_authority: input.authority ?? "native_host",
    affected_target_identities: [],
    receipt_refs: [`courier:${input.nativeAttemptId}`],
    evidence_refs: []
  };
}

async function invokeTyped(input: {
  sessionId: string;
  tool: string;
  nativePath: string;
  args?: Record<string, unknown>;
  requestedEffect?: "read" | "apply";
  resultEffect?: "none" | "unknown" | "applied";
  resultAuthority?: "native_host" | "native_transaction" | "native_rollback" | "native_receipt";
  nativePayload?: Record<string, unknown>;
  nativeRequestedEffect?: "read" | "preview" | "apply";
  nativeMethod?: "GET" | "POST";
}) {
  const { goal, run } = assignment(input.sessionId, input.requestedEffect ?? "read");
  const settlement = nativeSettlement({
    assignmentId: goal.id,
    runId: run.runId,
    generation: run.generation,
    nativeAttemptId: `native:${input.sessionId}`,
    path: input.nativePath,
    method: input.nativeMethod,
    effect: input.resultEffect,
    authority: input.resultAuthority,
    requestedEffect: input.nativeRequestedEffect
  });
  const runtime = {
    callTool: async () => ({
      content: [{ type: "text", text: JSON.stringify({
        status: "Ok",
        count: 509,
        items: Array.from({ length: 509 }, (_, index) => ({ elementId: index + 1 })),
        ...input.nativePayload,
        canonical_attempt_settlement: settlement
      }) }]
    })
  };
  const owner = beginTeammateLoopOwner(runtime, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: input.sessionId,
    message_id: `message:${input.sessionId}`,
    user_text: input.requestedEffect === "apply"
      ? "Update the selected Revit item."
      : "Return the requested inventory from the current Revit model.",
    context: { revit: { source: { live: true }, process_id: 42, document: { title: "Disposable", path: "C:\\Disposable.rvt" } } }
  });
  try {
    const response = await handleCodexServerRequest(runtime as any, {
      id: `request:${input.sessionId}`,
      method: "item/tool/call",
      params: {
        namespace: "revit_operator",
        turnId: `turn:${input.sessionId}`,
        callId: `call:${input.sessionId}`,
        tool: input.tool,
        arguments: input.args ?? {}
      }
    } as any) as any;
    return { response, current: projection(goal.id), settlement };
  } finally {
    endTeammateLoopOwner(owner);
  }
}

test("334 deletion candidates survive typed evidence without replacing rollback or unknown authority", { concurrency: false }, async () => {
  const fixture=JSON.parse(fs.readFileSync('test/fixtures/tee-deletion-candidate-diagnostics334.json','utf8'));
  await workspace(async()=>{
    for(const variant of [
      {name:'historical-error-projection',error:fixture.historical333ErrorOnly,effect:'none' as const,authority:'native_rollback' as const},
      {name:'synthetic-diagnostic-rollback',error:fixture.expectedError,effect:'none' as const,authority:'native_rollback' as const},
      {name:'synthetic-diagnostic-unsettled',error:fixture.expectedError,effect:'unknown' as const,authority:'native_host' as const}
    ]){
      const result=await invokeTyped({sessionId:`deletion334-${variant.name}`,tool:'revit_call_tool',
        nativePath:'/revit/connect-existing-mep-branch',requestedEffect:'apply',nativeRequestedEffect:'preview',
        resultEffect:variant.effect,resultAuthority:variant.authority,
        args:{method:'POST',path:'/revit/connect-existing-mep-branch',body:{connectionMode:'replace_tee_with_takeoff',
          kind:'duct',teeElementId:10,mainElementId:20,secondMainElementId:21,branchElementId:22,expectedTakeoffTypeId:30,dryRun:true,verify:true}},
        nativePayload:{status:'Blocked',success:false,ok:false,applied:false,error:variant.error,items:[],count:0,
          transaction:{status:variant.effect==='none'?'rolled_back':'pending',committed:false,addedElementIds:[],deletedElementIds:[]}}
      });
      assert.equal(result.current.attempts.length,1);
      const attempt=result.current.attempts[0]!;
      assert.equal(attempt.effect.state,variant.effect);
      assert.equal(result.current.unresolved_unknown_attempt_ids.length,variant.effect==='unknown'?1:0);
      const ref=readEvidenceRef(attempt.evidence_refs[0]!);
      assert.equal(ref.trust_level,'authoritative_native');
      const retained=JSON.parse(readAuthoritativeEvidence(ref,{session_id:ref.session_id,assignment_id:ref.assignment_id,
        run_id:ref.run_id,attempt_id:ref.attempt_id,generation:ref.generation}).toString('utf8'));
      assert.equal(retained.content.length,1);
      assert.equal(retained.content[0].type,'text');
      const payload=JSON.parse(retained.content[0].text);
      assert.equal(payload.error,variant.error);
      assert.equal(payload.applied,false);
      assert.deepEqual(payload.transaction.deletedElementIds,[]);
    }
  });
});

test("314 family-authoring preflight rejection settles none without relaxing an unknown dispatched failure", { concurrency: false }, async () => {
  await workspace(async () => {
    for (const effect of ["none", "unknown", "applied"] as const) {
      const result = await invokeTyped({sessionId: `family-create-314-${effect}`, tool: "revit_create_family_from_template",
        nativePath: "/revit/create-family-from-template", requestedEffect: "apply", nativeRequestedEffect: "apply",
        resultEffect: effect, resultAuthority: effect === "unknown" ? "native_host" : "native_receipt",
        args: {templatePath: "installed:generic-model", savePath: "artifacts/families/Box.rfa", loadIntoProject: true},
        nativePayload: effect === "none" ? {ok: false, status: "Rejected", error: "Installed family template not found",
          family_creation_receipt: {schema: "revit-operator.family-creation.v1", status: "not_started", reason: "preflight_failed",
            native_family_document_created: false, file_write_performed: false, project_load_invoked: false}}
          : effect === "unknown" ? {ok: false, error: "Native authoring failed after family creation began"}
          : {ok: true, status: "Created", filePath: "C:\\Disposable\\artifacts\\families\\Box.rfa", load: {familyId: 42}}
      });
      assert.equal(result.current.attempts[0]?.effect.state, effect);
      assert.equal(result.current.attempts[0]?.lease.state, effect === "unknown" ? "effect_unknown" : "settled");
      assert.equal(result.current.unresolved_unknown_attempt_ids.length, effect === "unknown" ? 1 : 0);
    }
  });
});

test("transport-bound typed find-elements retains its authoritative native route settlement", { concurrency: false }, async () => {
  await workspace(async () => {
    const result = await invokeTyped({
      sessionId: "typed-find-elements",
      tool: "revit_find_elements",
      nativePath: "/revit/find-elements",
      args: { categories: ["OST_DuctTerminal"], limit: 10_000 }
    });
    assert.equal(result.response.success, true, JSON.stringify({ response: result.response, current: result.current }, null, 2));
    assert.equal(result.current.attempts.length, 1);
    assert.equal(result.current.attempts[0]?.effect.state, "none");
    assert.equal(result.current.attempts[0]?.effect.authority, "native_host");
    assert.ok(result.current.attempts[0]?.receipt_refs.includes("courier:native:typed-find-elements"));
    assert.equal(result.current.attempts[0]?.lease.state, "settled");
    assert.equal(readEvidenceRef(result.current.attempts[0]!.evidence_refs[0]!).trust_level, "authoritative_native");
  });
});

test("neighboring typed native reads retain authority independent of result size and alias naming", { concurrency: false }, async () => {
  await workspace(async () => {
    for (const variant of [
      { sessionId: "typed-schedules", tool: "revit_list_schedules", nativePath: "/revit/schedules", args: { action: "list" } },
      { sessionId: "typed-parameters", tool: "revit_get_parameters", nativePath: "/revit/get-parameters", args: { elementIds: [101], names: ["Mark"] } },
      { sessionId: "typed-context", tool: "revit_get_context", nativePath: "/revit/context", nativeMethod: "GET" as const, args: {} }
    ]) {
      const result = await invokeTyped(variant);
      assert.equal(result.current.attempts[0]?.effect.authority, "native_host", variant.tool);
      assert.equal(result.current.attempts[0]?.effect.state, "none", variant.tool);
    }
  });
});

test("unbound typed caller result cannot manufacture native authority", { concurrency: false }, async () => {
  await workspace(async () => {
    const sessionId = "typed-caller-only";
    const { goal } = assignment(sessionId);
    const runtime = { callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ status: "Ok", count: 509 }) }] }) };
    const owner = beginTeammateLoopOwner(runtime, {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: `message:${sessionId}`,
      user_text: "Return the requested inventory from the current Revit model.",
      context: { revit: { source: { live: true }, process_id: 42, document: { title: "Disposable", path: "C:\\Disposable.rvt" } } }
    });
    try {
      await handleCodexServerRequest(runtime as any, {
        id: `request:${sessionId}`,
        method: "item/tool/call",
        params: { namespace: "revit_operator", turnId: `turn:${sessionId}`, callId: `call:${sessionId}`, tool: "revit_find_elements", arguments: { categories: ["OST_DuctTerminal"] } }
      } as any);
      assert.equal(projection(goal.id).attempts[0]?.effect.authority, "admission_policy");
    } finally {
      endTeammateLoopOwner(owner);
    }
  });
});

test("transport binding cannot substitute one concrete native route for another", { concurrency: false }, async () => {
  await workspace(async () => {
    const result = await invokeTyped({
      sessionId: "generic-route-substitution",
      tool: "revit_call_tool",
      nativePath: "/revit/find-elements",
      args: { method: "POST", path: "/revit/schedules", body: { action: "list" } }
    });
    assert.equal(result.current.attempts[0]?.action_path, "/revit/schedules");
    assert.equal(result.current.attempts[0]?.effect.state, "none");
    assert.equal(result.current.attempts[0]?.effect.authority, "admission_policy");
  });
});

test("transport binding does not downgrade a typed apply settlement or replay unknown effect", { concurrency: false }, async () => {
  await workspace(async () => {
    const applied = await invokeTyped({
      sessionId: "typed-apply",
      tool: "revit_set_text_note_text",
      nativePath: "/revit/set-text-note-text",
      args: { elementId: 101, text: "CURRENT", apply: true },
      requestedEffect: "apply",
      resultEffect: "applied",
      resultAuthority: "native_transaction"
    });
    assert.equal(applied.current.attempts[0]?.effect.state, "applied");
    assert.equal(applied.current.attempts[0]?.effect.authority, "native_transaction");

    const unknown = await invokeTyped({
      sessionId: "typed-apply-unknown",
      tool: "revit_set_text_note_text",
      nativePath: "/revit/set-text-note-text",
      args: { elementId: 101, text: "CURRENT", apply: true },
      requestedEffect: "apply",
      resultEffect: "unknown"
    });
    assert.equal(unknown.current.attempts[0]?.effect.state, "unknown");
    assert.equal(unknown.current.unresolved_unknown_attempt_ids.length, 1);
  });
});

test("transport-bound typed parameter preview retains authoritative rollback truth", { concurrency: false }, async () => {
  await workspace(async () => {
    const preview = await invokeTyped({
      sessionId: "typed-parameter-preview",
      tool: "revit_set_parameters",
      nativePath: "/revit/set-parameter",
      args: { changes: [{ elementId: 42, parameterName: "Comments", value: "CURRENT" }], apply: false },
      requestedEffect: "apply",
      nativeRequestedEffect: "preview",
      resultEffect: "none",
      resultAuthority: "native_rollback"
    });

    assert.equal(preview.response.success, true, JSON.stringify(preview.response, null, 2));
    assert.equal(preview.current.attempts.length, 1);
    assert.equal(preview.current.attempts[0]?.requested_effect, "preview");
    assert.equal(preview.current.attempts[0]?.effect.state, "none");
    assert.equal(preview.current.attempts[0]?.effect.authority, "native_rollback");
    assert.equal(preview.current.unresolved_unknown_attempt_ids.length, 0);
    assert.equal(preview.current.apply_opportunity_consumed, false);
  });
});

test("tag-elements exact plain Dry Run remains blocked while proven not-started planning permits a later apply", { concurrency: false }, async () => {
  const fixture = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/tag-elements-dry-run-plain.json'), 'utf8'));
  assert.equal(fixture.payload.transaction, undefined);
  for (const variant of ["retained_plain", "observed_unknown", "not_started", "repair_rolled_back", "committed", "pending", "malformed"] as const) {
    await workspace(async () => {
      const sessionId = `tag-elements-settlement-${variant}`;
      const { goal, run } = assignment(sessionId, "apply");
      let dispatches = 0;
      const apply = variant === "committed";
      const notStarted = variant === "not_started", rolledBack = variant === "repair_rolled_back";
      const effect = apply ? "applied" : notStarted || rolledBack ? "none" : "unknown";
      const authority = rolledBack ? "native_rollback" : apply || notStarted ? "native_transaction" : "native_host";
      const firstSettlement = {
        ...nativeSettlement({ assignmentId: goal.id, runId: run.runId, generation: run.generation,
          nativeAttemptId: `native:${sessionId}`, path: fixture.input.path,
          effect, authority, requestedEffect: apply ? "apply" : "preview" }),
        effect_reason: notStarted ? "native_transaction_not_started" : rolledBack ? "verified_native_rollback"
          : apply ? "native_transaction_committed" : "native_handler_returned_without_authoritative_settlement",
        ...(variant === "malformed" ? { effect_state: "unrecognized" } : {})
      };
      const firstPayload = {
        ...structuredClone(fixture.payload),
        ...(notStarted ? { previewExecuted: false, applied: false, transaction: { status: "not_started", committed: false, affected_element_ids: [] } } : {}),
        ...(rolledBack ? { previewExecuted: true, applied: false, transaction: { status: "rolled_back", committed: false, affected_element_ids: [] } } : {}),
        ...(apply ? { status: "Success", dryRun: false, applied: true, tagIds: [10101], transaction: { status: "committed", committed: true, affected_element_ids: [10101] } } : {}),
        ...(variant === "pending" ? { transaction: { status: "pending", committed: null, affected_element_ids: [] } } : {}),
        ...(variant === "retained_plain" ? {} : { canonical_attempt_settlement: firstSettlement })
      };
      const runtime = { callTool: async () => {
        dispatches++;
        const payload = dispatches === 1 ? firstPayload : {
          status: "Success", dryRun: false, tagIds: [10101], transaction: { status: "committed", committed: true, affected_element_ids: [10101] },
          canonical_attempt_settlement: nativeSettlement({ assignmentId: goal.id, runId: run.runId, generation: run.generation,
            nativeAttemptId: `native:${sessionId}:apply`, path: fixture.input.path, effect: "applied", authority: "native_transaction", requestedEffect: "apply" })
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      } };
      const owner = beginTeammateLoopOwner(runtime, {
        version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: sessionId, message_id: `message:${sessionId}`,
        user_text: "Add the drawing's duct size labels to the existing draft.",
        context: { revit: { source: { live: true }, process_id: 42, document: { title: "Disposable", path: "C:\\Disposable.rvt" } } }
      });
      const invoke = (name: string, dryRun: boolean) => handleCodexServerRequest(runtime as any, {
        id: `request:${sessionId}:${name}`, method: "item/tool/call", params: {
          namespace: "revit_operator", turnId: `turn:${sessionId}`, callId: `call:${sessionId}:${name}`, tool: "revit_call_tool",
          arguments: { ...fixture.input, body: { ...fixture.input.body, dryRun } }
        }
      } as any) as Promise<any>;
      try {
        const first = await invoke("first", !apply);
        const current = projection(goal.id);
        assert.equal(dispatches, 1, variant);
        assert.equal(current.attempts[0]?.effect.state, effect, JSON.stringify({ variant, first, current }));
        assert.equal(current.unresolved_unknown_attempt_ids.length, effect === "unknown" ? 1 : 0, variant);
        if (variant !== "retained_plain" && variant !== "malformed") assert.equal(current.attempts[0]?.effect.authority, authority, variant);
        if (!apply) {
          assert.equal(current.apply_opportunity_consumed, false, variant);
          const followup = await invoke("apply", false);
          assert.equal(dispatches, effect === "none" ? 2 : 1, JSON.stringify({ variant, followup, current: projection(goal.id) }));
          if (effect === "none") {
            assert.equal(projection(goal.id).attempts.at(-1)?.effect.state, "applied", variant);
            assert.equal(projection(goal.id).unresolved_unknown_attempt_ids.length, 0, variant);
          } else {
            assert.equal(followup.success, false, variant);
            assert.match(JSON.stringify(followup), /assignment_settlement_blocked/, variant);
            assert.equal(projection(goal.id).unresolved_unknown_attempt_ids.length, 1, variant);
          }
        }
      } finally {
        endTeammateLoopOwner(owner);
      }
    });
  }
});

test("change-type captured hosting failure needs native rollback authority before continuation", { concurrency: false }, async () => {
  const mcpModule = new URL(import.meta.url.endsWith(".ts")
    ? "../../mcp-server/src/lib/assignmentKernelV2.ts"
    : "../../../mcp-server/dist/lib/assignmentKernelV2.js", import.meta.url);
  const mcp = await import(mcpModule.href);
  const { createAssignmentKernelForGoalV2 } = await import("../src/assignments/assignment_kernel_v2_factory.js");
  const { getAssignmentKernelSnapshotV2 } = await import("../src/assignments/assignment_kernel_v2_store.js");
  const { openAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2, settleAssignmentKernelOperationV2 } = await import("../src/assignments/assignment_kernel_v2_execution.js");
  const { runWithRequestContext } = await import("../src/request_context.js");
  const { createOperatorBackendAuth } = await import("../src/operator_backend_auth.js");
  const fixture = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/change-type-host-modal-42.json'), 'utf8'));
  const local = { operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only", { OPERATOR_API_BASE_URL: "http://127.0.0.1:7007" }) };
  // The original run42 remains unknown. These are new native-boundary replays,
  // including neighbors that must not acquire rollback truth from an error flag.
  for (const variant of ["rolled_back", "pending", "capture_only"] as const) {
    await workspace(async () => {
      const sessionId = `change-type-host-v2-${variant}`;
      const oldMode = process.env.REVIT_OPERATOR_MODE, oldSessions = process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS;
      process.env.REVIT_OPERATOR_MODE = "local";
      process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS = sessionId;
      try {
        await runWithRequestContext(local, async () => {
          const goal = createGoal({ title: "Pick up electrical redlines", objective: "Complete source-supported symbol changes.",
            acceptance_criteria: ["Symbols match the marked drawing."], status: "active", related_session_id: sessionId,
            work_budget: { requested_effect: "apply", document_fingerprint: "disposable-host-fixture" } });
          const { kernel_version: _version, ...binding } = createAssignmentKernelForGoalV2({ goal, run_id: `run:${sessionId}` });
          const state = () => getAssignmentKernelSnapshotV2(goal.id)!;
          const open = (id: string, newTypeId: number = fixture.request.newTypeId) => openAssignmentKernelOperationV2({ snapshot: state(), provider_turn_id: "turn",
            controller_request_id: id, capability_id: "revit_call_tool", classified_effect: "apply",
            target_tokens: fixture.request.elementIds.map((id: number) => `id:${id}`), arguments: { method: "POST", path: fixture.path, body: { ...fixture.request, newTypeId } } });
          const lease = open("change-hosted-symbols");
          markAssignmentKernelOperationDispatchStartedV2(lease);
          const rolledBack = variant === "rolled_back";
          const payload = { success: false, ok: false, status: "Blocked", dryRun: false, count: 0, changedElementIds: [],
            failureRollbackRequested: true,
            capturedFailures: [{ severity: "Error", message: fixture.native_failure, elementIds: fixture.request.elementIds }],
            ...(variant === "capture_only" ? {} : {
              transaction: { status: rolledBack ? "rolled_back" : "pending", committed: rolledBack ? false : null, affected_element_ids: [] }
            }),
            canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "apply",
              effect_state: rolledBack ? "none" : "unknown", effect_authority: rolledBack ? "native_rollback" : "native_host",
              effect_reason: rolledBack ? "verified_native_rollback" : variant === "pending" ? "native_transaction_pending"
                : "native_handler_returned_without_authoritative_settlement", request_dispatched: true } };
          const envelope = await mcp.runWithAssignmentKernelV2({ [mcp.ASSIGNMENT_KERNEL_V2_META_KEY]: lease }, async () => {
            const request = await mcp.beginAssignmentKernelNativeRequestV2("POST", fixture.path, fixture.request, { classified_effect: "apply" });
            await mcp.markAssignmentKernelNativeRequestDispatchingV2(request);
            await mcp.recordAssignmentKernelNativeResultV2("POST", fixture.path, payload, request);
            return mcp.decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool");
          });
          const settled = settleAssignmentKernelOperationV2(lease, envelope);
          assert.equal(settled.result.persistent_effect, rolledBack ? "none" : "unknown", variant);
          assert.equal(state().unresolved_unknown_operation_ids.length, rolledBack ? 0 : 1, variant);
          assert.deepEqual(state().current_binding, binding);
          if (rolledBack) {
            assert.equal(open("different-safe-symbol-change", 1429111).requested_effect, "apply");
          } else {
            const before = state();
            assert.throws(() => open("different-safe-symbol-change", 1429111), /unknown_effect_requires_reconciliation/);
            assert.deepEqual(state(), before);
          }
        });
      } finally {
        if (oldMode === undefined) delete process.env.REVIT_OPERATOR_MODE; else process.env.REVIT_OPERATOR_MODE = oldMode;
        if (oldSessions === undefined) delete process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS; else process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS = oldSessions;
      }
    });
  }
});

test("tag-elements actual MCP V2 envelope preserves advisory operation admission after preview settlement", { concurrency: false }, async () => {
  // Source-mode checks execute source on both sides; compiled frontiers use the matching built MCP module.
  const mcpModule = new URL(import.meta.url.endsWith(".ts")
    ? "../../mcp-server/src/lib/assignmentKernelV2.ts"
    : "../../../mcp-server/dist/lib/assignmentKernelV2.js", import.meta.url);
  const mcp = await import(mcpModule.href);
  const { createAssignmentKernelForGoalV2 } = await import("../src/assignments/assignment_kernel_v2_factory.js");
  const { getAssignmentKernelSnapshotV2 } = await import("../src/assignments/assignment_kernel_v2_store.js");
  const { openAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2, settleAssignmentKernelOperationV2 } = await import("../src/assignments/assignment_kernel_v2_execution.js");
  const { runWithRequestContext } = await import("../src/request_context.js");
  const { createOperatorBackendAuth } = await import("../src/operator_backend_auth.js");
  const fixture = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/tag-elements-dry-run-plain.json'), 'utf8'));
  const local = { operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only", { OPERATOR_API_BASE_URL: "http://127.0.0.1:7007" }) };
  for (const variant of ["retained_plain", "not_started", "pending"] as const) {
    await workspace(async () => {
      const sessionId = `tag-elements-v2-${variant}`;
      const oldMode = process.env.REVIT_OPERATOR_MODE, oldSessions = process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS;
      process.env.REVIT_OPERATOR_MODE = "local";
      process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS = sessionId;
      try {
        await runWithRequestContext(local, async () => {
          const goal = createGoal({ title: "Add source duct labels", objective: "Finish the existing draft's source-supported duct labels.",
            acceptance_criteria: ["Source-supported duct labels are readable."], status: "active", related_session_id: sessionId,
            work_budget: { requested_effect: "apply", document_fingerprint: "disposable-tag-fixture" } });
          const { kernel_version: _version, ...binding } = createAssignmentKernelForGoalV2({ goal, run_id: `run:${sessionId}` });
          const state = () => getAssignmentKernelSnapshotV2(goal.id)!;
          assert.equal(state().spec.execution_policy?.mode, "local_advisory_v1");
          const open = (id: string, dryRun: boolean) => openAssignmentKernelOperationV2({ snapshot: state(),
            provider_turn_id: "turn", controller_request_id: id, capability_id: "revit_call_tool", classified_effect: dryRun ? "preview" : "apply",
            target_tokens: fixture.input.body.elementIds.map((id: number) => `id:${id}`), arguments: { ...fixture.input, body: { ...fixture.input.body, dryRun } } });
          const lease = open("plan-tags", true);
          markAssignmentKernelOperationDispatchStartedV2(lease);
          const notStarted = variant === "not_started";
          const payload = { ...structuredClone(fixture.payload),
            ...(notStarted ? { previewExecuted: false, applied: false, transaction: { status: "not_started", committed: false, affected_element_ids: [] } } : {}),
            ...(variant === "pending" ? { transaction: { status: "pending", committed: null, affected_element_ids: [] } } : {}),
            canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "preview",
              effect_state: notStarted ? "none" : "unknown", effect_authority: notStarted ? "native_transaction" : "native_host",
              effect_reason: notStarted ? "native_transaction_not_started" : "native_handler_returned_without_authoritative_settlement", request_dispatched: true }
          };
          const envelope = await mcp.runWithAssignmentKernelV2({ [mcp.ASSIGNMENT_KERNEL_V2_META_KEY]: lease }, async () => {
            const request = await mcp.beginAssignmentKernelNativeRequestV2("POST", fixture.input.path, fixture.input.body, { classified_effect: "preview" });
            await mcp.markAssignmentKernelNativeRequestDispatchingV2(request);
            await mcp.recordAssignmentKernelNativeResultV2("POST", fixture.input.path, payload, request);
            return mcp.decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool");
          });
          const settled = settleAssignmentKernelOperationV2(lease, envelope);
          assert.equal(settled.result.persistent_effect, notStarted ? "none" : "unknown");
          assert.equal(state().unresolved_unknown_operation_ids.length, notStarted ? 0 : 1);
          assert.deepEqual(state().current_binding, binding);
          if (notStarted) {
            const subsequent = open("apply-tags", false);
            assert.equal(subsequent.requested_effect, "apply");
            assert.deepEqual(subsequent.binding, binding);
          } else {
            const before = state();
            assert.throws(() => open("apply-tags", false), /unknown_effect_requires_reconciliation/);
            assert.deepEqual(state(), before);
          }
        });
      } finally {
        if (oldMode === undefined) delete process.env.REVIT_OPERATOR_MODE; else process.env.REVIT_OPERATOR_MODE = oldMode;
        if (oldSessions === undefined) delete process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS; else process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS = oldSessions;
      }
    });
  }
});
