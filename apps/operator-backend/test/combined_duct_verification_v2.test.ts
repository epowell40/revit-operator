import assert from "node:assert/strict";
import test from "node:test";
import { combinedDuctVerificationParametersV2, pendingDuctVerificationRequestV2, DUCT_VERIFICATION_PARAMETERS_SCHEMA } from "../src/verification/combined_duct_verification_v2.js";

const scenario = () => {
  const binding={session_id:"task",assignment_id:"assignment",run_id:"run",generation:1,principal_id:"local",document_fingerprint:"model"};
  const subject:any={operation_id:"applied",binding,requested_effect:"apply",persistent_effect:"applied",settlement_state:"settled",
    request_identity:{path:"/revit/mep-route-workflow"},result:{authority:"native-host",status:"succeeded",native_transaction_state:"committed",
      completed_at:"2026-09-17T00:00:01Z",affected_target_identities:["element_id:10","element_id:20"]}};
  const input=pendingDuctVerificationRequestV2(subject)!;
  const read:any={operation_id:"inspection",binding,input,purpose:"verification",fulfillment_role:"verification",requested_effect:"read",
    verification_of_operation_id:"applied",opened_at:"2026-09-17T00:00:02Z"};
  const snapshot:any={current_binding:binding,operations:{applied:subject,inspection:read}};
  const result:any={operation_id:"inspection"};
  const payload:any={verificationParameters:{schema:DUCT_VERIFICATION_PARAMETERS_SCHEMA,
    fields:["System Classification","Reference Level","Width","Height","Diameter"],items:[{id:10},{id:20}]}};
  return {subject,read,snapshot,result,payload};
};
test("combined verification requires the exact admitted native target set and a post-commit read",()=>{
  const original=scenario();assert.equal(combinedDuctVerificationParametersV2(original.snapshot,original.subject,original.result,original.payload),original.payload.verificationParameters);
  for(const [name,mutate] of [
    ["before commit",(f:any)=>f.read.opened_at="2026-09-17T00:00:00Z"],
    ["foreign task",(f:any)=>f.read.binding={...f.read.binding,assignment_id:"foreign"}],
    ["unbound verification",(f:any)=>delete f.read.verification_of_operation_id],
    ["not requested",(f:any)=>delete f.read.input.body.includeVerificationParameters],
    ["missing refs",(f:any)=>f.read.input.body.includeAllRefs=false],
    ["missing axes",(f:any)=>f.read.input.body.includeCoordinateSystem=false],
    ["open only",(f:any)=>f.read.input.body.onlyOpenPhysicalConnectors=true],
    ["duplicate request",(f:any)=>f.read.input.body.elementIds=[10,10]],
    ["foreign request",(f:any)=>f.read.input.body.elementIds=[10,30]],
    ["missing target",(f:any)=>f.payload.verificationParameters.items.pop()],
    ["duplicate target",(f:any)=>f.payload.verificationParameters.items[1].id=10],
    ["failed target",(f:any)=>f.payload.verificationParameters.items[1].error="not found"],
    ["unknown version",(f:any)=>f.payload.verificationParameters.schema="future"],
    ["missing field",(f:any)=>f.payload.verificationParameters.fields.pop()],
    ["duplicate field",(f:any)=>f.payload.verificationParameters.fields[4]="Width"]
  ] as Array<[string,(f:any)=>void]>){const f=scenario();mutate(f);assert.equal(combinedDuctVerificationParametersV2(f.snapshot,f.subject,f.result,f.payload),null,name);}
});
test("next inspection never invents targets, authorizes writes or uses unknown/unsupported effects",()=>{
  const f=scenario(),request=pendingDuctVerificationRequestV2(f.subject)!;
  assert.deepEqual(request.body.elementIds,[10,20]);assert.equal(request.path,"/revit/get-connectors");assert.equal(request.body.includeVerificationParameters,true);
  for(const change of [
    (s:any)=>s.persistent_effect="unknown",(s:any)=>s.result.authority="dynamic-runtime",(s:any)=>s.result.native_transaction_state="rolled_back",
    (s:any)=>s.result.affected_target_identities=["element_id:10","element_id:10"],(s:any)=>s.result.affected_target_identities=["element_id:9007199254740999"],
    (s:any)=>s.result.affected_target_identities=Array.from({length:501},(_,i)=>"element_id:"+(i+1)),
    (s:any)=>s.request_identity.path="/revit/create-family-instance"
  ]){const next=structuredClone(f.subject);change(next);assert.equal(pendingDuctVerificationRequestV2(next),null);}
});
