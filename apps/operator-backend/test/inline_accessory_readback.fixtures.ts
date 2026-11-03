// Synthetic producer-shaped contracts, not a live native insertion receipt.
export function inlineAccessoryFixture() {
  const connector=(id:number,x:number,direction:number):any=>({connectorId:id,connectorIdBasis:'revit_native_connector_id',
    connectorType:'End',origin:[x,0,0],domain:'DomainHvac',shape:'Round',size:{kind:'round',diameterFt:.5,radiusFt:.25},
    coordinateSystem:{basisZ:[direction,0,0]},referenceScanComplete:true,referenceReadErrorCount:0,
    physicalConnectionCount:0,isConnected:false,isPhysicallyConnected:false,connectedTo:[],physicalConnectedTo:[]});
  const owner=(id:number,category:string,type:number,ends:number[]):any=>({id,category,typeId:type,ok:true,
    connectorCount:2,returnedConnectorCount:2,connectorScanTruncated:false,
    connectors:[connector(0,ends[0]!,-1),connector(1,ends[1]!,1)]});
  const host=owner(10,'OST_DuctCurves',110,[0,1.75]),split=owner(20,'OST_DuctCurves',110,[2.25,4]);
  const accessory=owner(30,'OST_DuctAccessory',130,[1.75,2.25]);
  const left=owner(40,'OST_DuctFitting',140,[-1,0]),right=owner(50,'OST_FlexDuctCurves',150,[4,6]);
  const connect=(a:any,ai:number,b:any,bi:number)=>{
    const ref=(o:any,c:any)=>({ownerId:o.id,ownerCategory:o.category,connectorId:c.connectorId,connectorIdBasis:c.connectorIdBasis,
      connectorType:'End',origin:[...c.origin],domain:'DomainHvac',isMepSystem:false,isPhysicalElement:true,isConnectedTo:true});
    for(const [c,r] of [[a.connectors[ai],ref(b,b.connectors[bi])],[b.connectors[bi],ref(a,a.connectors[ai])]]) {
      c.connectedTo.push(r);c.physicalConnectedTo.push(structuredClone(r));c.physicalConnectionCount++;c.isConnected=c.isPhysicallyConnected=true;
    }
  };
  connect(host,0,left,1);connect(host,1,accessory,0);connect(split,0,accessory,1);connect(split,1,right,0);
  const results=[host,split,accessory,left,right];
  const scan:any={status:'Ok',filter:'allConnectors',requestedCount:5,scannedElementCount:5,matchedElementCount:5,
    failedElementCount:0,unknownPhysicalConnectorCount:0,connectorScanTruncatedElementCount:0,
    totalScannedConnectorCount:10,physicallyConnectedConnectorCount:8,openPhysicalConnectorCount:2,results};
  for(const r of results) r.openPhysicalConnectorCount=r.connectors.filter((c:any)=>!c.isPhysicallyConnected).length;
  const metadata=(type:number)=>({type,phase:1,demolished:-1,workset:1,systemType:99,level:2,diameter:.5});
  const state=(o:any,points:number[][],kind='Line'):any=>({elementId:o.id,uniqueId:`native-owner-unique-${o.id}`,typeId:o.typeId,
    state:{UniqueId:`native-owner-unique-${o.id}`,metadata:metadata(o.typeId),parameters:'[]',geometryKind:kind,points,
      ports:o.connectors.map((c:any)=>({id:c.connectorId,origin:[...c.origin],direction:c.coordinateSystem.basisZ,shape:'Round'}))}});
  const current=results.map(o=>state(o,o.connectors.map((c:any)=>[...c.origin]),o===right?'FlexDuct':o===accessory||o===left?'Point':'Line'));
  const original=structuredClone(current.find(o=>o.elementId===10)!);
  original.state.points=[[0,0,0],[4,0,0]];original.state.ports[1].origin=[4,0,0];
  const types=[110,130,140,150].map(elementId=>({elementId,uniqueId:`native-type-unique-${elementId}`,parameters:'[]'}));
  const schedule={schema:'operator.annotation_schedule_read.v1',complete:true,requestedElementIds:[60],items:[{
    elementId:60,uniqueId:'native-schedule-unique-60',complete:true,scope:'flat_definition_table_parameters',parameters:[],
    definition:{schema:'operator.schedule_definition_snapshot.v1',complete:true,identity:{id:60,uniqueId:'native-schedule-unique-60',kind:'regular'}}}]};
  const before:any={schema:'operator.inline_accessory_state.v1',complete:true,requestedElementIds:[10,40,50],
    owners:[original,...structuredClone(current.filter(o=>[40,50].includes(o.elementId)))],types:structuredClone(types),schedulePreservation:structuredClone(schedule)};
  scan.inlineAccessoryState={schema:'operator.inline_accessory_state.v1',complete:true,requestedElementIds:[10,20,30,40,50],
    owners:current,types:structuredClone(types),schedulePreservation:structuredClone(schedule)};
  const edge=(connectorId:number,origin:number,connectedOwnerId:number,connectedConnectorId:number)=>({connectorId,
    connectorIdBasis:'revit_native_connector_id',origin:[origin,0,0],connectedOwnerId,connectedConnectorId,
    connectedConnectorIdBasis:'revit_native_connector_id',connectedOrigin:[origin,0,0]});
  const apply:any={applied:true,dryRun:false,mainElementId:10,mainUniqueId:'native-owner-unique-10',accessoryTypeId:130,
    createdAccessoryId:30,createdDuctId:20,originalStart:[0,0,0],originalEnd:[4,0,0],diameterFt:.5,preservationBefore:before,
    preexistingMainConnections:[edge(0,0,40,1),edge(1,4,50,0)],preexistingRemoteConnections:{40:[edge(1,0,10,0)],50:[edge(0,4,10,1)]},
    transaction:{status:'committed',committed:true,added_element_ids:[20,30],modified_element_ids:[10,40,50,60,130],
      deleted_element_ids:[],affected_element_ids:[10,20,30,40,50,60,130]},
    changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,captureFailureCount:0,matchingEventCount:1,distinctWrapperMatchCount:1}};
  const input:any={method:'POST',path:'/revit/connect-existing-mep-branch',body:{connectionMode:'insert_inline_accessory',kind:'duct',
    expectedModelPath:'C:\\fixtures\\model.rvt',mainElementId:10,expectedMainUniqueId:'native-owner-unique-10',expectedMainStartXyz:[0,0,0],
    expectedMainEndXyz:[4,0,0],accessoryTypeId:130,expectedAccessoryTypeUniqueId:'native-type-unique-130',insertionPointXyz:[2,0,0],
    instanceRadiusParameter:'Duct Radius',dryRun:false}};
  return {input,apply,scan,affected:apply.transaction.affected_element_ids.map((n:number)=>`element_id:${n}`).sort()};
}
