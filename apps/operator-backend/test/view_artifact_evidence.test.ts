import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { requestedViewArtifactEvidence } from "../src/benchmark/view_artifact_evidence.js";
import { evaluateGeneralRevitCapabilityAttempt, type GeneralRevitCapabilityCase } from "../src/benchmark/general_revit_capability_acceptance.js";
import { buildGeneralRevitAcceptanceReviewPacket, summarizeGeneralRevitAcceptanceReview } from "../src/benchmark/general_revit_acceptance_review.js";

const task: GeneralRevitCapabilityCase = { case_id: "arbitrary-view-capture", source: "user_basic", operation_family: "visual_verification",
  prompt: "Inspect this plan and provide a capture.", probe_prompt: "Inspect this plan.", expected_effect: "read",
  capability_paths: ["/revit/export-view-frame"], dispatch_any_of: ["/revit/export-view-frame"], epic0441_task_refs: [],
  fixture_precondition: { active_view: { name: "L4", view_type: "FloorPlan" } } };

function fixture(t: test.TestContext) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(), "view-artifact-evidence-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,"capture.png");
  fs.writeFileSync(file,createCanvas(1,1).toBuffer("image/png"));
  const now=Date.now();
  const binding={assignment_id:"assignment",run_id:"run",generation:1,session_id:"session",principal_id:"local",document_fingerprint:"document"};
  const payload={viewId:44,viewName:"L4",viewType:"FloorPlan",path:file,widthPx:1,heightPx:1};
  const result={schema:"revit-operator.operation-result/v2",result_id:"result",operation_id:"capture",binding,status:"succeeded",
    dispatch_state:"dispatched",persistent_effect:"none",authority:"native-host",result_schema_id:"operator-native/POST:/revit/export-view-frame/v2",
    observation_required:true,raw_payload_hash:payloadDigestV2(payload).digest,completed_at:new Date(now+100).toISOString()};
  const operation={schema:"revit-operator.operation/v2",operation_id:"capture",binding,capability_id:"revit_call_tool",requested_effect:"read",
    dispatch_state:"dispatched",settlement_state:"settled",persistent_effect:"none",dispatched_at:new Date(now-100).toISOString(),
    observation_ids:["observation"],result,observation_commit:{raw_payload:payload}};
  const snapshot={schema:"revit-operator.assignment-snapshot/v2",assignment_version:1,current_binding:binding,
    spec:{requested_effect:"read",criteria:[]},operations:{capture:operation},observations:{observation:{schema:"revit-operator.observation/v2",
      observation_id:"observation",operation_id:"capture",binding,result_schema_id:result.result_schema_id}},
    provider_call_ids:[],provider_calls:{},in_flight_provider_call_ids:[],terminal:true,outcome:"complete",quiescent:true};
  const attempt={ok:true,assistant_message:"Captured the requested plan; visual assessment accompanies the image.",
    actions:[{path:"/revit/export-view-frame",request_effect:"read",request_dispatched:true,status:"success"}],
    assignment_kernel_v2:{schema:"revit-operator.benchmark-assignment-kernel-v2/v1",assignment_ids:["assignment"],failures:[],assignments:[{
      schema:"revit-operator.assignment-kernel-publication/v2",assignment_id:"assignment",assignment_version:1,snapshot,
      provider_ledger:{schema:"revit-operator.assignment-provider-ledger/v2",assignment_id:"assignment",run_id:"run",generation:1,
        call_ids:[],calls:{},in_flight_call_ids:[]}}]}};
  return {attempt,payload,result,operation,binding,file,rehash:()=>{result.raw_payload_hash=payloadDigestV2(payload).digest;}};
}

