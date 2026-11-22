import test from 'node:test';import assert from 'node:assert/strict';
import {projectConnectorWorkGuidance,AIR_TERMINAL_CONNECTION_GUIDANCE}from'./connectorWorkGuidance.js';
import{nativeReadEvidence}from'./nativeReadEvidence.js';
import {DYNAMIC_REVIT_NATIVE_GUIDE} from './dynamicRevitSdkGuide.js';
const row=(id=42)=>({id,ok:true,category:'OST_DuctTerminal',connectorCount:1,returnedConnectorCount:1,connectorScanTruncated:false,
 connectors:[{domain:'DomainHvac',connectorType:'End',shape:'Rectangular',physicalConnectionState:'open',referenceScanComplete:true,referenceReadErrorCount:0,physicalConnectedTo:[]}]});
const payload=()=>({status:'Ok',results:[row()],canonical_attempt_settlement:{method:'POST',path:'/revit/get-connectors',requested_effect:'read',effect_state:'none'}});
test('native code discovery and multi-terminal readback expose bounded native attachment batches',()=>{
 const p={...payload(),results:[row(42),row(43)]},request={elementIds:[42,43]};
 const view=projectConnectorWorkGuidance(p,request) as any;
 for(const text of [DYNAMIC_REVIT_NATIVE_GUIDE,view.operator_connection_guidance.message]) {
  assert.match(text,/MechanicalUtils\.ConnectAirTerminalOnDuct/);
  assert.match(text,/bounded.*batch/i);
  assert.match(text,/reciprocal physical/i);
 }
 assert.deepEqual(nativeReadEvidence('/revit/get-connectors',request,view),nativeReadEvidence('/revit/get-connectors',request,p));
 assert.equal(view.operator_connection_guidance.connection_verified,false);
});
test('open-terminal advice preserves all native evidence and makes no compatibility or connection claim',()=>{
 const p=payload(),before=structuredClone(p),request={elementIds:[42]},view=projectConnectorWorkGuidance(p,request) as any;
 assert.deepEqual(p,before);for(const k of Object.keys(p))assert.deepEqual(view[k],p[k as keyof typeof p]);
 assert.deepEqual(view.operator_connection_guidance.element_ids,[42]);assert.equal(view.operator_connection_guidance.authority,'discovery_only');
 assert.equal(view.operator_connection_guidance.compatibility_verified,false);assert.equal(view.operator_connection_guidance.connection_verified,false);
 assert.match(AIR_TERMINAL_CONNECTION_GUIDANCE,/shapes alone/);assert.match(AIR_TERMINAL_CONNECTION_GUIDANCE,/air_terminal_on_duct/);
 assert.deepEqual(nativeReadEvidence('/revit/get-connectors',request,view),nativeReadEvidence('/revit/get-connectors',request,p));
});
test('failed, foreign, unknown, truncated and non-terminal reads do not gain the advice',()=>{
 const variants:Array<(p:any)=>void>=[p=>p.status='Failed',p=>delete p.canonical_attempt_settlement,p=>p.canonical_attempt_settlement.effect_state='unknown',
  p=>p.canonical_attempt_settlement.path='/revit/other',p=>p.results[0].id=99,p=>p.results[0].ok=false,p=>p.results[0].category='OST_PipeAccessory',
  p=>p.results[0].connectorScanTruncated=true,p=>p.results[0].returnedConnectorCount=2,p=>p.results[0].connectorCount=0,
  p=>p.results[0].connectors[0].domain='DomainPiping',p=>p.results[0].connectors[0].connectorType='Logical',p=>p.results[0].connectors[0].physicalConnectionState='unknown',
  p=>p.results[0].connectors[0].physicalConnectionState='connected',p=>p.results[0].connectors[0].referenceScanComplete=false,
  p=>p.results[0].connectors[0].referenceReadErrorCount=1,p=>p.results[0].connectors[0].isPhysicallyConnected=true,
  p=>p.results[0].connectors[0].physicalConnectedTo=[{ownerId:13}]];
 for(const mutate of variants){const p=payload();mutate(p);assert.equal(projectConnectorWorkGuidance(p,{elementIds:[42]}),p);}
 for(const r of [null,{}, {elementIds:[]},{elementIds:[42,42]},{elementIds:['42']}]){const p=payload();assert.equal(projectConnectorWorkGuidance(p,r),p);}
 for(const p of [null,{},'open port'])assert.equal(projectConnectorWorkGuidance(p,{elementIds:[42]}),p);
});
test('advice remains bounded and scoped to returned rows, including filtered connector reads',()=>{
 const p={...payload(),results:Array.from({length:12},(_,i)=>row(42+i))};const v=projectConnectorWorkGuidance(p,{elementIds:p.results.map(r=>r.id)}) as any;
 assert.equal(v.operator_connection_guidance.element_ids.length,8);assert.equal(v.operator_connection_guidance.omitted_count,4);
 const filtered=payload();filtered.results[0].connectorCount=2;assert((projectConnectorWorkGuidance(filtered,{elementIds:[42]}) as any).operator_connection_guidance);
});
