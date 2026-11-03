import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { AssignmentJournalV2, type AssignmentEventV2, type AssignmentSnapshotV2, type OperationV2,
  type OperationResultV2, type ObservationV2, type AssignmentSpecV2 } from "../src/domain/assignment-kernel/index.js";
import { buildHostProgressEpochV2 } from "../src/assignments/supporting_discovery_progress.js";
import { deriveProgressGapsV2, decideAssignmentProgressV2,assignmentNativeReadbackResourceBlockerV2 } from "../src/domain/assignment-kernel/progress/controller.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "../src/domain/assignment-kernel/outcome.js";
import { nativeCommitProgressIdentityV2 } from '../src/domain/assignment-kernel/progress/native_work_progress.js';

type Stage = { operation: OperationV2; result: OperationResultV2; observation: ObservationV2 };
const fixture = JSON.parse(fs.readFileSync("test/fixtures/native-progress-repaired-thin.json", "utf8")) as {
  spec: AssignmentSpecV2; declaration: unknown; stages: Stage[]; prelude: AssignmentEventV2[];
};

function savedCheckpoint(snapshot:AssignmentSnapshotV2,id='checkpoint-save') {
 const source=Object.values(snapshot.operations).find(o=>o.requested_effect==='apply'&&o.result?.native_transaction_state==='committed')!;
 const output='C:/fixture/authorized-result.rvt',identity={session_id:'native-fixture',project_fingerprint:snapshot.current_binding.document_fingerprint!,path:output};
 const op:OperationV2={...structuredClone(source),operation_id:id,input:{method:'POST',path:'/revit/save-as',body:{filePath:output,overwrite:true}},
  request_identity:{capability_id:source.capability_id,method:'POST',path:'/revit/save-as',request_signature:'a'.repeat(64)},target:{...source.target,target_id:'artifact_path:'+output.toLowerCase()},
  observation_ids:[id+':observed'],verification_operation_ids:[],opened_at:'2026-09-26T01:13:00.000Z',settled_assignment_version:9999};
 op.result={...structuredClone(source.result!),operation_id:id,receipt_id:id+':receipt',native_correlation_id:id+':native',native_transaction_state:'not_applicable',
  raw_payload_hash:'b'.repeat(64),result_schema_id:'operator-native/POST:/revit/save-as/v2',request_identity:structuredClone(op.request_identity),completed_at:'2026-09-26T01:13:01.000Z',
  affected_target_identities:['artifact_path:'+output.toLowerCase()],observation_required:true,native_artifact_receipt:{schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:'/revit/save-as',phase:'apply',status:'complete',
   expected_output_paths:[output],expected_export_calls:1,export_calls:[true],outputs:[{path:output,size_bytes:4096,sha256:'c'.repeat(64),fresh_output:true,stable_read:true}],
   save_document:{native_save_returned:true,same_document:true,document_session_changed:false,document_path_changed:false,project_binding_changed:false,before:identity,after:identity}}};
 const original=snapshot.observations[source.observation_ids[0]!]!;
 const observation:ObservationV2={...structuredClone(original),observation_id:op.observation_ids[0]!,operation_id:id,capability_id:op.capability_id,
  raw_payload_hash:op.result!.raw_payload_hash!,observed_at:op.result!.completed_at};
 const after:any=structuredClone(snapshot);after.operations[id]=op;after.observations[observation.observation_id]=observation;
 return{after,op,observation};
}

