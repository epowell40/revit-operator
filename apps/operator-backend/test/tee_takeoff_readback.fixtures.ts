import {inlineAccessoryFixture} from './inline_accessory_readback.fixtures.js';
// Synthetic expected producer contracts. Not an assertion that Revit has yet
// completed this replacement, and never used for live model credit.
export function teeTakeoffFixture(){
  const port=(id:number,origin:number[],direction:number[],type='End'):any=>({connectorId:id,connectorIdBasis:'revit_native_connector_id',connectorType:type,
    origin,domain:'DomainHvac',shape:'Round',size:{kind:'round',diameterFt:.5,radiusFt:.25},coordinateSystem:{basisZ:direction},referenceScanComplete:true,
    referenceReadErrorCount:0,physicalConnectionCount:0,isConnected:false,isPhysicallyConnected:false,connectedTo:[],physicalConnectedTo:[]});
  const e=(id:number,category:string,typeId:number,connectors:any[]):any=>({id,category,typeId,typeName:'Standard',ok:true,connectors,
    connectorCount:connectors.length,returnedConnectorCount:connectors.length,connectorScanTruncated:false});
  const first=e(10,'OST_DuctCurves',110,[port(0,[0,0,0],[-1,0,0]),port(1,[4,0,0],[1,0,0])]);
  const second=e(20,'OST_DuctCurves',110,[port(0,[6,0,0],[-1,0,0]),port(1,[10,0,0],[1,0,0])]);
  const branch=e(30,'OST_FlexDuctCurves',130,[port(0,[5,.5,0],[0,-1,0]),port(1,[5,5,0],[0,1,0])]);
  const bridge=e(50,'OST_DuctCurves',110,[port(0,[4,0,0],[-1,0,0]),port(1,[6,0,0],[1,0,0]),port(2,[5,0,0],[0,1,0],'Curve')]);
  const fitting=e(60,'OST_DuctFitting',160,[port(0,[5,0,0],[0,-1,0]),port(1,[5,.5,0],[0,1,0])]);
  const remote=[e(1000,'OST_DuctCurves',110,[port(0,[0,0,0],[1,0,0])]),e(1001,'OST_DuctCurves',110,[port(0,[10,0,0],[-1,0,0])]),e(1002,'OST_DuctFitting',160,[port(0,[5,5,0],[0,-1,0])])];
  const connect=(a:any,ai:number,b:any,bi:number)=>{
    const ref=(o:any,c:any)=>({ownerId:o.id,ownerCategory:o.category,connectorId:c.connectorId,connectorIdBasis:c.connectorIdBasis,
      connectorType:c.connectorType,origin:[...c.origin],domain:c.domain,isMepSystem:false,isPhysicalElement:true,isConnectedTo:true});
    for(const[c,r]of [[a.connectors[ai],ref(b,b.connectors[bi])],[b.connectors[bi],ref(a,a.connectors[ai])]]){
      c.connectedTo.push(r);c.physicalConnectedTo.push(structuredClone(r));c.physicalConnectionCount++;c.isConnected=c.isPhysicallyConnected=true;
    }
  };
  connect(first,0,remote[0],0);connect(second,1,remote[1],0);connect(branch,1,remote[2],0);
  const retained=(o:any)=>o.connectors.flatMap((c:any)=>c.physicalConnectedTo.map((r:any)=>({connectorId:c.connectorId,connectorIdBasis:c.connectorIdBasis,origin:c.origin,
    connectedOwnerId:r.ownerId,connectedConnectorId:r.connectorId,connectedConnectorIdBasis:r.connectorIdBasis,connectedOrigin:r.origin})));
  const retainedConnections=Object.fromEntries([first,second,branch].map(o=>[o.id,retained(o)]));
  connect(first,1,bridge,0);connect(second,0,bridge,1);connect(branch,0,fitting,1);connect(bridge,2,fitting,0);
  const identity=(elementId:number)=>({elementId,uniqueId:'u'+elementId});
  const owner=(o:any,points:number[][],geometryKind='Line'):any=>({...identity(o.id),typeId:o.typeId,state:{UniqueId:'u'+o.id,
    metadata:{type:o.typeId,phase:1,demolished:-1,workset:1,systemType:o.category==='OST_DuctFitting'?null:701,level:2,diameter:o.category==='OST_DuctFitting'?null:.5},
    parameters:'[]',geometryKind,points,ports:o.connectors.map((p:any)=>({id:p.connectorId,origin:[...p.origin],direction:[...p.coordinateSystem.basisZ],shape:p.shape}))}});
  const current=[owner(first,[[0,0,0],[4,0,0]]),owner(second,[[6,0,0],[10,0,0]]),owner(branch,[[5,.5,0],[5,3,0],[5,5,0]],'FlexDuct'),
    owner(bridge,[[4,0,0],[6,0,0]]),owner(fitting,[[5,0,0],[0,0,0]],'Point')];
  const old=current.slice(0,3).map(o=>structuredClone(o));old[2].state.points[0]=[5,1,0];old[2].state.ports[0].origin=[5,1,0];
  const tee=e(40,'OST_DuctFitting',140,[port(0,[4,0,0],[-1,0,0]),port(1,[6,0,0],[1,0,0]),port(2,[5,1,0],[0,1,0])]);old.push(owner(tee,[[5,0,0],[0,0,0]],'Point'));
  const types=[110,130,140,160].map(n=>({...identity(n),parameters:'[]',familyName:'Round Takeoff',typeName:'Standard'}));
  const center=(id:number,parent:number)=>({...identity(id),parentId:parent,parentUniqueId:'u'+parent,className:'Autodesk.Revit.DB.Element',categoryId:-2008001,schemaGuids:[],parameters:[],parentParameters:[]});
  const schedules=inlineAccessoryFixture().apply.preservationBefore.schedulePreservation;
  schedules.requestedElementIds=[900];schedules.items[0].elementId=900;schedules.items[0].uniqueId='native-schedule-900';schedules.items[0].definition.identity.id=900;schedules.items[0].definition.identity.uniqueId='native-schedule-900';
  const makeState=(owners:any[],after:boolean):any=>({schema:'operator.tee_takeoff_replacement_state.v1',scope:'active_document_public_semantic_projection',complete:true,
    requestedElementIds:owners.map(o=>o.elementId),requestedAdditionalTypeIds:types.map(t=>t.elementId),requestedRemovedIds:after?[40,41]:[],
    removed:after?[{elementId:40,exists:false,uniqueId:null},{elementId:41,exists:false,uniqueId:null}]:[],owners,types:structuredClone(types),
    centerlines:after?[center(11,10),center(51,50),center(61,60)]:[center(11,10),center(41,40)],schedulePreservation:structuredClone(schedules),
    system:{...identity(700),className:'Autodesk.Revit.DB.Mechanical.MechanicalSystem',typeId:701,typeUniqueId:'u701',parameters:'[]',typeParameters:'[]',
      members:[identity(1002)],network:[...owners.map(o=>identity(o.elementId)),...remote.map(o=>identity(o.id))]}});
  const before=makeState(old,false),after=makeState(current,true),results=[first,second,branch,bridge,fitting];
  const scan:any={status:'Ok',filter:'allConnectors',requestedCount:5,scannedElementCount:5,matchedElementCount:5,failedElementCount:0,
    unknownPhysicalConnectorCount:0,connectorScanTruncatedElementCount:0,totalScannedConnectorCount:11,physicallyConnectedConnectorCount:11,openPhysicalConnectorCount:0,
    results,teeReplacementState:after};for(const o of results)o.openPhysicalConnectorCount=0;
  const apply:any={connectionMode:'replace_tee_with_takeoff',applied:true,dryRun:false,postChildCommitVerified:true,teeElementId:40,mainElementId:10,secondMainElementId:20,branchElementId:30,
    createdBridgeId:50,createdFittingId:60,mainConnectorId:1,secondMainConnectorId:0,branchConnectorId:0,branchConnector:{connectorId:0,connectorIdBasis:'revit_native_connector_id',origin:[5,1,0]},
    bridgeStart:[4,0,0],bridgeEnd:[6,0,0],branchOffsetFt:1,retainedConnections,preservationBefore:before,preservationAfter:structuredClone(after),
    transaction:{status:'committed',committed:true,added_element_ids:[50,60,51,61],deleted_element_ids:[40,41],modified_element_ids:[10,20,30,700,900],affected_element_ids:[10,20,30,40,41,50,51,60,61,700,900]},
    changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,captureFailureCount:0,matchingEventCount:1,distinctWrapperMatchCount:1}};
  const input:any={method:'POST',path:'/revit/connect-existing-mep-branch',body:{connectionMode:'replace_tee_with_takeoff',kind:'duct',expectedModelPath:'C:\\fixtures\\model.rvt',teeElementId:40,
    mainElementId:10,secondMainElementId:20,branchElementId:30,branchConnectorId:0,expectedBranchOriginXyz:[5,1,0],expectedTakeoffTypeId:160,expectedTakeoffFamilyName:'Round Takeoff',expectedTakeoffTypeName:'Standard',dryRun:false,verify:true}};
  return {input,apply,scan,affected:apply.transaction.affected_element_ids.map((n:number)=>`element_id:${n}`)};
}