test("view-bound native capture qualifies independently of case ID and image filename",t=>{
  const f=fixture(t);
  assert.equal(requestedViewArtifactEvidence(task,f.attempt),true);
  assert.equal(evaluateGeneralRevitCapabilityAttempt(task,f.attempt).verified,true);
});
test("wrong-floor, wrong-type and modified export metadata cannot qualify",t=>{
  const f=fixture(t);
  f.payload.viewName="L2"; f.rehash();
  assert.equal(requestedViewArtifactEvidence(task,f.attempt),false);
  f.payload.viewName="L4"; f.payload.viewType="CeilingPlan"; f.rehash();
  assert.equal(requestedViewArtifactEvidence(task,f.attempt),false);
  f.payload.viewType="FloorPlan";
  assert.equal(requestedViewArtifactEvidence(task,f.attempt),false,"payload digest must still bind metadata");
});
test("missing, stale and inventory-only files are not verified captures",t=>{
  const f=fixture(t);
  fs.utimesSync(f.file,new Date(0),new Date(0));
  assert.equal(requestedViewArtifactEvidence(task,f.attempt),false);
  fs.writeFileSync(f.file,JSON.stringify({visibleElements:[44]}));
  assert.equal(requestedViewArtifactEvidence(task,f.attempt),false);
  fs.writeFileSync(f.file,Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]));
  assert.equal(requestedViewArtifactEvidence(task,f.attempt),false,"PNG signature alone is not a decodable image");
  fs.unlinkSync(f.file);
  const result=evaluateGeneralRevitCapabilityAttempt(task,f.attempt);
  assert.equal(result.verified,false); assert.equal(result.verification_basis,"none");
});
test("valid-CRC unknown critical chunks and separated IDAT streams are rejected",t=>{
  const f=fixture(t), original=fs.readFileSync(f.file);
  const unknown=Buffer.from("0000000041424344db1720a5","hex");
  fs.writeFileSync(f.file,Buffer.concat([original.subarray(0,33),unknown,original.subarray(33)]));
  assert.equal(requestedViewArtifactEvidence(task,f.attempt),false);
  let offset=8;
  while(original.toString("ascii",offset+4,offset+8)!=="IDAT") offset+=12+original.readUInt32BE(offset);
  const end=offset+12+original.readUInt32BE(offset), idat=original.subarray(offset,end);
  const textChunk=Buffer.from("00000000744558749642c585","hex");
  fs.writeFileSync(f.file,Buffer.concat([original.subarray(0,end),textChunk,idat,original.subarray(end)]));
  assert.equal(requestedViewArtifactEvidence(task,f.attempt),false);
});
test("transport wrappers, uncommitted observations and malformed publications cannot attest to a capture",t=>{
  const f=fixture(t);
  f.result.authority="operator-mcp-transport";
  assert.equal(requestedViewArtifactEvidence(task,f.attempt),false);
  f.result.authority="native-host"; f.operation.observation_ids=[];
  assert.equal(requestedViewArtifactEvidence(task,f.attempt),false);
  f.operation.observation_ids=["observation"];
  f.attempt.assignment_kernel_v2.assignments[0].provider_ledger.generation=2;
  assert.equal(requestedViewArtifactEvidence(task,f.attempt),false);
});
test("an unrelated nonvisual read does not acquire a capture requirement",t=>{
  const f=fixture(t);
  assert.equal(requestedViewArtifactEvidence({...task,dispatch_any_of:["/revit/views"]},f.attempt),null);
  assert.equal(requestedViewArtifactEvidence({...task,expected_effect:"apply"},f.attempt),null);
});

test("a view-bound capture still needs independent assessment and collateral review",t=>{
  const f=fixture(t);
  const reviewedTask={...task,acceptance_review:{delivery_criteria:["Image and visibility assessment match the requested plan."],
    collateral_criteria:["No model changes."],intentional_missing_information:[]}};
  const evaluated=evaluateGeneralRevitCapabilityAttempt(reviewedTask,f.attempt);
  assert.equal(evaluated.verified,true);
  const packet=buildGeneralRevitAcceptanceReviewPacket("run",[reviewedTask],[{case_id:task.case_id,verification_results:evaluated}])!;
  assert.equal(summarizeGeneralRevitAcceptanceReview(packet,packet).pending,1);
  assert.equal(summarizeGeneralRevitAcceptanceReview(packet,packet).delivered,0);
  const unsupported=structuredClone(packet);
  unsupported.cases[0]!.outcome="delivered";
  unsupported.cases[0]!.explanation="Capture bound to L4";
  unsupported.cases[0]!.evidence_refs=[f.file];
  assert.throws(()=>summarizeGeneralRevitAcceptanceReview(packet,unsupported));
});
