import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {polylineReadbackMatchesV2 as polylineReadbackDraft} from '../src/verification/polyline_readback_v2.js';
import {polylinePhysicalProof} from '../src/verification/polyline_physical_proof_v2.js';

test('direct C44 room exercise cannot verify a right-angle duct connection without an elbow',()=>{
 const {proof}=JSON.parse(fs.readFileSync('test/fixtures/direct-c44-missing-corner-fitting.json','utf8'));
 assert.equal(polylinePhysicalProof(proof),false,'reciprocal native ConnectTo is insufficient at a bend');
});

test('external elbow accepts native trimmed geometry and rejects missing or misplaced fitting proof',()=>{
 const {proof}=JSON.parse(fs.readFileSync('test/fixtures/direct-c44-external-fitting-contract.json','utf8'));
 assert.equal(polylinePhysicalProof(proof),true);
 const changes:Record<string,(p:any)=>void>={
  noFitting:p=>{p.fittingIds=[];p.rows=p.rows.filter((r:any)=>r.category!=='OST_DuctFitting');},
  wrongCorner:p=>p.points[0][0]+=0.1,
  openPolicy:p=>p.endpointPolicy='open',
  missingFitAxes:p=>{for(const c of p.rows[1].connectors)delete c.coordinateSystem;},
  missingPeerAxes:p=>{for(const c of p.rows[1].connectors)for(const refs of [c.connectedTo,c.physicalConnectedTo])for(const r of refs)delete r.coordinateSystem;},
  wrongPeerSize:p=>{for(const c of p.rows[1].connectors)for(const refs of [c.connectedTo,c.physicalConnectedTo])for(const r of refs)r.size={kind:'round',radiusFt:1,diameterFt:2};},
  missingPhysicalEdge:p=>p.rows[1].connectors[0].physicalConnectedTo=[],
 };
 for(const [name,change]of Object.entries(changes)){const p=structuredClone(proof);change(p);assert.equal(polylinePhysicalProof(p),false,name);}
});

test('external rigid duct needs independently read opposing peer axes and matching size',()=>{
 const {proof}=JSON.parse(fs.readFileSync('test/fixtures/direct-c44-missing-corner-fitting.json','utf8'));
 const p={...proof,points:proof.points.slice(1),segmentIds:[1543015],profiles:[proof.profiles[1]],rows:[proof.rows[1]]};
 const c=p.rows[0].connectors.find((c:any)=>c.physicalConnectedTo[0]?.ownerId===1542938);
 const peer=proof.rows[0].connectors.find((c:any)=>c.physicalConnectedTo[0]?.ownerId===1543015);
 for(const r of [c.physicalConnectedTo[0],c.connectedTo.find((r:any)=>r.ownerId===1542938)]){
  r.coordinateSystem=structuredClone(peer.coordinateSystem);r.shape=peer.shape;r.size=structuredClone(peer.size);
 }
 assert.equal(polylinePhysicalProof(p),false,'actual approximately right-angle native axes');
 const straight=structuredClone(p);
 const sc=straight.rows[0].connectors.find((c:any)=>c.physicalConnectedTo[0]?.ownerId===1542938);
 for(const r of [sc.physicalConnectedTo[0],sc.connectedTo.find((r:any)=>r.ownerId===1542938)])r.coordinateSystem.basisZ=sc.coordinateSystem.basisZ.map((v:number)=>-v);
 assert.equal(polylinePhysicalProof(straight),true,'synthetic straight neighbor with independent peer-axis evidence');
});

