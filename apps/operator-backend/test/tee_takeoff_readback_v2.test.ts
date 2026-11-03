import test from 'node:test';
import assert from 'node:assert/strict';
import {teeTakeoffReadbackMatchesV2,teeTakeoffTransitionV2} from '../src/verification/tee_takeoff_readback_v2.js';
import {existingMepConnectionReadbackMatchesV2} from '../src/verification/existing_mep_connection_readback_v2.js';
import {teeTakeoffFixture} from './tee_takeoff_readback.fixtures.js';
const matches=(f:ReturnType<typeof teeTakeoffFixture>)=>teeTakeoffReadbackMatchesV2(f.input,f.affected,f.apply,f.scan);
test('replacement has independent absence, exact dependent footprint, span, reciprocal topology and preserved state',()=>{
  const f=teeTakeoffFixture();assert.ok(teeTakeoffTransitionV2(f.apply.preservationBefore,f.scan.teeReplacementState,40,50,60,[10,20,30]));assert.equal(matches(f),true);
  assert.equal(existingMepConnectionReadbackMatchesV2(f.input,f.affected,f.apply,f.scan),false,'addition-only proof remains insufficient');
});
test('native default verify remains enabled and omitted optional display names do not prevent readback',()=>{
  const f=teeTakeoffFixture();delete f.input.body.verify;f.input.body.expectedTakeoffFamilyName=null;f.input.body.expectedTakeoffTypeName='';assert.equal(matches(f),true);
});
const negatives:Record<string,(f:ReturnType<typeof teeTakeoffFixture>)=>void>={
  teeStillExists:f=>f.scan.teeReplacementState.removed[0].exists=true,
  missingDependentAbsence:f=>f.scan.teeReplacementState.removed.pop(),
  extraDeletion:f=>f.apply.transaction.deleted_element_ids.push(999),
  unobservedModifiedOwner:f=>{f.apply.transaction.modified_element_ids.push(999);f.apply.transaction.affected_element_ids.push(999);f.affected.push('element_id:999');},
  missingAddedDependent:f=>f.apply.transaction.added_element_ids.pop(),
  missingModifiedInventory:f=>f.apply.changeTracking.exhaustiveChangeInventory=false,
  fakeCenterParent:f=>f.scan.teeReplacementState.centerlines[1].parentUniqueId='foreign',
  tagPretendingToBeCenter:f=>f.scan.teeReplacementState.centerlines[1].className='Autodesk.Revit.DB.IndependentTag',
  newCustomCenterSchema:f=>f.scan.teeReplacementState.centerlines[1].schemaGuids=['custom'],
  alteredType:f=>f.scan.teeReplacementState.types[0].parameters='[{"id":1,"storage":"String","value":"changed"}]',
  alteredRetainedParameter:f=>f.scan.teeReplacementState.owners[0].state.parameters='[{"id":1,"storage":"String","value":"changed"}]',
  changedSystemNetwork:f=>f.scan.teeReplacementState.system.network.pop(),
  changedSystemMembers:f=>f.scan.teeReplacementState.system.members=[],
  changedSchedule:f=>f.scan.teeReplacementState.schedulePreservation.items[0].parameters=[{id:1,value:'changed'}],
  incompleteSchedule:f=>f.scan.teeReplacementState.schedulePreservation.complete=false,
  changedFarPoint:f=>f.scan.teeReplacementState.owners[0].state.points[0][0]=1,
  displacedBranchControlPoint:f=>f.scan.teeReplacementState.owners[2].state.points[1][1]=4,
  branchBeyondEnvelope:f=>f.scan.teeReplacementState.owners[2].state.points[0][1]=-2,
  wrongSpan:f=>f.scan.teeReplacementState.owners[3].state.points[0][0]=4.5,
  wrongTakeoffType:f=>f.input.body.expectedTakeoffTypeId=140,
  wrongFamily:f=>f.input.body.expectedTakeoffFamilyName='Different',
  wrongBranchConnector:f=>f.input.body.branchConnectorId=1,
  wrongExpectedOrigin:f=>f.input.body.expectedBranchOriginXyz=[0,0,0],
  wrongDiameter:f=>f.scan.results[4].connectors[0].size={kind:'round',diameterFt:1,radiusFt:.5},
  wrongRetainedFarDiameter:f=>f.scan.results[0].connectors[0].size={kind:'round',diameterFt:1,radiusFt:.5},
  unreciprocated:f=>f.scan.results[4].connectors[0].physicalConnectedTo[0].connectorId=123,
  unknownRefs:f=>f.scan.results[0].connectors[0].referenceScanComplete=false,
  truncated:f=>f.scan.connectorScanTruncatedElementCount=1,
  foreignStateIdentity:f=>f.scan.teeReplacementState.owners[0].uniqueId='foreign',
  duplicateAffected:f=>f.affected.push(f.affected[0]),
  wrongMode:f=>f.input.body.connectionMode='takeoff_fitting',
  dryRun:f=>f.apply.dryRun=true,
  verificationDisabled:f=>f.input.body.verify=false,
  applyOnly:f=>delete f.scan.teeReplacementState,
};
for(const[name,change]of Object.entries(negatives))test('replacement refuses '+name,()=>{const f=teeTakeoffFixture();change(f);assert.equal(matches(f),false);});
