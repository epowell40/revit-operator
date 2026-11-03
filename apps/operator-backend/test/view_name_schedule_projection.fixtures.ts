import {storeEvidence} from "../src/evidence/evidence_store.js";
import {payloadDigestV2} from "@revitoperator/payload-digest-v2";
export function bound(f:any) {
 const binding={assignment_id:'parameter-scope',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const s:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{},observations:{}};
 function op(id:string,input:any,payload:any,at:string,purpose:string) {
  const r=storeEvidence({scope:{...binding,attempt_id:id},source:'native-fixture',trust_level:'authoritative_native',raw:payload}),digest=payloadDigestV2(payload).digest;
  const request={method:input.method,path:input.path,request_signature:'signature-'+id};
  const o:any={operation_id:id,binding,input,request_identity:request,capability_id:'native:POST:'+input.path,requested_effect:purpose==='work'?'apply':'read',purpose,
   persistent_effect:purpose==='work'?'applied':'none',admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',opened_at:at,
   observation_ids:['obs-'+id],verification_operation_ids:[],target:{target_id:'element_id:'+f.targets[0]},
   result:{operation_id:id,binding,request_identity:request,status:'succeeded',authority:'native-host',dispatch_state:'dispatched',persistent_effect:purpose==='work'?'applied':'none',
    native_transaction_state:purpose==='work'?'committed':'not_applicable',receipt_id:'receipt-'+id,native_correlation_id:'correlation-'+id,
    raw_payload_hash:digest,result_schema_id:'operator-native/POST:'+input.path+'/v2',completed_at:at,
    affected_target_identities:f.applied.transaction.affected_element_ids.map((n:number)=>'element_id:'+n)}};
  s.operations[id]=o;s.observations['obs-'+id]={observation_id:'obs-'+id,operation_id:id,binding,authority:'native-host',raw_payload_hash:digest,raw_payload_ref:'evidence:'+r.ref.evidence_id,facts:[]};return o;
 }
 const apply=op('apply',f.input,f.applied,'2026-10-26T12:00:00Z','work'),read=op('read',f.readInput,f.read,'2026-10-26T12:00:01Z','verification');
 read.verification_of_operation_id='apply';return {s,apply,read};
}
