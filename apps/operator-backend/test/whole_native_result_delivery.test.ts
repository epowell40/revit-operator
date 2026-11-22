import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {storeEvidence, readAuthoritativeEvidence} from '../src/evidence/evidence_store.js';
import {getEvidenceContextBudget, modelEvidenceEnvelope, assertBoundedModelEvidencePayload, prepareBoundedModelEvidenceInput} from '../src/evidence/model_context_budget.js';
import {boundDesktopNativeOutput} from '../src/assignments/desktop_native_output.js';

const scope = {session_id:'whole-result', assignment_id:'assignment', run_id:'run', attempt_id:'attempt', generation:1};
function isolated(fn:()=>void) {
  const keys=['OPERATOR_WORKSPACE_ROOT','OPERATOR_EVIDENCE_ITEM_BUDGET_BYTES','OPERATOR_EVIDENCE_REQUEST_BUDGET_BYTES'];
  const prior=keys.map(key=>process.env[key]);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'whole-result-'));
  keys.forEach(key=>delete process.env[key]); process.env.OPERATOR_WORKSPACE_ROOT=root;
  try {fn();} finally {
    keys.forEach((key,i)=>{if(prior[i]===undefined)delete process.env[key];else process.env[key]=prior[i];});
    fs.rmSync(root,{recursive:true,force:true});
  }
}
function save(value:string, failure=false) {
  const raw={schema:'revit-operator.dynamic-revit-program-run.v1',run_id:'dynamic',requested_mode:failure?'apply':'read',
    execution_lane:'native',execution_status:failure?'failed':'completed',execution_ok:!failure,
    native_outcome:{persistent_effect:failure?'unknown':'none',native_transaction_state:failure?'unknown':'not_started',
      verification_required:true,task_verified:false,program_result:value,error:failure?'Execution interrupted.':null},
    diagnostics:[],evidence:{compilerDetails:'x'.repeat(80000)}};
  return {raw,...storeEvidence({scope,source:'assignment_kernel_v2:operator_run_dynamic_revit_program',trust_level:'authoritative_native',raw},getEvidenceContextBudget().item_bytes)};
}
function deliver(projection:any) {
  const result=boundDesktopNativeOutput({success:true,contentItems:[{type:'inputText',text:JSON.stringify(modelEvidenceEnvelope([projection]))}]},scope,'call');
  const wire=[{type:'function_call_output',call_id:'call',output:result.contentItems.map((v:any)=>({type:'input_text',text:v.text}))}];
  const prepared=prepareBoundedModelEvidenceInput(wire) as typeof wire;
  assertBoundedModelEvidencePayload(prepared);
  return {wire:prepared,inline:JSON.parse(prepared[0]!.output[0]!.text).evidence_projections[0].inline_payload};
}
test('ordinary native returns reach actual desktop output and relay whole, without extra retrievals',()=>isolated(()=>{
  for(const value of ['observed record\n'.repeat(1000),'漢🚀"\\\n'.repeat(1500)]) {
    const saved=save(value), delivered=deliver(saved.projection);
    assert.equal(delivered.inline.native_outcome.program_result,value);
    assert.equal(delivered.inline.coverage.program_result_complete,true);
    assert.equal(delivered.inline.program_result_page,undefined);
    assert.equal(delivered.inline.native_outcome.task_verified,false);
    assert.equal(delivered.inline.retry_authorized,false);
    assert.deepEqual(JSON.parse(readAuthoritativeEvidence(saved.ref,scope).toString()),saved.raw);
    assert.throws(()=>readAuthoritativeEvidence(saved.ref,{...scope,assignment_id:'foreign'}),/scope|assignment/i);
  }
}));
test('whole failure details keep unknown effects and no verification or retry authority',()=>isolated(()=>{
  const saved=save('partial observation\n'.repeat(800),true),{inline}=deliver(saved.projection);
  assert.deepEqual(inline.native_outcome,saved.raw.native_outcome);
  assert.equal(inline.execution_ok,false); assert.equal(inline.retry_authorized,false);
}));
test('large inventories still page truthfully and aggregate request budget stays bounded',()=>isolated(()=>{
  assert.equal(getEvidenceContextBudget().request_bytes,32768);
  const saved=save('observed record\n'.repeat(10000)),{inline}=deliver(saved.projection);
  assert.equal(inline.coverage.program_result_complete,false);
  assert.equal(inline.program_result_page.complete,false);
  assert.equal(inline.program_result_page.text_pagination.has_more,true);
  const output=JSON.stringify(modelEvidenceEnvelope([saved.projection]));
  assert.throws(()=>prepareBoundedModelEvidenceInput([{type:'function_call_output',output},{type:'function_call_output',output}]),/model-request budget/);
  // Raising retained projection allowance must not admit arbitrary raw dumps.
  assert.throws(()=>assertBoundedModelEvidencePayload([{type:'function_call_output',output:'x'.repeat(8193)}]),/Raw function_call_output/);
}));
test('explicit smaller evidence budgets still govern producer and consumer',()=>isolated(()=>{
  process.env.OPERATOR_EVIDENCE_ITEM_BUDGET_BYTES='8192';
  const saved=save('observed record\n'.repeat(1000)),{inline}=deliver(saved.projection);
  assert.equal(inline.coverage.program_result_complete,false);
  assert(saved.projection.projected_bytes<=8192);
}));

test('several medium reads share the request budget without failing delivery or altering retained evidence',()=>isolated(()=>{
  const saved=save('observed record\n'.repeat(1200));
  const output=JSON.stringify(modelEvidenceEnvelope([saved.projection]));
  const wire=[{type:'function_call_output',call_id:'one',output},{type:'function_call_output',call_id:'two',output}];
  const before=JSON.stringify(wire),prepared=prepareBoundedModelEvidenceInput(wire) as typeof wire;
  assertBoundedModelEvidencePayload(prepared);
  assert.equal(JSON.stringify(wire),before);
  assert.deepEqual(prepared.map(row=>row.call_id),['one','two']);
  const results=prepared.map(row=>JSON.parse(row.output).evidence_projections[0].inline_payload);
  assert.equal(results.filter(v=>v.coverage.program_result_complete===true).length,1);
  const page=results.find(v=>v.program_result_page).program_result_page;
  assert(saved.raw.native_outcome.program_result.startsWith(page.selection));
  assert.equal(page.text_pagination.next_start,Buffer.byteLength(page.selection));
  assert.deepEqual(JSON.parse(readAuthoritativeEvidence(saved.ref,scope).toString()),saved.raw);
}));
test('request overflow cannot page failed or unknown program outcomes',()=>isolated(()=>{
  const saved=save('partial observation\n'.repeat(1000),true);
  const output=JSON.stringify(modelEvidenceEnvelope([saved.projection]));
  assert.throws(()=>prepareBoundedModelEvidenceInput([{type:'function_call_output',output},{type:'function_call_output',output}]),/model-request budget/);
}));