test('native saved checkpoint after new model work advances once, without certifying its file or resetting hard limits',()=>{
 const state=replay().j.snapshot(),first=savedCheckpoint(state);
 assert(nativeCommitProgressIdentityV2(first.after,first.op),'a real native save of current work is progress before its separate file check');
 const e=epoch(state,first.after);assert(e.progress_reasons.includes('native_change_committed'));
 assert.equal(appliedOperationHasVerifiedPostconditionV2(first.after,first.op.operation_id),false,'save receipt alone is not an independently checked artifact');
 const repeated=savedCheckpoint(first.after,'checkpoint-repeat');
 (repeated.op.result!.native_artifact_receipt!.outputs[0]as any).sha256='d'.repeat(64);
 assert.equal(nativeCommitProgressIdentityV2(first.after,first.op),nativeCommitProgressIdentityV2(repeated.after,repeated.op),'another path/receipt/hash without new native model work cannot buy progress');
 assert.equal(epoch(first.after,repeated.after).genuine_progress,false);
 const noProgress=epoch(state,state),prior=Array.from({length:3},(_,i)=>({...noProgress,epoch_id:'prior-repeat-'+i}));
 const snapshot={...first.after,progress_epochs:[...prior,e]};
 assert.equal(assignmentNativeReadbackResourceBlockerV2(snapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,first.op.result!.completed_at,1),null,'one ordinary independent read fits unchanged hard budgets after useful save');
 assert.notEqual(decideAssignmentProgressV2({snapshot,budget:DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,now:first.op.result!.completed_at}).reason,'no_progress_budget_exhausted','separate exact file read remains eligible after useful save');
 assert.equal(decideAssignmentProgressV2({snapshot,budget:{...DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,max_operations:1},now:first.op.result!.completed_at}).reason,'operation_budget_exhausted');
 const next:any=structuredClone(first.after),model=Object.values(next.operations as Record<string,OperationV2>).find(o=>o.result?.native_transaction_state==='committed'&&o.requested_effect==='apply')!;
 const edit=structuredClone(model);edit.operation_id='new-model-edit';edit.result={...edit.result!,operation_id:edit.operation_id,receipt_id:'new-model-receipt',completed_at:'2026-09-26T01:13:02.000Z'};
 edit.observation_ids=['new-model-observed'];const observed=structuredClone(next.observations[model.observation_ids[0]!]!);observed.observation_id=edit.observation_ids[0]!;observed.operation_id=edit.operation_id;
 next.operations[edit.operation_id]=edit;next.observations[observed.observation_id]=observed;
 const updated=savedCheckpoint(next,'checkpoint-updated');updated.op.opened_at='2026-09-26T01:13:03.000Z';updated.op.result!.completed_at='2026-09-26T01:13:04.000Z';
 assert.notEqual(nativeCommitProgressIdentityV2(first.after,first.op),nativeCommitProgressIdentityV2(updated.after,updated.op),'actual intervening native model work earns the next checkpoint');
 for(const variant of ['foreign','unsettled','unknown','signature','schema','binding','output','dryrun','invalidated','missing_observation']as const){
  const bad=structuredClone(first.after),o=bad.operations[first.op.operation_id]!;
  if(variant==='foreign')o.result!.authority='mcp';if(variant==='unsettled')o.settlement_state='pending' as any;
  if(variant==='unknown')o.persistent_effect='unknown';if(variant==='signature')o.result!.request_identity!.request_signature='f'.repeat(64);
  if(variant==='schema')o.result!.result_schema_id='operator-native/POST:/revit/export-pdf/v2';
  if(variant==='binding')o.result!.binding={...o.binding,generation:o.binding.generation+1};
  if(variant==='output')(o.result!.native_artifact_receipt!.outputs[0]as any).path='C:/unrelated.rvt';
  if(variant==='dryrun')(o.input.body as any).dryRun=true;if(variant==='invalidated')bad.input_invalidated_operation_ids=[o.operation_id];
  if(variant==='missing_observation')o.observation_ids=[];
  assert.equal(nativeCommitProgressIdentityV2(bad,o),null,variant);
 }
});
function append(j: AssignmentJournalV2, body: object, at = "2026-09-26T01:12:50.072Z") {
  const v = j.events().length + 1;
  return j.append({ schema: "revit-operator.assignment-event/v2", event_id: `progress-replay-${v}`,
    assignment_id: fixture.spec.binding.assignment_id, assignment_version: v, binding: fixture.spec.binding,
    occurred_at: at, actor: "retained-native-progress-replay", ...body } as AssignmentEventV2);
}
function journal() {
  // Preserve all earlier native facts and active work-unit states. Without
  // these a shortened fixture accidentally earns "new field" progress.
  return new AssignmentJournalV2(fixture.prelude);
}
function settle(j: AssignmentJournalV2, stage: Stage) {
  append(j, { event_type: "operation_admitted", operation: stage.operation }, stage.operation.opened_at);
  append(j, { event_type: "native_dispatch_recorded", operation_id: stage.operation.operation_id,
    native_correlation_id: stage.result.native_correlation_id }, stage.operation.opened_at);
  append(j, { event_type: "operation_result_recorded", result: stage.result }, stage.result.completed_at);
  return append(j, { event_type: "observation_retained", observation: stage.observation }, stage.observation.observed_at);
}
function epoch(before: AssignmentSnapshotV2, after: AssignmentSnapshotV2) {
  return buildHostProgressEpochV2({ before, after, stated_gap_ids: deriveProgressGapsV2(before).map(g => g.gap_id),
    recorded_at: "2026-09-26T01:12:50.072Z" });
}
function replay() {
  const j = journal();
  const transitions = fixture.stages.map(stage => { const before = j.snapshot(); return { before, after: settle(j, stage), stage }; });
  return { j, transitions };
}

