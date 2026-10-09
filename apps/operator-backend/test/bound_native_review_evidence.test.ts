import assert from "node:assert/strict";
import test from "node:test";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { boundNativeReviewEvidence } from "../src/benchmark/bound_native_review_evidence.js";
import { assignmentKernelAcceptanceTruthV2 } from "../src/benchmark/assignment_kernel_v2_acceptance.js";

function fixture(): any {
  const binding={assignment_id:"task",run_id:"run",generation:1,session_id:"session",principal_id:"local",document_fingerprint:"doc"};
  const payload={items:[{id:71,sheetNumber:"TEST-X",name:"Coordination"}],hasMore:false};
  const hash=payloadDigestV2(payload).digest;
  const request={method:"POST",path:"/revit/sheets"};
  const result={schema:"revit-operator.operation-result/v2",result_id:"result",operation_id:"read",binding,
    status:"succeeded",dispatch_state:"dispatched",persistent_effect:"none",authority:"native-host",
    request_identity:request,result_schema_id:"operator-native/POST:/revit/sheets/v2",raw_payload_hash:hash,
    observation_required:true,completed_at:"2026-10-09T11:00:01Z"};
  const operation={schema:"revit-operator.operation/v2",operation_id:"read",binding,capability_id:"revit_call_tool",
    requested_effect:"read",request_identity:request,dispatch_state:"dispatched",settlement_state:"settled",
    persistent_effect:"none",dispatched_at:"2026-10-09T11:00:00Z",observation_ids:["obs"],result,
    observation_commit:{raw_payload:payload}};
  const snapshot={schema:"revit-operator.assignment-snapshot/v2",assignment_version:7,current_binding:binding,
    spec:{requested_effect:"apply",criteria:[]},operations:{read:operation},observations:{obs:{schema:"revit-operator.observation/v2",
      observation_id:"obs",operation_id:"read",binding,authority:"native-host",result_schema_id:result.result_schema_id,raw_payload_hash:hash}},
    provider_call_ids:[],provider_calls:{},in_flight_provider_call_ids:[],in_flight_operation_ids:[],unresolved_unknown_operation_ids:[],
    terminal:false,outcome:"awaiting_user_review",quiescent:true};
  return {schema:"revit-operator.benchmark-assignment-kernel-v2/v1",assignment_ids:["task"],failures:[],assignments:[{
    schema:"revit-operator.assignment-kernel-publication/v2",assignment_id:"task",assignment_version:7,snapshot,
    provider_ledger:{schema:"revit-operator.assignment-provider-ledger/v2",assignment_id:"task",run_id:"run",generation:1,
      call_ids:[],calls:{},in_flight_call_ids:[]}}]};
}

test("advisory native readback resolves without granting task acceptance",()=>{
  const bundle=fixture(), resolved=boundNativeReviewEvidence(bundle);
  assert.equal(resolved.length,1);
  assert.equal(resolved[0]!.payload.items instanceof Array,true);
  assert.equal(assignmentKernelAcceptanceTruthV2(bundle).verified,false);
});

test("cross-document, stale generation, altered payload and detached observation fail closed",()=>{
  const mutations: ((s:any)=>void)[]=[
    s=>{s.operations.read.binding={...s.current_binding,document_fingerprint:"other"};},
    s=>{s.observations.obs.binding={...s.current_binding,generation:2};},
    s=>{s.operations.read.observation_commit.raw_payload.items[0].name="Tampered";},
    s=>{s.observations.obs.raw_payload_hash="sha256:"+"0".repeat(64);},
    s=>{s.observations.obs.authority="operator-mcp-transport";},
    s=>{s.operations.read.observation_ids=[];},
    s=>{s.operations.read.result.authority="operator-mcp-transport";},
    s=>{s.operations.read.result.request_identity={method:"POST",path:"/revit/views"};},
    s=>{s.operations.read.result.completed_at="2026-10-09T10:59:59Z";},
    s=>{s.operations.read.persistent_effect="unknown";}
  ];
  for(const mutate of mutations){const b=fixture();mutate(b.assignments[0].snapshot);assert.deepEqual(boundNativeReviewEvidence(b),[]);}
});

test("apply evidence requires authoritative committed settlement, not a success-shaped payload",()=>{
  const b=fixture(), op=b.assignments[0].snapshot.operations.read;
  op.requested_effect="apply";
  assert.deepEqual(boundNativeReviewEvidence(b),[]);
  op.persistent_effect="applied";op.result.persistent_effect="applied";op.result.native_transaction_state="committed";
  assert.equal(boundNativeReviewEvidence(b).length,1);
  op.result.native_transaction_state="pending";
  assert.deepEqual(boundNativeReviewEvidence(b),[]);
});

test("failed collection and duplicate publication never resolve evidence",()=>{
  const b=fixture();b.failures.push({error:"lost publication"});assert.deepEqual(boundNativeReviewEvidence(b),[]);
  b.failures=[];b.assignments.push(structuredClone(b.assignments[0]));assert.deepEqual(boundNativeReviewEvidence(b),[]);
});

test("retained evidence references require bound observation and matching normalized content",()=>{
  const b=fixture(), s=b.assignments[0].snapshot, payload=s.operations.read.observation_commit.raw_payload;
  delete s.operations.read.observation_commit;
  s.observations.obs.raw_payload_ref="evidence:retained-read";
  assert.deepEqual(boundNativeReviewEvidence(b),[]);
  const refs:string[]=[];
  assert.equal(boundNativeReviewEvidence(b,ref=>{refs.push(ref);return payload;}).length,1);
  assert.deepEqual(refs,["evidence:retained-read"]);
  assert.deepEqual(boundNativeReviewEvidence(b,()=>({...payload,hasMore:true})),[]);
  assert.deepEqual(boundNativeReviewEvidence(b,()=>{throw Error("missing");}),[]);
});
