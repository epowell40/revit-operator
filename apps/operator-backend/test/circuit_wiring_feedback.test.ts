import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {projectEvidence} from '../src/evidence/evidence_projection.js';
import {modelEvidenceEnvelope} from '../src/evidence/model_context_budget.js';
import type {EvidenceRefV1,EvidenceTrustLevel} from '../src/evidence/evidence_ref.js';

function payload(settlement='committed') {
 const state=(elementId:number,wireSize:string)=>({elementId,uniqueId:'native-circuit-'+elementId,
  wireSize,wireSizeParameterReadOnly:true,wireTypeId:91,hot:3,neutral:1,ground:1,runs:1,dataComplete:true,fieldErrors:[]});
 const cases=[[31,'3-#4, 1-#4, 1-#4','3-#3, 1-#3, 1-#8'],[32,'3-#6, 1-#6, 1-#6','3-#4, 1-#4, 1-#10']] as const;
 return {status:'Applied and Verified',transaction:{status:settlement,committed:settlement==='committed'},
  dependentCircuitWiring:{schema:'operator.dependent_circuit_wiring.v1',revitVersion:'2024',versionError:null,
   basis:'native_automatic_calculation',settlement,items:cases.map(([id,before,preview])=>({elementId:id,uniqueId:'native-circuit-'+id,
    before:state(id,before),preview:state(id,preview),afterSettlement:state(id,settlement==='committed'?preview:before),
    nativeWireSizeChanged:settlement==='committed'})),
   limits:'Native calculated profiles, not physical installation or a design verdict. Preserve justified explicit design wiring separately.'}};
}
function ref(raw:unknown,trust:EvidenceTrustLevel='authoritative_native'):EvidenceRefV1 {
 const bytes=Buffer.from(JSON.stringify(raw));return {schema:'revit-operator.evidence-ref.v1',evidence_id:'ev1_native_wire_feedback',
  content_hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byte_count:bytes.length,media_type:'application/json',
  source:'assignment_kernel_v2:revit_call_tool',trust_level:trust,assignment_id:'assignment-wire',run_id:'run-wire',attempt_id:'operation-wire',generation:1,
  session_id:'session-wire',target_scope:['31','32'],bounded_summary:'Native dependent circuit sizing feedback',key_typed_facts:{},artifact_location:'retained-native-payload',
  redaction_status:'screened',secret_screening_status:'passed',created_at_utc:'2026-10-16T00:00:00Z',verification_relevance:'required',relationships:[]};
}

test('both dependent circuit profiles reach bounded model input with readonly and settlement meaning intact',()=>{
 for(const settlement of ['committed','rolled_back']){
  const raw=payload(settlement),projection=projectEvidence(ref(raw),raw,8192),wire=modelEvidenceEnvelope([projection],0);
  assert(projection.projected_bytes<=8192);assert.deepEqual(wire.evidence_projections[0]!.inline_payload,raw);
  assert.equal(projection.truncated,false);assert.equal(projection.content_hash,ref(raw).content_hash);
  const actual=(wire.evidence_projections[0]!.inline_payload as typeof raw).dependentCircuitWiring;
  assert.equal(actual.items.length,2);assert.equal(actual.settlement,settlement);
  assert(actual.items.every(i=>i.afterSettlement.wireSizeParameterReadOnly));
  assert.equal(actual.items[0]!.afterSettlement.wireSize,settlement==='committed'?'3-#3, 1-#3, 1-#8':'3-#4, 1-#4, 1-#4');
  assert.equal(actual.items[1]!.afterSettlement.wireSize,settlement==='committed'?'3-#4, 1-#4, 1-#10':'3-#6, 1-#6, 1-#6');
  assert(!JSON.stringify(projection).includes('verification.postcondition_satisfied'));
 }
});
test('missing native wiring remains an explicit gap and a caller copy gains no native authority',()=>{
 const raw=payload();Object.assign(raw.dependentCircuitWiring.items[1]!.afterSettlement,{wireSize:null,dataComplete:false,
  fieldErrors:[{field:'wireSize',errorType:'MissingParameter',message:'Native wire-size field unavailable'}]});
 const native=projectEvidence(ref(raw),raw,8192);
 assert.deepEqual(native.inline_payload,raw);assert.equal(native.trust_level,'authoritative_native');
 const caller=projectEvidence(ref(raw,'untrusted_caller'),raw,8192);
 assert.equal(caller.inline_payload,undefined);assert.equal(caller.trust_level,'untrusted_caller');
 assert(!JSON.stringify(caller).includes('verification.postcondition_satisfied'));
});
