import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeNativeParameterChecks,normalizeNativeProgram} from './dynamicNativeProgram.js';
const checks=[{element_id:42,parameter_name:'Author',expected_value:'Checked'}];
test('native parameter postconditions remain separate from compiler scope and write rights',()=>{
 assert.deepEqual(normalizeNativeParameterChecks(checks,'apply'),checks);
 const env={REVIT_OPERATOR_MODE:'local',OPERATOR_TOOL_EXPOSURE_PROFILE:'general'};
 const base={entry_type:'Edit',effect_scope:'active_document' as const};
 const old=normalizeNativeProgram(base,'apply','2024','a'.repeat(64),env);
 const withChecks=normalizeNativeProgram({...base,parameter_checks:checks},'apply','2024','a'.repeat(64),env);
 assert.deepEqual(withChecks,old,'checks never expand or alter native execution scope');
 assert.equal(normalizeNativeParameterChecks(undefined,'read'),undefined);
 assert.throws(()=>normalizeNativeParameterChecks(checks,'read'));
});
test('typed checks reject malformed, duplicate, oversized or mixed caller control fields',()=>{
 for(const bad of [[],null,{},[...checks,...checks],[{...checks[0],element_id:0}],[{...checks[0],expected_value:3}],
  [{...checks[0],parameter_name:' Author'}],[{...checks[0],parameter_name:'A\0B'}],[{...checks[0],verified:true}],
  Array.from({length:65},(_,i)=>({...checks[0],element_id:i+1})),[{...checks[0],expected_value:'x'.repeat(32769)}],
  Array.from({length:51},(_,i)=>({...checks[0],parameter_name:'Field'+i})),
  Array.from({length:3},(_,i)=>({...checks[0],element_id:i+1,expected_value:'x'.repeat(32768)}))])
  assert.throws(()=>normalizeNativeParameterChecks(bad,'apply'));
});