test("retained repaired-thin native commits and exact readbacks are progress without completing the drawing", () => {
  const { transitions } = replay();
  for (const { before, after, stage } of transitions) {
    const e = epoch(before, after);
    if (stage.operation.requested_effect === "apply") assert(e.progress_reasons.includes("native_change_committed"));
    if (stage.operation.purpose === "verification") {
      assert(e.progress_reasons.includes("verification_observation_added"));
      assert.equal(appliedOperationHasVerifiedPostconditionV2(after, stage.operation.verification_of_operation_id!), false,
        "a useful connector read does not certify the requested geometry or close its proof gap");
    }
    if (stage.operation.requested_effect === "preview") assert.equal(e.genuine_progress, false, "rollback alone buys no progress");
    assert.equal(after.terminal, false);
    assert.deepEqual(after.criteria, {});
  }
});

test("journal/controller replay admits work after two readbacks and two previews with original hard limits", () => {
  const j = journal();
  for (const stage of fixture.stages) {
    const before = j.snapshot(), after = settle(j, stage);
    append(j, { event_type: "progress_epoch_recorded", epoch: epoch(before, after) });
  }
  const state = new AssignmentJournalV2(j.events()).snapshot();
  const decision = (snapshot: AssignmentSnapshotV2, budget = DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2) =>
    decideAssignmentProgressV2({ snapshot, budget, now: "2026-09-26T01:12:50.135Z" });
  assert.equal(decision(state).decision, "admit_reasoning_turn");
  assert.equal(decision(state, { ...DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, max_operations: 1 }).reason, "operation_budget_exhausted");
  assert.equal(decision(state, { ...DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, max_total_tokens: 0 }).reason, "token_budget_exhausted");
  assert.equal(decision(state, { ...DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, max_wall_clock_ms: 1 }).reason, "execution_lease_exhausted");
  assert.equal(decision({ ...state, unresolved_unknown_operation_ids: [fixture.stages[0]!.operation.operation_id] }).decision, "reconcile_operation");
  const noProgress = epoch(state, state);
  const stalled = { ...state, progress_epochs: [...state.progress_epochs,
    ...Array.from({ length: DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2.max_no_progress_epochs }, (_, i) =>
      ({ ...noProgress, epoch_id: `unchanged-repeat-${i}` }))] };
  assert.equal(decision(stalled).reason, "no_progress_budget_exhausted", "unchanged repeated work still hits the same stall limit");
});

test("readback repeats and authority, target, binding, settlement, and receipt substitutions earn no new progress", () => {
  const { transitions } = replay();
  const read = [...transitions].reverse().find(t => t.stage.operation.purpose === "verification")!;
  const id = read.stage.operation.operation_id, obsId = read.stage.observation.observation_id;
  const variants = ["failed", "unknown", "preview", "nonnative", "stale", "unlinked", "payload_mismatch", "wrong_subject",
    "wrong_target", "before_commit", "missing_subject_link"];
  for (const variant of variants) {
    const bad = structuredClone(read.after), op = bad.operations[id]!, obs = bad.observations[obsId]!;
    if (variant === "failed") op.result!.status = "failed_after_dispatch";
    if (variant === "unknown") op.persistent_effect = "unknown";
    if (variant === "preview") op.requested_effect = "preview";
    if (variant === "nonnative") op.result!.authority = "operator-mcp-transport";
    if (variant === "stale") obs.binding = { ...obs.binding, generation: 0 };
    if (variant === "unlinked") op.observation_ids = [];
    if (variant === "payload_mismatch") obs.raw_payload_hash = "different";
    if (variant === "wrong_subject") op.verification_of_operation_id = "missing";
    if (variant === "wrong_target") op.target = { ...op.target, target_id: "id:999999" };
    if (variant === "before_commit") op.opened_at = fixture.spec.created_at;
    if (variant === "missing_subject_link") bad.operations[op.verification_of_operation_id!]!.verification_operation_ids = [];
    assert.equal(epoch(read.before, bad).genuine_progress, false, variant);
  }
  const cloned = structuredClone(read.after);
  const repeated = { ...cloned, operations: { ...cloned.operations }, observations: { ...cloned.observations } };
  const original = repeated.operations[id]!;
  const cloneId = "repeated-native-verification", cloneObsId = "repeated-observation";
  repeated.operations[cloneId] = { ...original, operation_id: cloneId, observation_ids: [cloneObsId],
    input: { ...original.input, body: { ...(original.input.body as object), requestId: "new", timestamp: "new", limit: 9999 } },
    result: { ...original.result!, operation_id: cloneId, receipt_id: "another", raw_payload_hash: "another" } };
  repeated.observations[cloneObsId] = { ...repeated.observations[obsId]!, observation_id: cloneObsId, operation_id: cloneId, raw_payload_hash: "another" };
  const subject = repeated.operations[original.verification_of_operation_id!]!;
  subject.verification_operation_ids = [...subject.verification_operation_ids, cloneId];
  assert.equal(epoch(read.after, repeated).genuine_progress, false, "new receipts and presentation knobs cannot credit the same read twice");
});

