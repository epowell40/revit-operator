import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {storeEvidence,readAuthoritativeEvidence,retrieveEvidence} from '../src/evidence/evidence_store.js';
import {assembleBoundedEvidenceContext,modelEvidenceEnvelope,assertBoundedModelEvidencePayload} from '../src/evidence/model_context_budget.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';

const scope={session_id:'helper-session',assignment_id:'helper-assignment',run_id:'helper-run',generation:2};
function workspace(fn:()=>void){
 const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'scoped-helper-projection-'));
 process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{fn();}finally{__closeForTests();if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(root,{recursive:true,force:true});}
}
function scenario(){
 const report={kind:'scope_report',claimed_completed:['Native after read found eight rows; exact row strings match the prior baseline after removing the blank row.','Saved a new model; the separate file check found matching saved path and hash.'],remaining_work:['Working owner: perform the fresh visual check and final handoff.'],uncertainties:['Three sampled cell styles are not an exhaustive all-cell border check.']};
 const binding={...scope,principal_id:'local:test',document_fingerprint:'document'},turn='helper-turn';
 const saved=storeEvidence({scope:{...scope,attempt_id:'helper:'+turn},source:'operator.desktop-helper-report',trust_level:'untrusted_caller',verification_relevance:'supporting',raw:{schema:'operator.desktop-helper-report.v1',binding,turn_id:turn,report,verified:false}});
 const helper={schema:'operator.desktop-helper-return.v1',binding,turn_id:turn,source_tool:'operator_manage_work_plan',request_hash:'a'.repeat(64),control_command_id:null,report,evidence_ref:saved.ref,verified:false};
 const raw={ok:true,session_id:scope.session_id,desktop_helper_return:helper,durable_assignment_kernel_v2:{snapshot:{current_binding:binding,history:'unrelated snapshot history '.repeat(45000)}},assignment_snapshot_v2:{history:'duplicate history'},rounds:[{assistant_message:'duplicate report'}]};
 return {report,helper,raw};
}
function refreshReport(f:ReturnType<typeof scenario>){
 f.helper.evidence_ref=storeEvidence({scope:{...scope,attempt_id:'helper:'+f.helper.turn_id},source:'operator.desktop-helper-report',trust_level:'untrusted_caller',verification_relevance:'supporting',raw:{schema:'operator.desktop-helper-report.v1',binding:f.helper.binding,turn_id:f.helper.turn_id,report:f.report,verified:false}}).ref;
}
const store=(raw:unknown,source='operator_desktop.function.delegate_revit_task',bytes=8192)=>storeEvidence({scope,source,trust_level:'untrusted_caller',verification_relevance:'required',raw},bytes);

test('bounded typed helper findings survive a large wrapper through real store and model context, without gaining native authority',()=>workspace(()=>{
 const f=scenario(),saved=store(f.raw),wire=JSON.parse(JSON.stringify(saved.projection));
 assert(wire.helper_findings,'The useful report must not disappear behind snapshot metadata');
 assert.deepEqual(wire.helper_findings.report,f.report);
 assert.equal(wire.helper_findings.verified,false);
 assert.equal(wire.helper_findings.authority,'unverified_helper_claims');
 assert.equal(wire.helper_findings.report_complete,true);
 assert.equal(wire.helper_findings.source_report.evidence_id,f.helper.evidence_ref.evidence_id);
 assert.equal(wire.trust_level,'untrusted_caller');assert.equal(wire.effect_state,null);assert.equal(wire.inline_payload,undefined);
 assert.equal(wire.helper_findings.whole_task_verified,false);
 assert(!JSON.stringify(wire).includes('unrelated snapshot history'));
 assert(Buffer.byteLength(JSON.stringify(wire))<=8192);
 assert.deepEqual(JSON.parse(readAuthoritativeEvidence(saved.ref,scope).toString()),f.raw);
 const context=assembleBoundedEvidenceContext({projections:[saved.projection],...scope}),envelope=modelEvidenceEnvelope(context.projections,context.omitted);
 assert.equal(envelope.evidence_projections.length,1);assert.equal(context.omitted,0);
 assert.deepEqual(JSON.parse(JSON.stringify(envelope)).evidence_projections[0].helper_findings.report,f.report);
 assertBoundedModelEvidencePayload([{type:'function_call_output',output:JSON.stringify(envelope)}]);
}));

test('oversized helper report keeps whole strings and honest coverage with exact inner-report retrieval selectors',()=>workspace(()=>{
 const f=scenario();for(const key of ['claimed_completed','remaining_work','uncertainties'] as const)f.report[key]=Array.from({length:24},(_,i)=>`${key}-${i}: ${'d'.repeat(850)}`);
 refreshReport(f);
 const saved=store(f.raw),h=JSON.parse(JSON.stringify(saved.projection)).helper_findings;
 assert(h);assert.equal(h.report_complete,false);assert.equal(saved.projection.truncated,true);
 for(const key of ['claimed_completed','remaining_work','uncertainties'] as const){
  const c=h.coverage[key];assert.equal(c.total,24);assert.equal(c.returned,h.report[key].length);assert(c.returned>0&&c.returned<24);assert.equal(c.next_start,c.returned);
  assert.deepEqual(h.report[key],f.report[key].slice(0,c.returned));assert.equal(c.retrieval_path,'report.'+key);
 }
 assert(Buffer.byteLength(JSON.stringify(saved.projection))<=8192);
 // The inner evidence remains independently scoped and retrievable, not the snapshot wrapper.
 const start=h.coverage.uncertainties.next_start;
 const read=retrieveEvidence({scope:{...scope,attempt_id:'helper:helper-turn'},evidence_id:f.helper.evidence_ref.evidence_id,item_range:{path:'report.uncertainties',start,count:2},max_bytes:8192,purpose:'Check the retained helper findings'});
 assert(read.evidence_ref.evidence_id===h.source_report.evidence_id);
 assert(JSON.stringify(read.selection).includes(f.report.uncertainties[start]!));
}));

test('foreign, malformed, claimed-verified and ordinary lookalikes do not receive special helper presentation',()=>workspace(()=>{
 for(const variant of ['source','run','session','generation','inner_ref','verified','kind','bad_list','bad_hash','failed']){
  const f=scenario();let source='operator_desktop.function.delegate_revit_task';
  if(variant==='source')source='attachment';if(variant==='run')f.helper.binding.run_id='foreign';
  if(variant==='session')f.helper.binding.session_id='foreign';if(variant==='generation')f.helper.binding.generation++;
  if(variant==='inner_ref')f.helper.evidence_ref.run_id='foreign';if(variant==='verified')f.helper.verified=true;
  if(variant==='kind')f.report.kind='not-a-helper';if(variant==='bad_list')f.report.uncertainties=['x'.repeat(1001)];
  if(variant==='bad_hash')f.helper.evidence_ref.content_hash='invalid';if(variant==='failed')f.raw.ok=false;
  assert.equal(JSON.parse(JSON.stringify(store(f.raw,source).projection)).helper_findings,undefined,variant);
 }
}));

test('a proposed helper question remains a proposal with remaining work and untrusted authority',()=>workspace(()=>{
 const f=scenario();Object.assign(f.report,{kind:'proposed_question',question:'Is a different design value required?'});
 f.helper.source_tool='operator_request_assignment_input';
 refreshReport(f);
 const h=JSON.parse(JSON.stringify(store(f.raw).projection)).helper_findings;
 assert.equal(h.report.question,'Is a different design value required?');assert.equal(h.verified,false);
 assert.equal(h.whole_task_verified,false);assert.match(h.guidance,/not.*supplied user input/i);
}));
