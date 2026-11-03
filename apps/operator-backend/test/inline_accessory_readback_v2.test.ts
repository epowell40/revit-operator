import assert from 'node:assert/strict';
import test from 'node:test';
import { inlineAccessoryReadbackMatchesV2 } from '../src/verification/inline_accessory_readback_v2.js';
import { inlineAccessoryFixture } from './inline_accessory_readback.fixtures.js';
import {verificationCapabilityGuidanceV2,operationTargetSelectorV2} from '../src/verification/verification_capability_admission_v2.js';

const matches=(f:ReturnType<typeof inlineAccessoryFixture>)=>inlineAccessoryReadbackMatchesV2(f.input,f.affected,f.apply,f.scan);

for(const stage of ['internal_dependencies','centerline_parameters','system_identity','bookkeeping_validation'])
test(`native failure diagnostic at ${stage} is never current preservation evidence`,()=>{
  const f=inlineAccessoryFixture();
  Object.assign(f.scan,{inlineAccessoryState:{schema:'operator.inline_accessory_state.v1',complete:false,
    reason:'native_observation_unavailable',error:'InvalidOperationException',stage,
    diagnosticCode:'native_observation_failed',diagnosticOnly:true}});
  assert.equal(matches(f),false);
});

function withIfcIdentity() {
  const f=inlineAccessoryFixture();
  // Exact old IFC value from retained native original75; new value is a
  // synthetic split identity, not a successful historical native result.
  const prior=JSON.stringify([{id:-1019000,storage:'String',value:'1JbANhx6TBfudXEbM1T$P_'},{id:1,storage:'String',value:'retain'}]);
  f.apply.preservationBefore.owners.find((o:any)=>o.elementId===10).state.parameters=prior;
  f.scan.inlineAccessoryState.owners.find((o:any)=>o.elementId===10).state.parameters=prior;
  f.scan.inlineAccessoryState.owners.find((o:any)=>o.elementId===20).state.parameters=prior.replace('1JbAN','2JbAN');
  return f;
}
test('new split duct has fresh IFC identity while original host identity and all other data remain exact',()=>{
  assert.equal(matches(withIfcIdentity()),true);
});
test('new split duct may copy writable IFC identity; native UniqueId remains independent',()=>{
  const f=withIfcIdentity();f.scan.inlineAccessoryState.owners.find((o:any)=>o.elementId===20).state.parameters=f.apply.preservationBefore.owners[0].state.parameters;
  assert.equal(matches(f),true);
});
const ifcNegatives:Record<string,(f:any)=>void>={
  'retained IFC change':f=>f.scan.inlineAccessoryState.owners[0].state.parameters=f.scan.inlineAccessoryState.owners[1].state.parameters,
  'other writable parameter':f=>f.scan.inlineAccessoryState.owners[1].state.parameters=f.scan.inlineAccessoryState.owners[1].state.parameters.replace('retain','changed'),
  'omitted parameters':f=>f.scan.inlineAccessoryState.owners[1].state.parameters='[]',
  'invalid IFC':f=>f.scan.inlineAccessoryState.owners[1].state.parameters=f.scan.inlineAccessoryState.owners[1].state.parameters.replace('2JbANhx6TBfudXEbM1T$P_','invalid'),
  'null IFC':f=>f.scan.inlineAccessoryState.owners[1].state.parameters=f.scan.inlineAccessoryState.owners[1].state.parameters.replace('"2JbANhx6TBfudXEbM1T$P_"','null'),
  'duplicate parameter ID':f=>f.scan.inlineAccessoryState.owners[1].state.parameters=f.scan.inlineAccessoryState.owners[1].state.parameters.replace('"id":1,','"id":-1019000,'),
  'extra row field':f=>f.scan.inlineAccessoryState.owners[1].state.parameters=f.scan.inlineAccessoryState.owners[1].state.parameters.replace('"id":1,','"extra":1,"id":1,'),
  'wrong IFC storage':f=>f.scan.inlineAccessoryState.owners[1].state.parameters=f.scan.inlineAccessoryState.owners[1].state.parameters.replace('"storage":"String"','"storage":"Integer"'),
  'wrong scalar representation':f=>f.scan.inlineAccessoryState.owners[1].state.parameters=f.scan.inlineAccessoryState.owners[1].state.parameters.replace('"retain"','12'),
  'foreign remote IFC':f=>f.scan.inlineAccessoryState.owners[4].state.parameters=f.scan.inlineAccessoryState.owners[1].state.parameters,
};
for(const [name,change] of Object.entries(ifcNegatives))test(`split identity still rejects ${name}`,()=>{const f=withIfcIdentity();change(f);assert.equal(matches(f),false);});
test('inline candidate compares independently observed ports, split span, remote graph and unchanged schedules',()=>{
  const f=inlineAccessoryFixture();assert.equal(matches(f),true);
  f.scan.results.reverse();f.scan.results.forEach((r:any)=>r.connectors.reverse());
  f.scan.inlineAccessoryState.owners.reverse();f.scan.inlineAccessoryState.types.reverse();
  assert.equal(matches(f),true,'enumeration order does not alter native identities');
});
const failures:Record<string,(f:any)=>void>={
  'request preview':f=>f.input.body.dryRun=true,
  'unimplemented design field':f=>f.input.body.pressureLoss=0,
  'foreign host UID':f=>f.input.body.expectedMainUniqueId='other-native-uid',
  'wrong symbol UID':f=>f.input.body.expectedAccessoryTypeUniqueId='other-native-type',
  'unknown native effect':f=>f.apply.applied=null,
  'uncommitted child':f=>f.apply.transaction.committed=false,
  'contradictory pending child':f=>f.apply.transaction.pending=true,
  'contradictory rolled back child':f=>f.apply.transaction.rolled_back=true,
  'missing observed event count':f=>delete f.apply.changeTracking.matchingEventCount,
  'incomplete native footprint':f=>f.apply.changeTracking.exhaustiveChangeInventory=false,
  'deleted tag':f=>f.apply.transaction.deleted_element_ids=[70],
  'extra fitting':f=>f.apply.transaction.added_element_ids.push(70),
  'uncovered collateral':f=>{f.apply.transaction.modified_element_ids.push(70);f.apply.transaction.affected_element_ids.push(70);f.affected.push('element_id:70');},
  'omitted affected target':f=>f.affected.pop(),
  'missing before state':f=>delete f.apply.preservationBefore,
  'missing current state':f=>delete f.scan.inlineAccessoryState,
  'incomplete current state':f=>f.scan.inlineAccessoryState.complete=false,
  'changed native owner UID':f=>f.scan.inlineAccessoryState.owners[0].uniqueId='changed-native-uid',
  'duplicate native UID':f=>{f.scan.inlineAccessoryState.owners[1].uniqueId=f.scan.inlineAccessoryState.owners[0].uniqueId;f.scan.inlineAccessoryState.owners[1].state.UniqueId=f.scan.inlineAccessoryState.owners[0].uniqueId;},
  'contradictory native port representations':f=>f.scan.inlineAccessoryState.owners[0].state.ports[0].origin=[1,1,1],
  'wrong accessory phase':f=>f.scan.inlineAccessoryState.owners[2].state.metadata.phase=8,
  'wrong accessory level':f=>f.scan.inlineAccessoryState.owners[2].state.metadata.level=8,
  'changed instance parameter':f=>f.scan.inlineAccessoryState.owners[0].state.parameters='[{"id":1,"value":"changed"}]',
  'changed type parameter':f=>f.scan.inlineAccessoryState.types[1].parameters='[{"id":1,"value":"changed"}]',
  'wrong family type':f=>f.scan.results[2].typeId=999,
  '12inch definition is not6inch fit':f=>f.scan.results[2].connectors[0].size.diameterFt=1,
  'nonfinite port dimension':f=>f.scan.results[2].connectors[0].size.diameterFt=NaN,
  'contradictory radius versus diameter':f=>f.scan.results[2].connectors[0].size.radiusFt=.5,
  'inward facing port':f=>f.scan.results[2].connectors[0].coordinateSystem.basisZ=[1,0,0],
  'off-route current geometry':f=>f.scan.inlineAccessoryState.owners[1].state.points[0][1]=1,
  'missing reciprocal edge':f=>f.scan.results[2].connectors[0].physicalConnectedTo=[],
  'logical-only edge':f=>f.scan.results[2].connectors[0].physicalConnectedTo[0].isConnectedTo=false,
  'unreadable references':f=>f.scan.results[0].connectors[0].referenceReadErrorCount=1,
  'truncated connector scan':f=>f.scan.connectorScanTruncatedElementCount=1,
  'unknown connection':f=>f.scan.unknownPhysicalConnectorCount=1,
  'changed remote flex geometry':f=>f.scan.inlineAccessoryState.owners[4].state.points[1][1]=1,
  'changed remote peer ID':f=>f.apply.preexistingRemoteConnections[50][0].connectorId=99,
  'missing schedule':f=>f.scan.inlineAccessoryState.schedulePreservation.items=[],
  'changed schedule':f=>f.scan.inlineAccessoryState.schedulePreservation.items[0].parameters=[{id:1,value:'changed'}],
  'incomplete schedule baseline':f=>f.apply.preservationBefore.schedulePreservation.complete=false,
  'echo is not a current read':f=>f.scan=f.apply,
};
for(const [name,change] of Object.entries(failures))test(`inline candidate rejects ${name}`,()=>{const f=inlineAccessoryFixture();change(f);assert.equal(matches(f),false);});
test('inline model-visible guidance uses physical scope and separate schedules while legacy guidance remains intact',()=>{
  const f=inlineAccessoryFixture(),operation={capability_id:'revit_call_tool',path:f.input.path,arguments:f.input};
  const guidance=verificationCapabilityGuidanceV2(operation)!;
  assert.match(guidance,/includeInlineAccessoryState=true/);assert.match(guidance,/preservationScheduleIds/);
  assert.doesNotMatch(guidance,/elementIds=\[all affected IDs\]/);
  assert.match(verificationCapabilityGuidanceV2({...operation,arguments:{body:{connectionMode:'takeoff_fitting'}}})!,/created takeoff fitting/);
  const selected=operationTargetSelectorV2({operation,value:{mainElementId:10,accessoryTypeId:130,createdAccessoryId:30,createdDuctId:20,connectorId:99}});
  assert.deepEqual(selected.principal_target_tokens.filter(t=>t.startsWith('id:')).sort(),['id:10','id:130','id:20','id:30']);
  assert.equal(selected.principal_target_tokens.some(t=>t.endsWith(':99')),false);
});