test('retained C44 six-duct branch verifies L4 by independent native level name and ID',()=>{
 const fixture=JSON.parse(fs.readFileSync('test/fixtures/c44-level-name-polyline-readback.json','utf8'));
 const matches=(f:any)=>polylineReadbackDraft(f.input,f.apply,f.parameters,f.connectors);
 assert.equal(matches(fixture),true);
 const both=structuredClone(fixture);both.input.body.levelId=1362791;assert.equal(matches(both),true);
 const changes:Record<string,(f:any)=>void>={
  missingLevel:f=>delete f.input.body.levelName,
  blankLevel:f=>f.input.body.levelName=' ',
  wrongName:f=>f.input.body.levelName='L3',
  wrongExplicitId:f=>f.input.body.levelId=123,
  missingDetails:f=>delete f.parameters.items[0].parameterDetails,
  conflictingDetails:f=>f.parameters.items[0].parameterDetails.push({...f.parameters.items[0].parameterDetails.find((p:any)=>p.name==='Reference Level')}),
  wrongStorage:f=>f.parameters.items[0].parameterDetails.find((p:any)=>p.name==='Reference Level').storageType='String',
  wrongDetailName:f=>f.parameters.items[0].parameterDetails.find((p:any)=>p.name==='Reference Level').valueString='L3',
  wrongDetailId:f=>f.parameters.items[0].parameterDetails.find((p:any)=>p.name==='Reference Level').value='0',
  inconsistentAcrossDucts:f=>{const p=f.parameters.items[1];p.parameters['Reference Level']='99';p.parameterDetails.find((p:any)=>p.name==='Reference Level').value='99';},
  disconnected:f=>f.connectors.results[0].connectors[0].physicalConnectedTo=[],
  differentSize:f=>f.input.body.diameter='8 in',
  cannotClaimWholeConnectedSystem:f=>f.input.body.requireExistingEndpointConnections=true,
 };
 for(const [name,change]of Object.entries(changes)){const f=structuredClone(fixture);change(f);assert.equal(matches(f),false,name);}
});
test('source-derived branch geometry with synthetic intent and native apply identities; not live qualification',()=>{
const base='test/fixtures/';
const {proof}=JSON.parse(fs.readFileSync(base+'c44-polyline-source-geometry.json','utf8'));
const body={kind:'duct',apply:true,verify:true,routingMode:'polyline',connectSegments:true,connectToExisting:true,requireExistingEndpointConnections:true,
 sizePolicy:'explicit_required',elevationPolicy:'explicit_required',levelId:123,ductTypeId:proof.rows[0].typeId,systemType:'Supply Air',ductShape:'round',
 ductSize:String(proof.profiles[0].diameter*12),points:proof.points.map((xyz:number[])=>({xyz}))};
const input={path:'/revit/mep-route-workflow',body};
const apply={applyResult:{createdElementIds:proof.segmentIds,createdFittingIds:proof.fittingIds,segments:proof.segmentIds.map((id:number,index:number)=>({id,index}))}};
const parameters={items:proof.rows.map((r:any)=>({id:r.id,parameters:{'Reference Level':123,'System Classification':'Supply Air',Diameter:proof.profiles[0].diameter}}))};
const connectors={status:'Ok',requestedCount:3,scannedElementCount:3,matchedElementCount:3,failedElementCount:0,connectorScanTruncatedElementCount:0,
 totalScannedConnectorCount:6,openPhysicalConnectorCount:0,physicallyConnectedConnectorCount:6,results:proof.rows};
const fixture:any={input,apply,parameters,connectors};
assert.equal(polylineReadbackDraft(input,apply,parameters,connectors),true);
const mutations:Record<string,(f:any)=>void>={
 wrongReferencePort:f=>f.connectors.results[0].connectors[0].physicalConnectedTo[0].connectorId++,
 logicalReference:f=>f.connectors.results[0].connectors[0].physicalConnectedTo[0].connectorType='Logical',
 nativeDisconnected:f=>f.connectors.results[0].connectors[0].physicalConnectedTo[0].isConnectedTo=false,
 wrongReferenceOrigin:f=>f.connectors.results[0].connectors[0].physicalConnectedTo[0].origin[0]++,
 wrongLevel:f=>f.parameters.items[0].parameters['Reference Level']=124,
 wrongType:f=>f.connectors.results[0].typeId=999,
 wrongName:f=>f.input.body.ductType='unrelated',
 wrongSize:f=>f.parameters.items[0].parameters.Diameter+=1,
 missingParameter:f=>f.parameters.items.pop(),
 duplicateParameter:f=>f.parameters.items[2]=f.parameters.items[0],
 duplicateSegmentIndex:f=>f.apply.applyResult.segments[1].index=0,
 wrongApplyIds:f=>f.apply.applyResult.createdElementIds=[55,56],
 unknownEffect:f=>f.input.body.deleteExisting=true,
 pixels:f=>f.input.body.points[0]={u:0.5,v:0.5},
 incompleteCounts:f=>f.connectors.totalScannedConnectorCount=4,
 disconnected:f=>f.connectors.results[2].connectors[0].physicalConnectedTo=[],
 conflictingSizeAliases:f=>f.input.body.diameter='12',
 absentMandatoryConnection:f=>f.input.body.connectToExisting=false,
 badSegmentSizeCount:f=>f.input.body.segmentSizes=['8'],
 staleTypeName:f=>f.input.body.ductType='other type',
 falseLevelDisplay:f=>f.input.body.levelName='L4',
 failedRead:f=>f.parameters.items[2].error='native failure'
};
for(const[name,change]of Object.entries(mutations)){const f=structuredClone(fixture);change(f);assert.equal(polylineReadbackDraft(f.input,f.apply,f.parameters,f.connectors),false,name);}
const one=structuredClone(fixture);
one.input.body.points=one.connectors.results[0].connectors.map((c:any)=>({xyz:c.origin}));
one.input.body.connectSegments=false;
one.apply.applyResult={createdElementIds:[proof.segmentIds[0]],createdFittingIds:[],segments:[{index:0,id:proof.segmentIds[0]}]};
one.parameters.items=one.parameters.items.slice(0,1);
one.connectors={...one.connectors,requestedCount:1,scannedElementCount:1,matchedElementCount:1,totalScannedConnectorCount:2,physicallyConnectedConnectorCount:2,results:one.connectors.results.slice(0,1)};
assert.equal(polylineReadbackDraft(one.input,one.apply,one.parameters,one.connectors),true,'single connected round segment using retained native ports');
const open=structuredClone(one);
open.input.body.connectToExisting=false;open.input.body.requireExistingEndpointConnections=false;
open.connectors.openPhysicalConnectorCount=2;open.connectors.physicallyConnectedConnectorCount=0;
open.connectors.results[0].openPhysicalConnectorCount=2;
for(const c of open.connectors.results[0].connectors){c.connectedTo=[];c.physicalConnectedTo=[];c.physicalConnectionCount=0;c.isPhysicallyConnected=false;c.isConnected=false;}
assert.equal(polylineReadbackDraft(open.input,open.apply,open.parameters,open.connectors),true,'synthetic open construction stage with retained native geometry');
const disconnectedBatch=structuredClone(fixture);disconnectedBatch.input.body.connectSegments=false;
assert.equal(polylineReadbackDraft(disconnectedBatch.input,disconnectedBatch.apply,disconnectedBatch.parameters,disconnectedBatch.connectors),false,'multi-segment batches require explicit internal joining');
});
