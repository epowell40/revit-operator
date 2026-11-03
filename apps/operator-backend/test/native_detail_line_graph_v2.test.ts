import test from'node:test';import assert from'node:assert/strict';
import{detailLineGraphFixture}from'./native_detail_line_graph.fixtures.js';
import{nativeDetailLineGraphRequestV2,nativeDetailLineCommitV2,nativeDetailLineReadbackMatchesV2,detailLineOwnerReadRequestV2}from'../src/verification/native_detail_line_graph_v2.js';
import{verificationCapabilityAdmissionForPathsV2,operationTargetSelectorV2}from'../src/verification/verification_capability_admission_v2.js';
test('literal graph matches separately read native owner, line UIDs and all endpoints; no style/source claim',()=>{
 const f=detailLineGraphFixture();assert(nativeDetailLineReadbackMatchesV2(f.input,f.applied,f.readInput,f.fresh));
 assert.equal(nativeDetailLineGraphRequestV2(f.input)?.viewId,41);
 assert.deepEqual(nativeDetailLineCommitV2(f.input,f.applied)?.read,f.readInput);
 assert.equal(verificationCapabilityAdmissionForPathsV2(f.input.path,f.readInput.path,f.input.body,f.readInput.body).admissible,true);
 assert.equal(verificationCapabilityAdmissionForPathsV2(f.input.path,'/revit/get-element-summary',f.input.body,{elementIds:[101,102]}).admissible,false);
 assert.deepEqual(operationTargetSelectorV2({operation:{path:f.input.path,arguments:f.input},value:f.applied}).principal_target_tokens,['id:41']);
 const named=structuredClone(f);named.input.body.returns=['lineA','lineB'];assert(nativeDetailLineReadbackMatchesV2(named.input,named.applied,named.readInput,named.fresh));
});
const faults:Record<string,(f:any)=>void>={
 'wrong owner input':f=>f.input.body.operations[1].args=[99],
 'foreign allowed owner':f=>f.input.body.transaction.allowedExistingElementIds=[41,99],
 'no creation grant':f=>f.input.body.transaction.allowCreate=false,
 'rollback request':f=>f.input.body.transaction.mode='rollback',
 'small declared cap':f=>f.input.body.transaction.maxAffectedElements=1,
 'duplicate step':f=>f.input.body.operations[3].id='a',
 'unknown step field':f=>f.input.body.operations[2].code='evaluate()',
 'unused mutation':f=>f.input.body.operations.push({id:'foreign',op:'call',memberId:'method:Other.Set()',args:[]}),
 'nonliteral geometry':f=>f.input.body.operations[2].args[0]='$expression',
 'nonfinite geometry':f=>f.input.body.operations[2].args[0].x=Infinity,
 'extra geometry coordinate':f=>f.input.body.operations[2].args[0].w=1,
 'degenerate geometry':f=>f.input.body.operations[2].args[1]={...f.input.body.operations[2].args[0]},
 'forward/foreign handle':f=>f.input.body.operations[4].target='$other',
 'reused geometry':f=>f.input.body.operations[5].args[1]={$ref:'a'},
 'missing graph return':f=>f.input.body.returns.pop(),
 'duplicate graph return':f=>f.input.body.returns=['$lineA','$lineA'],
 'pending commit':f=>f.applied.transaction.pending=true,
 'rolled back commit':f=>f.applied.transaction.committed=false,
 'no authoritative observer':f=>f.applied.transaction.scope_observer_executions=0,
 'unknown baseline':f=>f.applied.transaction.scope_baseline='unknown',
 'scope spill':f=>f.applied.transaction.unexpected_existing_element_ids=[99],
 'changed old element':f=>f.applied.transaction.modified_element_ids=[41],
 'deleted old element':f=>f.applied.transaction.deleted_element_ids=[99],
 'unexpected addition':f=>f.applied.transaction.added_element_ids.push(103),
 'duplicate addition':f=>f.applied.transaction.added_element_ids=[101,101],
 'missing creation inventory':f=>delete f.applied.transaction.added_element_ids,
 'wrong affected count':f=>f.applied.transaction.affected_element_count=1,
 'wrong native operation count':f=>f.applied.operation_count=5,
 'wrong native mutation count':f=>f.applied.mutation_operation_count=1,
 'missing native step':f=>f.applied.operations.pop(),
 'wrong native member':f=>f.applied.operations[4].member_id='method:Other.New()',
 'foreign native receiver':f=>f.applied.operations[4].target_type='Autodesk.Revit.DB.Element',
 'wrong owner UID':f=>f.applied.operations[1].result_preview.unique_id='different-owner-uid',
 'not native line preview':f=>f.applied.operations[2].result_preview.type='Autodesk.Revit.DB.Arc',
 'different returned identity':f=>f.applied.results.lineA.unique_id='different-line-uid',
 'geometry cleanup error':f=>f.applied.geometry_cleanup_errors=['error'],
 'wrong read selector':f=>f.readInput.body.viewId=99,
 'CAD-only read':f=>f.readInput.body.cadTargetOnly=true,
 'nested substitute':f=>{f.fresh={echo:f.fresh};},
 'read failed':f=>f.fresh.ok=false,
 'incomplete view set':f=>f.fresh.viewsComplete=false,
 'wrong requested view':f=>f.fresh.requestedViewIds=[99],
 'extra view':f=>f.fresh.views.push(f.fresh.views[0]),
 'wrong observed view':f=>f.fresh.views[0].view.id=99,
 'wrong observed view UID':f=>f.fresh.views[0].view.uniqueId='other-native-view',
 'incomplete owner inventory':f=>f.fresh.views[0].itemsComplete=false,
 'truncated owner inventory':f=>f.fresh.views[0].truncated=true,
 'unreadable owner inventory':f=>f.fresh.views[0].unreadableCount=1,
 'contradictory inventory count':f=>f.fresh.views[0].totalOwnedCount=3,
 'missing line':f=>f.fresh.views[0].items.pop(),
 'duplicate native identity':f=>f.fresh.views[0].items[1].elementId=101,
 'wrong native line UID':f=>f.fresh.views[0].items[0].uniqueId='foreign-native-line',
 'wrong native owner':f=>f.fresh.views[0].items[0].ownerViewId=99,
 'wrong native class':f=>f.fresh.views[0].items[0].className='ModelLine',
 'wrong native category':f=>f.fresh.views[0].items[0].builtInCategory='OST_Walls',
 'excluded native line':f=>f.fresh.views[0].items[0].comparisonExcluded=true,
 'incomplete native signature':f=>f.fresh.views[0].items[0].semanticSignatureComplete=false,
 'wrong curve kind':f=>f.fresh.views[0].items[0].curve.kind='Arc',
 'wrong second endpoint':f=>f.fresh.views[0].items[1].curve.end.y=20,
 'wrong line plane':f=>f.fresh.views[0].items[1].curve.start.z=1,
};
for(const[name,change]of Object.entries(faults))test('line readback refuses '+name,()=>{const f=detailLineGraphFixture();change(f);assert.equal(nativeDetailLineReadbackMatchesV2(f.input,f.applied,f.readInput,f.fresh),false);});
test('owner read requires one explicit positive owner and bounded complete inventory',()=>{for(const v of [{viewId:41,viewIds:[41]},{viewId:41,limit:5001},{viewId:0},{viewIds:[41]},{viewId:'41'}])assert.equal(detailLineOwnerReadRequestV2(v),null);});
