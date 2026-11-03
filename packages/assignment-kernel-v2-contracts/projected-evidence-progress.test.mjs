import test from 'node:test';
import assert from 'node:assert/strict';
import {assignmentKernelControlEvidenceFactsV2} from './index.js';

const facts=(rows,fields)=>assignmentKernelControlEvidenceFactsV2('operator_retrieve_evidence',{
  ok:true,result:{schema:'revit-operator.evidence-retrieval.v1',
    evidence_ref:{evidence_id:'ev1_projected_inventory'},selection:rows,
    pagination:{path:'items',start:0,requested_count:rows.length,returned_count:rows.length,total_items:rows.length,
      ...(fields?{fields,row_projection:'selected_fields'}:{})}}});
const paths=fs=>fs.filter(f=>f.fact_id==='control.evidence_selection_available').map(f=>f.dimensions.selection_path).sort();

test('projected retained columns expose actual cells without claiming whole rows',()=>{
  const first=facts([{row_index:0,values:{name:'Equipment'},missing_fields:[]}],['name']);
  const next=facts([{row_index:0,values:{typeName:'Transformer'},missing_fields:[]}],['typeName']);
  assert.deepEqual(paths(first),['items[0].name']);
  assert.deepEqual(paths(next),['items[0].typeName']);
  assert.ok([...first,...next].every(f=>f.fact_class==='control'));
  assert.deepEqual(paths(facts([{row_index:0,values:{missing:null},missing_fields:['missing']}],['missing'])),[]);
  assert.deepEqual(paths(facts([{row_index:4,values:{name:'Wrong index'},missing_fields:[]}],['name'])),[]);
  assert.deepEqual(paths(facts([{row_index:0,values:{name:'Equipment'},missing_fields:[]}],['name','name'])),[]);
  assert.deepEqual(paths(facts([{name:'Equipment',typeName:'Transformer'}])),['items[0]']);
});