test("a duplicate native receipt or unconfirmed apply cannot masquerade as another committed edit", () => {
  const { transitions } = replay();
  const apply = [...transitions].reverse().find(t => t.stage.operation.requested_effect === "apply")!;
  const id = apply.stage.operation.operation_id;
  for (const variant of ["failed", "unknown", "rollback", "nonnative", "no_receipt", "empty_targets", "stale", "unlinked", "duplicate_receipt"]) {
    const bad = structuredClone(apply.after), op = bad.operations[id]!;
    if (variant === "failed") op.result!.status = "failed_after_dispatch";
    if (variant === "unknown") op.persistent_effect = "unknown";
    if (variant === "rollback") op.result!.native_transaction_state = "rolled_back";
    if (variant === "nonnative") op.result!.authority = "dynamic-runtime";
    if (variant === "no_receipt") { op.result!.receipt_id = undefined; op.result!.native_correlation_id = undefined; }
    if (variant === "empty_targets") op.result!.affected_target_identities = [];
    if (variant === "stale") op.binding = { ...op.binding, generation: 0 };
    if (variant === "unlinked") op.observation_ids = [];
    if (variant === "duplicate_receipt") op.result!.receipt_id = fixture.stages[0]!.result.receipt_id;
    assert.equal(epoch(apply.before, bad).genuine_progress, false, variant);
  }
});

test('vector native pages and annotation parts earn progress once per bounded selector and retained write interval',()=>{
 const {transitions}=replay(),t=[...transitions].reverse().find(t=>t.stage.operation.purpose==='verification')!;
 const id=t.stage.operation.operation_id,obsId=t.stage.observation.observation_id;
 for(const route of ['/revit/view-owned-detailing','/revit/inspect-vector-detail']){
  const before=structuredClone(t.before),after=structuredClone(t.after),op=after.operations[id]!;
  op.input={method:'POST',path:route,body:route.endsWith('view-owned-detailing')?{cadTargetOnly:true,cadElementId:42,cadGeometryOffset:0}:{manifestElementId:42,partIndex:0}};
  op.request_identity={...op.request_identity!,path:route};
  assert(epoch(before,after).progress_reasons.includes('verification_observation_added'));
  const cloned=structuredClone(after),duplicate={...cloned,operations:{...cloned.operations},observations:{...cloned.observations}},copyId='new-vector-read',copyObs='new-vector-observation';
  duplicate.operations[copyId]={...structuredClone(op),operation_id:copyId,observation_ids:[copyObs],
   result:{...op.result!,operation_id:copyId,receipt_id:'new-vector-receipt',raw_payload_hash:'new-vector-hash'}};
  duplicate.observations[copyObs]={...structuredClone(after.observations[obsId]!),observation_id:copyObs,operation_id:copyId,raw_payload_hash:'new-vector-hash'};
  const subject=duplicate.operations[op.verification_of_operation_id!]!;subject.verification_operation_ids=[...subject.verification_operation_ids,copyId];
  assert.equal(epoch(after,duplicate).genuine_progress,false,'Different receipts do not renew the same page');
  (duplicate.operations[copyId]!.input.body as any).writeEpoch='invented';
  assert.equal(epoch(after,duplicate).genuine_progress,false,'Caller-supplied epochs cannot buy progress');
  (duplicate.operations[copyId]!.input.body as any)[route.endsWith('view-owned-detailing')?'cadGeometryOffset':'partIndex']=1;
  assert(epoch(after,duplicate).progress_reasons.includes('verification_observation_added'),'A distinct native selector is useful evidence, not whole-drawing proof');
  duplicate.operations[copyId]!.result!.authority='mcp';
  assert.equal(epoch(after,duplicate).genuine_progress,false,'Paging cannot replace native authority');
 }
});
