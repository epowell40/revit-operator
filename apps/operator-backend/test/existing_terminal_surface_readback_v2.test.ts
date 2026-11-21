import assert from 'node:assert/strict';import test from 'node:test';
import{existingMepConnectionReadbackMatchesV2 as matches}from '../src/verification/existing_mep_connection_readback_v2.js';
import{existingTerminalSurfaceFixture}from './existing_mep_connection.fixtures.js';
const surface=existingTerminalSurfaceFixture;
const check=(f:ReturnType<typeof surface>,scope?:unknown)=>(matches as any)(f.input,f.affected,f.apply,f.scan,scope);
test('a native reciprocal duct-curve to terminal surface pair need not have coincident centerline and surface ports',()=>{assert.equal(check(surface()),true);});
test('complete host-observed collateral footprint is retained without becoming a connector deliverable',()=>{const f=surface();f.affected.push('element_id:99');Object.assign(f.apply,{transaction:{status:'committed',committed:true,affected_element_ids:[10,20,99],modified_element_ids:[10,20,99],added_element_ids:[],deleted_element_ids:[]}});assert.equal(check(f,{complete_native_footprint:[...f.affected]}),true);assert.equal(check(f),false,'Unproven collateral is still refused');});
test('a complete related peer row can be context without becoming a principal deliverable',()=>{const f=surface(),ref=f.scan.results[0].connectors[0].physicalConnectedTo[0],peer=structuredClone(f.scan.results[1]);peer.id=30;peer.category='OST_DuctCurves';peer.connectors=[{...structuredClone(f.scan.results[0].connectors[0]),connectorId:ref.connectorId,origin:[...ref.origin]}];const p=peer.connectors[0],back={...structuredClone(ref),ownerId:10,ownerCategory:'OST_DuctCurves',connectorId:0,origin:[0,0,0]};p.physicalConnectedTo=[back];p.connectedTo=[structuredClone(back)];peer.connectorCount=peer.returnedConnectorCount=1;peer.openPhysicalConnectorCount=0;f.scan.results.push(peer);f.scan.requestedCount++;f.scan.scannedElementCount++;f.scan.matchedElementCount++;f.scan.totalScannedConnectorCount++;f.scan.physicallyConnectedConnectorCount++;assert.equal(check(f),true);});

test('surface attachment still rejects one-sided, stale-coordinate, distant, incomplete and unproven-footprint claims',()=>{
 for(const change of [
  (f:any)=>f.scan.results[1].connectors[0].physicalConnectedTo[0].isConnectedTo=false,
  (f:any)=>f.scan.results[1].connectors[0].physicalConnectedTo[0].origin[0]+=0.1,
  (f:any)=>f.scan.results[0].connectors[2].referenceScanComplete=false,
  (f:any)=>f.scan.results[1].connectors[0].referenceReadErrorCount=1,
  (f:any)=>f.scan.results[0].connectors[2].size.diameterFt=0.1,
  (f:any)=>f.scan.results[0].connectors[2].shape='Rectangular',
  (f:any)=>f.input.body.connectionMode='takeoff_fitting',
  (f:any)=>f.scan.results[1].connectors[0].physicalConnectedTo[0].connectorId=100,
  (f:any)=>f.scan.results[0].connectors[2].physicalConnectedTo[0].ownerId=99,
  (f:any)=>f.scan.results[0].connectorScanTruncated=true
 ]){const f=surface();change(f);assert.equal(check(f),false);}
 const f=surface();f.affected.push('element_id:99');f.apply.transaction={status:'committed',committed:true,affected_element_ids:[10,20,99],added_element_ids:[],deleted_element_ids:[]};
 assert.equal(check(f,{complete_native_footprint:['element_id:10','element_id:20']}),false);
 for(const key of ['added_element_ids','deleted_element_ids']){const g=structuredClone(f);g.apply.transaction[key]=[99];assert.equal(check(g,{complete_native_footprint:g.affected}),false);}
});

import{verifiedDeliverableTargetGroupsV2}from '../src/verification/verified_deliverable_targets_v2.js';
test('checked terminal attachment credits the terminal alone, not the main, peer context or observed collateral',()=>{
 const f=surface();assert.deepEqual(verifiedDeliverableTargetGroupsV2({} as any,
  {input:f.input,request_identity:{path:f.input.path}} as any,{} as any),[['element_id:20']]);
});
