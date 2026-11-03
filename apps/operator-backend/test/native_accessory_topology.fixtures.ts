// Synthetic native-shaped contracts; no live placement evidence.
export function fixture(kind:'duct'|'pipe'='duct',count=1,keep:'start'|'end'|'neither'='start',zeroLength=false){
  const domain=kind==='duct'?'DomainHvac':'DomainPiping',curve=kind==='duct'?'OST_DuctCurves':'OST_PipeCurves';
  const accessory=kind==='duct'?'OST_DuctAccessory':'OST_PipeAccessory',fitting=kind==='duct'?'OST_DuctFitting':'OST_PipeFitting';
  const owner=(id:number,category:string,typeId:number,x:number,y:number):any=>({id,category,typeId,ok:true,connectorScanTruncated:false,
    connectors:[x,y].map((n,i)=>({connectorId:i,connectorIdBasis:'revit_native_connector_id',connectorType:'End',origin:[n,0,0],domain,
      shape:'Round',size:{kind:'round',radiusFt:.25,diameterFt:.5},coordinateSystem:{basisZ:[i?1:-1,0,0]},
      referenceScanComplete:true,referenceReadErrorCount:0,physicalConnectedTo:[],connectedTo:[]}))});
  const connect=(a:any,ai:number,b:any,bi:number)=>{
    for(const [from,to,other] of [[a.connectors[ai],b.connectors[bi],b],[b.connectors[bi],a.connectors[ai],a]]){
      const r={ownerId:other.id,ownerCategory:other.category,connectorId:to.connectorId,connectorIdBasis:to.connectorIdBasis,
        connectorType:to.connectorType,origin:[...to.origin],domain,isMepSystem:false,isPhysicalElement:true,isConnectedTo:true};
      from.physicalConnectedTo.push(r);from.connectedTo.push(structuredClone(r));
    }
  };
  const scan=(results:any[])=>{
    let total=0,open=0;for(const o of results){o.connectorCount=o.returnedConnectorCount=o.connectors.length;
      o.openPhysicalConnectorCount=0;for(const c of o.connectors){c.physicalConnectionCount=c.physicalConnectedTo.length;
        c.isConnected=c.isPhysicallyConnected=!!c.physicalConnectionCount;if(!c.isConnected)o.openPhysicalConnectorCount++;total++;}
      open+=o.openPhysicalConnectorCount;}
    return {status:'Ok',filter:'allConnectors',requestedCount:results.length,scannedElementCount:results.length,matchedElementCount:results.length,
      failedElementCount:0,unknownPhysicalConnectorCount:0,connectorScanTruncatedElementCount:0,totalScannedConnectorCount:total,
      openPhysicalConnectorCount:open,physicallyConnectedConnectorCount:total-open,results};
  };
  const left=owner(40,fitting,140,-1,0),right=owner(50,fitting,150,10,11),host=owner(10,curve,110,0,10);
  connect(left,1,host,0);connect(host,1,right,0);const before=scan([left,host,right]);
  const l=owner(40,fitting,140,-1,0),r=owner(50,fitting,150,10,11),chain:any[]=[],placed:number[]=[],added:number[]=[];
  let end=0;
  for(let i=0;i<=count;i++){
    const next=i===count?10:(i+1)*10/(count+1)-Math.min(.5,5/(count+1))/2;
    const sid=keep==='start'&&i===0||keep==='end'&&i===count?10:100+i;
    chain.push(owner(sid,curve,110,end,next));if(sid!==10)added.push(sid);
    if(i<count){const aid=200+i;placed.push(aid);added.push(aid);end=next+(zeroLength?0:Math.min(.5,5/(count+1)));chain.push(owner(aid,accessory,130,next,end));}
  }
  connect(l,1,chain[0],0);for(let i=1;i<chain.length;i++)connect(chain[i-1],1,chain[i],0);connect(chain.at(-1),1,r,0);
  return {before,after:scan([l,...chain,r]),hosts:[10],placed,added,typeId:130,kind,scan,owner,connect};
}
