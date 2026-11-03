import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import test from 'node:test';import {fileURLToPath} from 'node:url';
import {codexAssignmentEvidenceContextV2} from '../src/brains/codex_assignment_evidence.js';
import {desktopAssignmentFeedbackInputV2} from '../src/desktop_assignment_feedback.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const candidates=[path.join(here,'fixtures/verified-annotation-feedback-516.json'),path.join(here,'../../test/fixtures/verified-annotation-feedback-516.json')];
const fixture=()=>JSON.parse(fs.readFileSync(candidates.find(p=>fs.existsSync(p))!,'utf8'));
const expected=[1420970,1422218,1488968,1521719,1521731,1543793];
function check(index:any,s:any){
 assert.equal(index.verified_postconditions.length,1);const p=index.verified_postconditions[0];
 const apply=Object.values(s.operations).find((o:any)=>o.requested_effect==='apply') as any;
 assert.equal(p.operation_id,apply.operation_id);assert.equal(p.check_state,'verified_current');
 assert.deepEqual(p.checked_preservation_ids,expected);assert.deepEqual(p.deliverable_targets,['element_id:1545903']);
 assert(p.read_operation_id&&p.observation_id&&p.evidence_id);assert.match(p.scope,/not whole-model, visual, saved-file or task completion/);
 assert.deepEqual(index.pending_verification,[]);assert.equal(s.outcome,'active');
}
test('retained516: worker sees accepted exact native note and six-schedule preservation, without re-comparing raw arrays',()=>{
 const s=fixture(),before=JSON.stringify(s);check(JSON.parse(codexAssignmentEvidenceContextV2(s)),s);assert.equal(JSON.stringify(s),before);
});
test('retained516: desktop owner receives same authoritative scoped current check separately from untrusted helper prose',()=>{
 const s=fixture(),wire=JSON.stringify(desktopAssignmentFeedbackInputV2([],s));assert.match(wire,/verified_current/);
 const input:any=desktopAssignmentFeedbackInputV2([],s);const txt=input.at(-1).content[0].text;const record=JSON.parse(txt.slice(txt.indexOf('{')));check(record.native_feedback,s);
});
for(const variant of ['wrong_hash','foreign_read','foreign_observation','wrong_binding','false_fact','wrong_class','invalidated_apply','invalidated_read','unknown','paused','missing_receipt','later_write'])
test('verified feedback refuses '+variant,()=>{
 const s=fixture(),apply:any=Object.values(s.operations).find((o:any)=>o.requested_effect==='apply'),read=s.operations[apply.verification_operation_ids[0]],o=s.observations[read.observation_ids[0]];
 if(variant==='wrong_hash')o.raw_payload_hash='0'.repeat(64);
 if(variant==='foreign_read')read.result.authority='model';
 if(variant==='foreign_observation')o.authority='untrusted-caller';
 if(variant==='wrong_binding')read.binding.generation++;
 if(variant==='false_fact')o.facts.find((f:any)=>f.fact_id==='verification.postcondition_satisfied').value=false;
 if(variant==='wrong_class')o.facts.find((f:any)=>f.fact_id==='verification.postcondition_satisfied').fact_class='control';
 if(variant==='invalidated_apply')s.input_invalidated_operation_ids=[apply.operation_id];
 if(variant==='invalidated_read')s.input_invalidated_operation_ids=[read.operation_id];
 if(variant==='unknown')s.unresolved_unknown_operation_ids=[apply.operation_id];
 if(variant==='paused')s.execution_control={state:'paused'};
 if(variant==='missing_receipt')delete read.result.receipt_id;
 if(variant==='later_write')s.operations.later={...structuredClone(apply),operation_id:'later',verification_operation_ids:[],result:{...structuredClone(apply.result),completed_at:new Date(Date.parse(read.result.completed_at)+1000).toISOString()}};
 assert.deepEqual(JSON.parse(codexAssignmentEvidenceContextV2(s)).verified_postconditions??[],[]);
});
