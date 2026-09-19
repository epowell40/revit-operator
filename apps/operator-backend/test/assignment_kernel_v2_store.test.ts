import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ASSIGNMENT_EVENT_V2_SCHEMA,
  ASSIGNMENT_SPEC_V2_SCHEMA,
  type AssignmentBindingV2,
  type AssignmentEventV2,
  type AssignmentSpecV2
} from "../src/domain/assignment-kernel/index.js";
import {
  appendAssignmentKernelEventV2,
  createAssignmentKernelV2,
  getAssignmentKernelSnapshotV2,
  listAssignmentKernelIndexV2
} from "../src/assignments/assignment_kernel_v2_store.js";
import { assignmentSpecFromGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { startExternalAssignmentRun } from "../src/assignments/external_assignment_start.js";
import { __testOnlyResetGoalListCache, createGoal, getGoal, mutateGoalRecord } from "../src/goals/service.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { runWithRequestContext } from "../src/request_context.js";

function workspace(fn: () => void): void {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-kernel-v2-store-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  try { fn(); }
  finally {
    __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function fixture() {
  const goal = createGoal({
    title: "Inventory selected elements",
    objective: "Return the requested inventory.",
    acceptance_criteria: ["The requested inventory is authoritatively returned."],
    status: "active",
    related_session_id: "session-v2",
    created_by: "principal-v2"
  });
  const binding: AssignmentBindingV2 = {
    assignment_id: goal.id,
    run_id: "run-v2",
    generation: 1,
    session_id: "session-v2",
    principal_id: "principal-v2",
    document_fingerprint: "document-v2"
  };
  const spec: AssignmentSpecV2 = {
    schema: ASSIGNMENT_SPEC_V2_SCHEMA,
    binding,
    source_user_request: goal.objective,
    requested_effect: "read",
    criteria: [{
      criterion_id: "criterion-result",
      requirement: goal.acceptance_criteria[0]!,
      required: true,
      semantic_fact_requirements: ["inventory.total"],
      accepted_evaluator_authority_ids: ["deterministic-runtime"],
      accepted_observation_authority_ids: ["native-host"]
    }],
    input_variables: [],
    work_units: [{
      work_unit_id: "work-result",
      requested_effect: "read",
      execution_class: "analysis",
      dependency_ids: [],
      criterion_ids: ["criterion-result"],
      input_variable_ids: [],
      independently_useful: true,
      safe_to_retain: true,
      rollback_scope: "none"
    }],
    authorization_policy_id: "read-policy",
    created_at: "2026-08-26T14:00:00.000Z"
  };
  createAssignmentKernelV2(goal.id, spec, "test");
  return { goal, binding, spec };
}

type EventBodyV2<T> = T extends unknown
  ? Omit<T, "schema" | "event_id" | "assignment_id" | "assignment_version" | "binding" | "occurred_at" | "actor">
  : never;

function event(
  goalId: string,
  binding: AssignmentBindingV2,
  version: number,
  body: EventBodyV2<AssignmentEventV2>
): AssignmentEventV2 {
  return {
    schema: ASSIGNMENT_EVENT_V2_SCHEMA,
    event_id: `event-${version}`,
    assignment_id: goalId,
    assignment_version: version,
    binding,
    occurred_at: `2026-08-26T14:00:${String(version).padStart(2, "0")}.000Z`,
    actor: "test",
    ...body
  } as AssignmentEventV2;
}

test("V2 journal persists in the existing Goal and reconstructs the same snapshot after restart", () => workspace(() => {
  const { goal, binding } = fixture();
  appendAssignmentKernelEventV2(goal.id, event(goal.id, binding, 2, {
    event_type: "work_unit_state_changed",
    work_unit_id: "work-result",
    state: "active",
    reason: "Execution started."
  }));
  const before = getAssignmentKernelSnapshotV2(goal.id)!;
  __testOnlyResetGoalListCache();
  const after = getAssignmentKernelSnapshotV2(goal.id)!;
  assert.deepEqual(after, before);
  assert.equal(after.assignment_version, 2);
  assert.equal(getGoal(goal.id)!.assignment_control_plane!.events.length, 0, "V2 must not dual-write V1 truth");
}));

test("duplicate event delivery is idempotent and conflicting or stale events are quarantined", () => workspace(() => {
  const { goal, binding } = fixture();
  const activation = event(goal.id, binding, 2, {
    event_type: "work_unit_state_changed",
    work_unit_id: "work-result",
    state: "active",
    reason: "Execution started."
  });
  assert.equal(appendAssignmentKernelEventV2(goal.id, activation).accepted, true);
  assert.equal(appendAssignmentKernelEventV2(goal.id, activation).accepted, true);
  const conflicting = { ...activation, actor: "foreign-controller" };
  const conflict = appendAssignmentKernelEventV2(goal.id, conflicting);
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.quarantined_reason_code, "assignment_event_id_conflict");
  const staleBinding = { ...binding, generation: 0 };
  const stale = appendAssignmentKernelEventV2(goal.id, event(goal.id, staleBinding, 3, { event_type: "run_started" }));
  assert.equal(stale.accepted, false);
  assert.match(stale.quarantined_reason_code ?? "", /generation|binding|run_not_superseded/);
  assert.equal(getGoal(goal.id)!.assignment_kernel_v2!.events.length, 2);
  assert.equal(getGoal(goal.id)!.assignment_kernel_v2!.quarantined_events.length, 2);
}));

test("canonical V2 terminal settlement synchronizes Goal lifecycle exactly once", () => workspace(() => {
  const { goal, binding } = fixture();
  appendAssignmentKernelEventV2(goal.id, event(goal.id, binding, 2, {
    event_type: "work_unit_state_changed",
    work_unit_id: "work-result",
    state: "blocked",
    reason: "Fixture is unavailable."
  }));
  appendAssignmentKernelEventV2(goal.id, event(goal.id, binding, 3, {
    event_type: "criterion_evaluated",
    evaluation: {
      criterion_id: "criterion-result",
      status: "failed",
      basis: "policy",
      supporting_operation_ids: [],
      supporting_facts: [],
      evaluator_authority: "deterministic-runtime",
      reason: "Fixture is unavailable.",
      evaluated_at: "2026-08-26T14:00:03.000Z"
    }
  }));
  const outcome = appendAssignmentKernelEventV2(goal.id, event(goal.id, binding, 4, {
    event_type: "outcome_derived",
    outcome: "blocked",
    reason: "fixture_unavailable"
  }));
  assert.equal(outcome.goal.status, "active", "derived outcome is not terminal settlement");
  const terminalEvent = event(goal.id, binding, 5, {
    event_type: "assignment_terminal",
    outcome: "blocked",
    reason: "fixture_unavailable"
  });
  const terminal = appendAssignmentKernelEventV2(goal.id, terminalEvent);
  assert.equal(terminal.goal.status, "blocked");
  assert.equal(terminal.goal.current_phase, "settled");
  assert.equal(terminal.goal.finished_at, terminalEvent.occurred_at);
  assert.equal(terminal.snapshot.terminal, true);

  const late = appendAssignmentKernelEventV2(goal.id, event(goal.id, binding, 6, {
    event_type: "work_unit_state_changed",
    work_unit_id: "work-result",
    state: "active",
    reason: "late callback"
  }));
  assert.equal(late.accepted, false);
  assert.match(late.quarantined_reason_code ?? "", /terminal/);
  assert.equal(getGoal(goal.id)!.status, "blocked");
  assert.equal(getGoal(goal.id)!.finished_at, terminalEvent.occurred_at);
}));

test("a V2 assignment cannot bind to a different Goal identity", () => workspace(() => {
  const goal = createGoal({
    title: "Read model",
    objective: "Read model state.",
    acceptance_criteria: ["State is returned."],
    status: "active"
  });
  const { spec } = fixture();
  assert.throws(() => createAssignmentKernelV2(goal.id, spec), /spec_goal_mismatch/);
}));

test("trusted external Assignment start writes exactly one V2 journal when the feature is enabled", () => workspace(() => {
  const previous = process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
  process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
  try {
    const goal = createGoal({
      title: "Inspect selected elements",
      objective: "Return the selected-element inventory.",
      acceptance_criteria: ["The inventory is authoritatively returned."],
      status: "active",
      related_session_id: "session-external-v2",
      created_by: "principal-external-v2",
      work_budget: { requested_effect: "read" }
    });
    const binding = startExternalAssignmentRun({
      goal,
      sessionId: "session-external-v2",
      requestedRunId: "external-v2-run",
      actor: "sidecar"
    });
    const stored = getGoal(goal.id)!;
    assert.deepEqual(binding, {
      assignmentId: goal.id,
      runId: "external-v2-run",
      generation: 1,
      kernelVersion: 2
    });
    assert.equal(stored.assignment_kernel_v2?.events.length, 1);
    assert.equal(stored.assignment_control_plane?.events.length ?? 0, 0, "V2 external start must not dual-write V1 truth");
    assert.equal(getAssignmentKernelSnapshotV2(goal.id)?.assignment_version, 1);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
    else process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = previous;
  }
}));

test("authenticated local shared-token Assignment start receives a trusted V2 principal binding", () => workspace(() => {
  const previous = process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
  process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
  try {
    runWithRequestContext({
      operator_backend_auth: createOperatorBackendAuth("shared_token", "local-assignment-test-token")
    }, () => {
      const goal = createGoal({
        title: "Inspect the local model",
        objective: "Return the requested local inventory.",
        acceptance_criteria: ["The local inventory is authoritatively returned."],
        status: "active",
        related_session_id: "session-local-v2",
        created_by: null,
        work_budget: { requested_effect: "read" }
      });
      const binding = startExternalAssignmentRun({
        goal,
        sessionId: "session-local-v2",
        requestedRunId: "local-v2-run",
        actor: "sidecar"
      });
      const snapshot = getAssignmentKernelSnapshotV2(goal.id);
      assert.equal(binding.kernelVersion, 2);
      assert.equal(snapshot?.current_binding.principal_id, "local:shared-token");
      assert.equal(getGoal(goal.id)?.assignment_control_plane?.events.length ?? 0, 0);
    });
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
    else process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = previous;
  }
}));

test("trusted external Assignment start preserves the legacy path when V2 is disabled", () => workspace(() => {
  const previous = process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
  delete process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
  try {
    const goal = createGoal({
      title: "Inspect selected elements",
      objective: "Return the selected-element inventory.",
      acceptance_criteria: ["The inventory is authoritatively returned."],
      status: "active",
      related_session_id: "session-external-v1",
      created_by: "principal-external-v1",
      work_budget: { requested_effect: "read" }
    });
    const binding = startExternalAssignmentRun({
      goal,
      sessionId: "session-external-v1",
      requestedRunId: "external-v1-run",
      actor: "sidecar"
    });
    const stored = getGoal(goal.id)!;
    assert.equal(binding.kernelVersion, 1);
    assert.equal(binding.assignmentId, goal.id);
    assert.equal(binding.runId, "external-v1-run");
    assert.equal(stored.assignment_kernel_v2, undefined);
    assert.ok((stored.assignment_control_plane?.events.length ?? 0) > 0);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
    else process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = previous;
  }
}));

test("trusted AssignmentSpec creation gives opaque mutations one stable input variable without guessing its value", () => workspace(() => {
  const previous = process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
  process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
  try {
    const opaque = createGoal({
      title: "Update selected note",
      objective: "Replace the outdated selected note with the current issue wording without creating a duplicate.",
      acceptance_criteria: ["The selected note is updated in place."],
      status: "active",
      related_session_id: "session-input-v2",
      created_by: "principal-input-v2",
      work_budget: { requested_effect: "apply" }
    });
    startExternalAssignmentRun({ goal: opaque, sessionId: "session-input-v2", requestedRunId: "run-input-v2", actor: "sidecar" });
    const opaqueSnapshot = getAssignmentKernelSnapshotV2(opaque.id)!;
    assert.deepEqual(opaqueSnapshot.spec.input_variables.map(value => value.variable_id), ["replacement_text"]);
    assert.deepEqual(opaqueSnapshot.pending_input_variable_ids, ["replacement_text"]);
    assert.equal(opaqueSnapshot.outcome, "awaiting_user_input");

    const specified = createGoal({
      title: "Update selected note",
      objective: "Replace the selected note text with the exact literal 'Issued for Construction'.",
      acceptance_criteria: ["The selected note is updated in place."],
      status: "active",
      related_session_id: "session-specified-v2",
      created_by: "principal-specified-v2",
      work_budget: { requested_effect: "apply" }
    });
    startExternalAssignmentRun({ goal: specified, sessionId: "session-specified-v2", requestedRunId: "run-specified-v2", actor: "sidecar" });
    assert.deepEqual(getAssignmentKernelSnapshotV2(specified.id)!.pending_input_variable_ids, []);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
    else process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = previous;
  }
}));

test("long persisted audit appends after restart with bounded replay work and still quarantines stale events", () => workspace(() => {
  const { goal, binding } = fixture();
  mutateGoalRecord(goal.id, current => {
    const record = current.assignment_kernel_v2 as any;
    for (let i = 2; i <= 180; i++) record.events.push(event(goal.id, binding, i, {
      event_type: "work_unit_state_changed", work_unit_id: "work-result", state: i % 2 ? "active" : "pending", reason: "Audit progress"
    }));
    return current;
  });
  __testOnlyResetGoalListCache();
  const clone = globalThis.structuredClone; let clones = 0;
  try {
    globalThis.structuredClone = ((value: unknown, options?: Parameters<typeof structuredClone>[1]) => { clones++; return clone(value, options); }) as typeof structuredClone;
    const result = appendAssignmentKernelEventV2(goal.id, event(goal.id, binding, 181, {
      event_type: "work_unit_state_changed", work_unit_id: "work-result", state: "active", reason: "Next audit section"
    }));
    assert.equal(result.accepted, true); assert.equal(result.snapshot.assignment_version, 181);
  } finally { globalThis.structuredClone = clone; }
  assert.ok(clones < 180 * 20, `one durable append must not replay every prefix (${clones} clones)`);
  const before = getAssignmentKernelSnapshotV2(goal.id);
  const rejected = appendAssignmentKernelEventV2(goal.id, { ...event(goal.id, binding, 182, {
    event_type: "work_unit_state_changed", work_unit_id: "work-result", state: "pending", reason: "Stale caller"
  }), binding: { ...binding, generation: 2 } });
  assert.equal(rejected.accepted, false); assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id), before);
  __testOnlyResetGoalListCache(); assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id), before);
}));

