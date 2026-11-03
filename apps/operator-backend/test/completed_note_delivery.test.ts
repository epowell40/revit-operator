import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import {fileURLToPath} from 'node:url';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {verifiedChangePresentationV2} from '../src/assignments/verified_change_presentation_v2.js';
import {deriveTerminalResultV2} from '../src/assignments/assignment_kernel_v2_terminal_result.js';
const here=path.dirname(fileURLToPath(import.meta.url)),file=[path.join(here,'fixtures/completed-note-delivery-516.json'),path.join(here,'../../test/fixtures/completed-note-delivery-516.json')].find(fs.existsSync)!;
function fixture(run:(s:any)=>void){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'operator-note-delivery-')),old=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=dir;
 try{const f=JSON.parse(fs.readFileSync(file,'utf8')),s=f.snapshot;for(const [oid,payload]of Object.entries(f.payloads)){const o=s.observations[oid],stored=storeEvidence({scope:{...s.current_binding,attempt_id:o.operation_id},source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:payload});o.raw_payload_ref='evidence:'+stored.ref.evidence_id;}run(s);}
 finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;assert.equal(path.dirname(dir),os.tmpdir());assert(path.basename(dir).startsWith('operator-note-delivery-'));fs.rmSync(dir,{recursive:true,force:true});}}
test('actual516 complete typed note comparison presents one verified note, never six preserved schedules',()=>fixture(s=>{
 assert.equal(verifiedChangePresentationV2(s),'Verified in Revit: 1 text note.');
}));
test('actual516 terminal handoff retains the verified edit alongside its independently inspected result path',()=>fixture(s=>{
 const before=JSON.stringify(s),summary=deriveTerminalResultV2(s).result_summary;
 assert.match(summary,/Verified in Revit: 1 text note\./);assert.match(summary,/Verified file:.*Workflow516 annotation-original Result\.rvt/);
 assert.doesNotMatch(summary,/readable|all schedules|no unrelated changes|six text notes/);assert.equal(JSON.stringify(s),before);
}));
for(const variant of ['foreign','unverified','hash','stale','unknown','nonexact','truncated','wrong-type','not-target'])test('typed note presentation refuses '+variant,()=>fixture(s=>{
 const a=Object.values(s.operations).find((o:any)=>o.request_identity.path==='/revit/create-text') as any,r=s.operations[a.verification_operation_ids[0]],o=s.observations[r.observation_ids[0]];
 if(variant==='foreign')r.result.binding={...s.current_binding,generation:999};
 if(variant==='unverified')o.facts=o.facts.filter((f:any)=>f.fact_id!=='verification.postcondition_satisfied');
 if(variant==='hash')o.raw_payload_hash='0'.repeat(64);
 if(variant==='stale')r.result.completed_at='2020-01-01T00:00:00Z';
 if(variant==='unknown')s.operations.later={operation_id:'later',requested_effect:'apply',persistent_effect:'unknown',opened_at:'2099-01-01T00:00:00Z'};
 if(variant==='nonexact')r.input.body={max:1};
 if(variant==='truncated')r.input.body={...r.input.body,elementIds:[1545903,42]};
 if(variant==='wrong-type')r.request_identity.path='/revit/get-parameters';
 if(variant==='not-target')o.facts.find((f:any)=>f.fact_id==='verification.deliverable_target_identities').value=['element_id:42'];
 assert.equal(verifiedChangePresentationV2(s),null);
}));
