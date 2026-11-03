import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {inlineBookkeepingFixture} from './inline_accessory_bookkeeping.fixtures.js';
import {inlineAccessoryReadbackMatchesV2} from '../src/verification/inline_accessory_readback_v2.js';
import {inlineSplitParametersMatchV2} from '../src/verification/inline_accessory_parameters_v2.js';
const matches=(f:any)=>inlineAccessoryReadbackMatchesV2(f.input,f.affected,f.apply,f.scan);
test('parent-bound centerline and exact system membership delta preserve independent semantic readback',()=>assert.equal(matches(inlineBookkeepingFixture()),true));
const negatives:Record<string,(f:any,b:any,a:any)=>void>={
  missingBefore:(f)=>delete f.apply.preservationBefore.bookkeeping,
  missingAfter:(f)=>delete f.scan.inlineAccessoryState.bookkeeping,
  incomplete:(_f,_b,a)=>a.complete=false,
  incompleteScan:(_f,_b,a)=>a.candidateScanComplete=false,
  hiddenClaim:(_f,_b,a)=>a.scope='all_hidden_state',
  writableInternal:(_f,_b,a)=>a.internals[0].parameters[0].readOnly=false,
  internalValue:(_f,_b,a)=>a.internals[0].parameters[0].value='2',
  categoryOnly:(_f,_b,a)=>a.internals[0].parameters=[],
  internalClass:(_f,_b,a)=>a.internals[0].className='Autodesk.Revit.DB.FamilyInstance',
  internalLocation:(_f,_b,a)=>a.internals[0].hasLocation=true,
  internalBounds:(_f,_b,a)=>a.internals[0].hasBounds=true,
  extensibleData:(_f,_b,a)=>a.internals[0].schemaGuids=['schema'],
  missingInternal:(_f,_b,a)=>a.internals.pop(),
  replacedUid:(_f,_b,a)=>a.internals[0].uniqueId='replacement',
  dependencyEscape:(_f,_b,a)=>a.internals[0].dependentIds.push(999),
  removedDependency:(_f,_b,a)=>a.internals[0].dependentIds.pop(),
  systemType:(_f,_b,a)=>a.system.typeId=999,
  systemInputs:(_f,_b,a)=>a.system.parameters='[{"id":1}]',
  systemTypeInputs:(_f,_b,a)=>a.system.typeParameters='[{"id":1}]',
  terminalRemoved:(_f,_b,a)=>a.system.members=[],
  remoteNetworkRemoved:(_f,_b,a)=>a.system.network=a.system.network.filter((n:any)=>n.elementId!==70),
  foreignPhysicalUid:(_f,_b,a)=>a.system.network[0].uniqueId='foreign',
  missingSplitMembership:(_f,_b,a)=>a.system.network=a.system.network.filter((n:any)=>n.elementId!==20),
  centerParent:(_f,_b,a)=>a.centerlines[1].parentId=40,
  centerParentUid:(_f,_b,a)=>a.centerlines[1].parentUniqueId='foreign',
  centerCategory:(_f,_b,a)=>a.centerlines[1].categoryId=-2000151,
  centerInput:(_f,_b,a)=>a.centerlines[0].parameters[0].value='100',
  parentInputBecomesCalculated:(_f,_b,a)=>a.centerlines[0].parentParameters[0].readOnly=true,
  newCenterInput:(_f,_b,a)=>a.centerlines[1].parameters[0].value='100',
  missingCenterParam:(_f,_b,a)=>a.centerlines[1].parameters.pop(),
  derivedNonFinite:(_f,_b,a)=>a.centerlines[0].parameters[1].value='NaN',
  parentDerivedNonFinite:(_f,_b,a)=>a.centerlines[0].parentParameters[1].value='Infinity',
  duplicateCrossScopeUid:(_f,_b,a)=>a.centerlines[1].uniqueId='native-owner-unique-10',
  unrelatedModified:f=>{f.apply.transaction.modified_element_ids.push(999);f.apply.transaction.affected_element_ids.push(999);f.affected.push('element_id:999');},
  missingAdded:f=>{f.apply.transaction.added_element_ids=f.apply.transaction.added_element_ids.filter((n:number)=>n!==21);},
  deleted:f=>f.apply.transaction.deleted_element_ids=[11],
  rollback:f=>{f.apply.transaction.status='rolled_back';f.apply.transaction.committed=false;},
  tracking:f=>f.apply.changeTracking.exhaustiveChangeInventory=false,
};
for(const [name,mutate] of Object.entries(negatives))test('ancillary comparison refuses '+name,()=>{
  const f=inlineBookkeepingFixture();mutate(f,f.apply.preservationBefore.bookkeeping,f.scan.inlineAccessoryState.bookkeeping);assert.equal(matches(f),false);
});
test('actual provisional85 parameter arrays retain typed sub-tolerance elevation roundoff',()=>{
  const locations=[new URL('./fixtures/inline-split-parameters85.json',import.meta.url),new URL('../../test/fixtures/inline-split-parameters85.json',import.meta.url)];
  const v=JSON.parse(fs.readFileSync(locations.find(p=>fs.existsSync(p))!,'utf8'));
  assert.equal(inlineSplitParametersMatchV2(v.before,v.retained,false),true);
  assert.equal(inlineSplitParametersMatchV2(v.before,v.created,true),true);
});