test("V2 session discovery survives a fresh process with a missing or stale independent index", () => workspace(() => {
  const { goal, binding } = fixture();
  const root = process.env.OPERATOR_WORKSPACE_ROOT!;
  const indexRoot = path.join(root, "artifacts", "assignment-kernel-v2", "index");
  const indexPath = path.join(indexRoot, fs.readdirSync(indexRoot)[0]!);
  const stale = fs.readFileSync(indexPath, "utf8");
  appendAssignmentKernelEventV2(goal.id, event(goal.id, binding, 2, {
    event_type: "work_unit_state_changed", work_unit_id: "work-result", state: "active", reason: "Started."
  }));
  const expected = listAssignmentKernelIndexV2(binding.session_id);
  assert.equal(expected[0]!.assignment_version, 2);
  const moduleUrl = new URL("../src/assignments/assignment_kernel_v2_store.js", import.meta.url).href;
  for (const brokenIndex of [null, stale, "{broken", JSON.stringify({ ...JSON.parse(stale), session_id: "another-session" })]) {
    if (brokenIndex === null) fs.unlinkSync(indexPath);
    else fs.writeFileSync(indexPath, brokenIndex);
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { listAssignmentKernelIndexV2, getAssignmentKernelSnapshotV2 } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify({ index: listAssignmentKernelIndexV2(${JSON.stringify(binding.session_id)}),
        version: getAssignmentKernelSnapshotV2(${JSON.stringify(goal.id)}).assignment_version }));
    `], { env: process.env, encoding: "utf8", timeout: 20_000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.deepEqual(JSON.parse(child.stdout), { index: expected, version: 2 });
  }
}));

test("V2 session discovery filters before the history limit and excludes unrelated Goals", () => workspace(() => {
  const { goal, binding } = fixture();
  for (let i = 0; i < 205; i += 1) createGoal({
    title: `Unrelated ${i}`, objective: "Unrelated task", acceptance_criteria: ["Done"],
    status: "active", related_session_id: "another-session", created_by: "another-principal"
  });
  assert.deepEqual(listAssignmentKernelIndexV2(binding.session_id, 1).map(entry => entry.assignment_id), [goal.id]);
  assert.deepEqual(listAssignmentKernelIndexV2("another-session"), []);
}));

test("trusted AssignmentSpec creation gives opaque executable previews the same authenticated input gap", () => workspace(() => {
  const preview = createGoal({
    title: "Preview selected note replacement",
    objective: "Find one project TextNote, report its exact identity, and preview a conditional text replacement that would not create a duplicate. Do not apply it.",
    acceptance_criteria: ["The requested preview is authoritatively returned."],
    status: "active",
    related_session_id: "session-preview-input-v2",
    created_by: "principal-preview-input-v2",
    work_budget: { requested_effect: "preview" }
  });
  const previewSpec = assignmentSpecFromGoalV2({ goal: preview, run_id: "run-preview-input-v2" });
  assert.deepEqual(previewSpec.input_variables.map(value => value.variable_id), ["replacement_text"]);
  assert.deepEqual(previewSpec.criteria[0]?.semantic_fact_requirements, ["task.preview_valid"]);

  const read = createGoal({
    title: "Explain note replacement",
    objective: "Explain how a conditional text replacement preview works without executing it.",
    acceptance_criteria: ["The explanation is returned."],
    status: "active",
    related_session_id: "session-read-input-v2",
    created_by: "principal-read-input-v2",
    work_budget: { requested_effect: "read" }
  });
  const readSpec = assignmentSpecFromGoalV2({ goal: read, run_id: "run-read-input-v2" });
  assert.deepEqual(readSpec.input_variables, []);
}));

test("multiple V2 criteria require an explicit semantic-fact contract instead of sharing one generic success fact", () => workspace(() => {
  const base = {
    title: "Update selected element",
    objective: "Update and verify the selected element.",
    acceptance_criteria: ["The requested state is applied.", "The exact target is verified."],
    status: "active" as const,
    related_session_id: "session-criteria-v2",
    created_by: "principal-criteria-v2"
  };
  const unbound = createGoal({ ...base, work_budget: { requested_effect: "apply" } });
  assert.throws(() => assignmentSpecFromGoalV2({ goal: unbound, run_id: "run-criteria-unbound" }), /criterion_fact_contract_required/);

  const bound = createGoal({
    ...base,
    related_session_id: "session-criteria-bound-v2",
    work_budget: {
      requested_effect: "apply",
      assignment_kernel_v2_criteria: [
        { requirement: base.acceptance_criteria[0], semantic_fact_requirements: ["result.available"] },
        { requirement: base.acceptance_criteria[1], semantic_fact_requirements: ["result.payload_hash"] }
      ]
    }
  });
  const spec = assignmentSpecFromGoalV2({ goal: bound, run_id: "run-criteria-bound" });
  assert.deepEqual(spec.criteria.map(criterion => criterion.semantic_fact_requirements), [
    ["task.result_available"], ["result.payload_hash"]
  ]);
}));

test("content-verified snapshot reads avoid replay while changed bytes and invalid history remain authoritative", () => workspace(() => {
  const { goal, binding } = fixture();
  const outcome = getAssignmentKernelSnapshotV2(goal.id)!.outcome;
  for (let version = 2; version <= 38; version++) {
    appendAssignmentKernelEventV2(goal.id, event(goal.id, binding, version, { event_type: "outcome_derived", outcome, reason: "Retained history for snapshot replay." }));
  }
  const before = getAssignmentKernelSnapshotV2(goal.id)!;
  const clone = globalThis.structuredClone;
  let clones = 0;
  globalThis.structuredClone = ((value: unknown, options?: Parameters<typeof structuredClone>[1]) => {
    clones++;
    return clone(value, options);
  }) as typeof structuredClone;
  let warm;
  try { warm = getAssignmentKernelSnapshotV2(goal.id)!; }
  finally { globalThis.structuredClone = clone; }
  assert.deepEqual(warm, before);
  assert.ok(clones <= 4, `Warm snapshot replayed retained history (${clones} clones).`);
  warm.spec.source_user_request = "Caller mutation";
  assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id), before);

  const file = path.join(process.env.OPERATOR_WORKSPACE_ROOT!, "artifacts", "goals", goal.id, "goal.json");
  const bytes = fs.readFileSync(file, "utf8");
  const stamp = fs.statSync(file);
  const persisted = JSON.parse(bytes);
  persisted.assignment_kernel_v2.events[0].spec.source_user_request = "Return the different inventory.";
  const changed = JSON.stringify(persisted) + "\n";
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(bytes));
  fs.writeFileSync(file, changed);
  fs.utimesSync(file, stamp.atime, stamp.mtime);
  assert.equal(getAssignmentKernelSnapshotV2(goal.id)!.spec.source_user_request, "Return the different inventory.");

  persisted.assignment_kernel_v2.events.at(-1).assignment_version = 99;
  fs.writeFileSync(file, JSON.stringify(persisted, null, 2) + "\n");
  fs.utimesSync(file, stamp.atime, stamp.mtime);
  assert.throws(() => getAssignmentKernelSnapshotV2(goal.id), /version/i,
    "Semantic rejection cannot fall back to the valid previous file or prior cached snapshot.");
}));


test('journal append cache rejects same-size timestamp-restored history edits and survives failed atomic commit',()=>workspace(()=>{
 const {goal,binding}=fixture();
 const activation=event(goal.id,binding,2,{event_type:'work_unit_state_changed',work_unit_id:'work-result',state:'active',reason:'Start'});
 const file=path.join(process.env.OPERATOR_WORKSPACE_ROOT!,'artifacts','goals',goal.id,'goal.json');
 const original=fs.readFileSync(file,'utf8');
 const rename=fs.renameSync;
 try{fs.renameSync=((from:any,to:any)=>{if(String(to)===file)throw new Error('injected disk failure');return rename(from,to);}) as typeof fs.renameSync;
  assert.throws(()=>appendAssignmentKernelEventV2(goal.id,activation),/injected disk failure/);
 }finally{fs.renameSync=rename;}
 assert.equal(fs.readFileSync(file,'utf8'),original);
 assert.equal(getAssignmentKernelSnapshotV2(goal.id)!.assignment_version,1);
 assert.equal(appendAssignmentKernelEventV2(goal.id,activation).accepted,true);
 const prior=fs.readFileSync(file,'utf8'),stamp=fs.statSync(file),changed=JSON.parse(prior);
 changed.assignment_kernel_v2.events[0].spec.source_user_request='Return the different inventory.';
 const bytes=JSON.stringify(changed)+'\n';assert.equal(Buffer.byteLength(bytes),Buffer.byteLength(prior));
 fs.writeFileSync(file,bytes);fs.utimesSync(file,stamp.atime,stamp.mtime);
 const next=event(goal.id,binding,3,{event_type:'work_unit_state_changed',work_unit_id:'work-result',state:'pending',reason:'Continue'});
 assert.equal(appendAssignmentKernelEventV2(goal.id,next).snapshot.spec.source_user_request,'Return the different inventory.');
 const retained=JSON.parse(fs.readFileSync(file,'utf8'));retained.assignment_kernel_v2.events[1].assignment_version=9;
 fs.writeFileSync(file,JSON.stringify(retained));
 assert.throws(()=>appendAssignmentKernelEventV2(goal.id,event(goal.id,binding,4,{event_type:'work_unit_state_changed',work_unit_id:'work-result',state:'active',reason:'Rejected'})),/version/i);
}));
