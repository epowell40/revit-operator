import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {storeEvidence,retrieveEvidence} from '../src/evidence/evidence_store.js';
import {assembleBoundedEvidenceContext,assertBoundedModelEvidencePayload} from '../src/evidence/model_context_budget.js';
import {adaptMcpToolCallResultToDynamicResponse} from '../src/brains/codex_dynamic_result_adapter.js';
const scope={session_id:'ports-session',assignment_id:'ports-assignment',run_id:'ports-run',generation:1};
function isolated(t:any){const previous=process.env.OPERATOR_WORKSPACE_ROOT;const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connector-geometry-'));process.env.OPERATOR_WORKSPACE_ROOT=dir;
 t.after(()=>{if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});}
function locationRow(table:any,index:number):any{return Object.fromEntries(table.columns.map((key:string,i:number)=>[key,table.rows[index][i]]));}
function fixture(){
 const peer=(ownerId:number,connectorId:number)=>({ownerId,connectorId,connectorIdBasis:'revit_native_connector_id',connectorType:'End',domain:'DomainHvac',isMepSystem:false,isPhysicalElement:true,isConnectedTo:true});
 const port=(id:number,origin:number[],other:any)=>({connectorId:id,connectorIdBasis:'revit_native_connector_id',connectorType:'End',domain:'DomainHvac',shape:'Round',origin,size:{kind:'round',diameterFt:2/3,radiusFt:1/3},systemClassification:'SupplyAir',
  isConnected:true,physicalConnectionCount:1,isPhysicallyConnected:true,physicalConnectionState:'connected',referenceScanComplete:true,referenceReadErrorCount:0,connectedTo:[other],physicalConnectedTo:[other],coordinateSystem:{unneededDetails:'retained'.repeat(2000)}});
 return {status:'Ok',filter:'allConnectors',requestedCount:2,scannedElementCount:2,failedElementCount:0,matchedElementCount:2,totalScannedConnectorCount:2,physicallyConnectedConnectorCount:2,openPhysicalConnectorCount:0,unknownPhysicalConnectorCount:0,connectorScanTruncatedElementCount:0,
  results:[{id:10,ok:true,connectorScanTruncated:false,connectorCount:1,returnedConnectorCount:1,connectors:[port(1,[1,2,3],peer(20,2))]},
   {id:20,ok:true,connectorScanTruncated:false,connectorCount:1,returnedConnectorCount:1,connectors:[port(2,[4,5,6],peer(10,1))]}]};
}

test('a branch of eighteen terminals delivers exact placement values through the bounded actor input',t=>{isolated(t);const raw:any=fixture();
 raw.results=Array.from({length:18},(_,i)=>({...raw.results[0],id:1000000+i,
  elementLocation:{status:'observed',kind:'point',coordinateSpace:'document_internal',lengthUnits:'feet',point:[18.689999999999998+i,-17.50000000000002,41.433333333625804],rotationRadians:2.094395102392891},
  connectors:[{...raw.results[0].connectors[0],connectedTo:[{...raw.results[0].connectors[0].connectedTo[0],ownerId:2000000+i}],physicalConnectedTo:[{...raw.results[0].connectors[0].physicalConnectedTo[0],ownerId:2000000+i}]}]}));
 raw.requestedCount=raw.scannedElementCount=raw.matchedElementCount=raw.totalScannedConnectorCount=raw.physicallyConnectedConnectorCount=18;
 const before=JSON.stringify(raw),stored=storeEvidence({scope,source:'native:branch_locations',trust_level:'authoritative_native',raw});
 const graph=stored.projection.connector_graph!,table=graph.element_locations!;assert(table);assert.equal(table.rows.length,18);
 for(let i=0;i<18;i++){const row=locationRow(table,i);assert.equal(row.owner,1000000+i);assert.equal(row.source_row,i);assert.deepEqual(row.point,raw.results[i].elementLocation.point);assert.equal(row.rotationRadians,2.094395102392891);}
 assert.equal(graph.totals.boundary_references,18);assert.equal(graph.lists.boundary_references.length,18);assert.equal(graph.lists_complete,true);assert.equal(graph.coverage.whole_model_complete,null);
 const context=assembleBoundedEvidenceContext({...scope,projections:[stored.projection],budget:{item_bytes:8192,request_bytes:32768}});
 const response=adaptMcpToolCallResultToDynamicResponse({content:[{type:'text',text:JSON.stringify(raw)}]},{tool:'revit_call_tool',projections:context.projections,omitted:context.omitted});
 const text=(response.contentItems[0] as any).text;assertBoundedModelEvidencePayload({type:'function_call_output',output:text});
 assert.deepEqual(JSON.parse(text).evidence_projections[0].connector_graph.element_locations,table);assert.equal(JSON.stringify(raw),before);assert(stored.projection.projected_bytes<=8192);
});

test('mixed partial point and curve columns preserve null uncertainty and omit ambiguous owners',t=>{isolated(t);const raw:any=fixture();
 raw.results[0].elementLocation={status:'partial',kind:'point',coordinateSpace:'document_internal',lengthUnits:'feet',point:[0,0,0],rotationStatus:'unavailable'};
 raw.results[1].elementLocation={status:'partial',kind:'curve',coordinateSpace:'document_internal',lengthUnits:'feet',isBound:false};
 let table=storeEvidence({scope,source:'native:mixed_locations',trust_level:'authoritative_native',raw}).projection.connector_graph!.element_locations!;
 assert.deepEqual(locationRow(table,0).point,[0,0,0]);assert.equal(locationRow(table,0).isBound,null);assert.equal(locationRow(table,1).point,null);
 assert.equal(locationRow(table,1).endpointsStatus,'unavailable_unbounded');assert.equal(locationRow(table,1).scope,'endpoints_only_not_full_curve');assert.equal(locationRow(table,1).rotationStatus,null);
 raw.results.push({...raw.results[0]});raw.requestedCount=raw.scannedElementCount=raw.matchedElementCount=3;raw.totalScannedConnectorCount=3;
 table=storeEvidence({scope,source:'native:duplicate_locations',trust_level:'authoritative_native',raw}).projection.connector_graph!.element_locations!;
 assert(!table.rows.some(row=>row[table.columns.indexOf('owner')]===10));
});

test('element placement reaches the actor alongside ports without confusing their distinct origins',t=>{isolated(t);const raw:any=fixture();
 raw.results[0].elementLocation={status:'observed',kind:'point',coordinateSpace:'document_internal',lengthUnits:'feet',point:[0.5,2,3],rotationRadians:Math.PI};
 raw.results[1].elementLocation={status:'observed',kind:'line',coordinateSpace:'document_internal',lengthUnits:'feet',start:[4,5,6],end:[7,8,9],isBound:true};
 const stored=storeEvidence({scope,source:'native:placement',trust_level:'authoritative_native',raw});
 const locations=(stored.projection.connector_graph as any)?.element_locations;assert(locations,'Placement facts must survive the normal bounded projection');
 assert.deepEqual(locationRow(locations,0).point,[0.5,2,3]);assert.equal(locationRow(locations,0).rotationRadians,Math.PI);assert.equal(locationRow(locations,0).owner,10);
 assert.deepEqual(locationRow(locations,1).end,[7,8,9]);assert.equal(locationRow(locations,1).source_row,1);assert.match(locations.notice,/not connector origins/);
 const context=assembleBoundedEvidenceContext({...scope,projections:[stored.projection],budget:{item_bytes:8192,request_bytes:32768}});
 const response=adaptMcpToolCallResultToDynamicResponse({content:[{type:'text',text:JSON.stringify(raw)}]},{tool:'revit_call_tool',projections:context.projections,omitted:context.omitted});
 const text=(response.contentItems[0] as any).text;assertBoundedModelEvidencePayload({type:'function_call_output',output:text});
 assert.deepEqual(JSON.parse(text).evidence_projections[0].connector_graph.element_locations,locations);
});

test('partial and older location reads cannot become invented coordinates or placement proofs',t=>{isolated(t);const raw:any=fixture();
 raw.results[0].elementLocation={status:'partial',kind:'point',coordinateSpace:'document_internal',lengthUnits:'feet',point:[1,2,3],rotationStatus:'unavailable'};
 let locations=(storeEvidence({scope,source:'native:partial_placement',trust_level:'authoritative_native',raw}).projection.connector_graph as any).element_locations;
 assert.equal(locationRow(locations,0).status,'partial');assert.equal(locationRow(locations,0).rotationStatus,'unavailable');assert.equal(locationRow(locations,0).rotationRadians,undefined);
 assert.equal(locationRow(locations,1).status,'not_reported');
 raw.results[0].elementLocation.point=[1,null,3];raw.results[0].elementLocation.rotationRadians=Infinity;
 locations=(storeEvidence({scope,source:'native:invalid_placement',trust_level:'authoritative_native',raw}).projection.connector_graph as any).element_locations;
 assert.equal(locationRow(locations,0).status,'unavailable');assert.equal(locationRow(locations,0).point,undefined);
});

test('location table is optional and never displaces existing graph data or trusts foreign envelopes',t=>{isolated(t);const raw:any=fixture();
 raw.results.forEach((r:any)=>r.elementLocation={status:'unavailable',reason:'no_supported_location'});
 const normal:any=storeEvidence({scope,source:'native:location_normal',trust_level:'authoritative_native',raw},8192).projection;
 const tiny:any=storeEvidence({scope,source:'native:location_small',trust_level:'authoritative_native',raw},4096).projection;
 assert(normal.connector_graph.element_locations);assert(tiny.projected_bytes<=4096);assert.deepEqual(tiny.connector_graph.lists.reciprocal_edges,normal.connector_graph.lists.reciprocal_edges);
 assert.equal(storeEvidence({scope,source:'untrusted:location',trust_level:'host_observed',raw}).projection.connector_graph,undefined);
 const legacy:any=fixture();assert.equal((storeEvidence({scope,source:'native:legacy_location',trust_level:'authoritative_native',raw:legacy}).projection.connector_graph as any).element_locations,undefined);
});
test('connected port geometry reaches the normal bounded model consumer with exact owner/connector/source indices',t=>{isolated(t);const raw=fixture(),before=JSON.stringify(raw);
 const stored=storeEvidence({scope,source:'native:connector_geometry',trust_level:'authoritative_native',raw});
 const g:any=stored.projection.connector_graph;assert(g?.connector_geometry,'Connected endpoint geometry must not require another retained-evidence read');
 assert.deepEqual(g.lists.reciprocal_edges,[[10,1,20,2,0]]);assert.equal(g.totals.open_hvac_endpoints,0);
 assert.equal(g.connector_geometry.projected_rows_complete,true);assert.equal(g.connector_geometry.native_rows_complete,true);
 assert.equal(g.connector_geometry.units,'internal_feet');assert.equal(g.connector_geometry.rows.length,2);
 const cols=g.connector_geometry.columns,values=Object.fromEntries(cols.map((k:string,i:number)=>[k,g.connector_geometry.rows[1][i]]));
 assert.equal(values.owner,20);assert.equal(values.native_connector,2);assert.equal(values.source_row,1);assert.deepEqual(values.origin,[4,5,6]);
 assert.equal(values.shape,'Round');assert.equal(values.size[g.connector_geometry.size_columns.indexOf('diameter_ft')],2/3);assert.equal(values.physical_state,'connected');
 const context=assembleBoundedEvidenceContext({...scope,projections:[stored.projection],budget:{item_bytes:8192,request_bytes:32768}});
 const response=adaptMcpToolCallResultToDynamicResponse({content:[{type:'text',text:JSON.stringify(raw)}]},{tool:'revit_call_tool',projections:context.projections,omitted:context.omitted});
 const text=(response.contentItems[0] as any).text;assertBoundedModelEvidencePayload({type:'function_call_output',output:text});
 assert.deepEqual(JSON.parse(text).evidence_projections[0].connector_graph.connector_geometry,g.connector_geometry);
 const retained=retrieveEvidence({scope,evidence_id:stored.ref.evidence_id,fields:['results[1].connectors[0].coordinateSystem'],max_bytes:32768,purpose:'Inspect full retained port coordinates'});
 assert(JSON.stringify(retained.selection).includes(raw.results[1].connectors[0].coordinateSystem.unneededDetails));
 assert.equal(JSON.stringify(raw),before);assert(stored.projection.projected_bytes<=8192);
});
test('unknown geometry and physical reference checks stay unknown rather than inferred from topology',t=>{isolated(t);const raw:any=fixture();const c=raw.results[0].connectors[0];c.origin=[1,null,3];c.size=null;c.shape=null;c.physicalConnectionState='unknown';c.referenceScanComplete=false;c.referenceReadErrorCount=1;
 const g:any=storeEvidence({scope,source:'native:unknown_geometry',trust_level:'authoritative_readback',raw}).projection.connector_graph;
 const cols=g.connector_geometry.columns,row=g.connector_geometry.rows.find((r:any[])=>r[0]===10),v=Object.fromEntries(cols.map((k:string,i:number)=>[k,row[i]]));
 assert.equal(v.origin,null);assert.equal(v.size,null);assert.equal(v.shape,null);assert.equal(v.physical_state,'unknown');
 assert.equal(g.coverage.native_reference_scan_complete,false);
});
test('untrusted or ambiguous envelopes gain no native geometry projection',t=>{isolated(t);const raw=fixture();
 for(const trust_level of ['untrusted_caller','host_observed'] as const)assert.equal(storeEvidence({scope,source:'untrusted:ports',trust_level,raw}).projection.connector_graph,undefined);
 const ambiguous={structuredContent:raw,content:[{type:'text',text:JSON.stringify({...raw,requestedCount:3})}]};
 assert.equal(storeEvidence({scope,source:'native:ambiguous_ports',trust_level:'authoritative_native',raw:ambiguous}).projection.connector_graph,undefined);
});
test('geometry is an optional whole-table accelerator and cannot crowd topology out of a small budget',t=>{isolated(t);const raw=fixture();
 const normal:any=storeEvidence({scope,source:'native:ports_normal',trust_level:'authoritative_native',raw},8192).projection;
 const tiny:any=storeEvidence({scope,source:'native:ports_tiny',trust_level:'authoritative_native',raw},4096).projection;
 assert(normal.connector_graph.connector_geometry);
 assert(tiny.projected_bytes<=4096);assert.deepEqual(tiny.connector_graph.lists.reciprocal_edges,normal.connector_graph.lists.reciprocal_edges);
 if(tiny.connector_graph.connector_geometry)assert.equal(tiny.connector_graph.connector_geometry.projected_rows_complete,true);
});

test('sixteen connected ports fit the normal model item without sacrificing topology',t=>{isolated(t);const raw:any=fixture();
 raw.results=Array.from({length:8},(_,i)=>({...raw.results[i%2],id:100+i,connectorCount:2,returnedConnectorCount:2,connectors:[0,1].map(j=>({...raw.results[i%2].connectors[0],connectorId:j,
  origin:[123.1234567890123+i,456.1234567890123+j,10.33333333333333],size:{kind:'round',radiusFt:1/3,diameterFt:2/3},
  connectedTo:[{...raw.results[i%2].connectors[0].connectedTo[0],ownerId:100+(i^1),connectorId:j}],
  physicalConnectedTo:[{...raw.results[i%2].connectors[0].physicalConnectedTo[0],ownerId:100+(i^1),connectorId:j}]}))}));
 raw.requestedCount=raw.scannedElementCount=raw.matchedElementCount=8;raw.totalScannedConnectorCount=16;
 const p=storeEvidence({scope,source:'native:many_connected_ports',trust_level:'authoritative_native',raw}).projection;
 assert(p.connector_graph?.connector_geometry);assert.equal(p.connector_graph.connector_geometry.rows.length,16);
 assert.equal(p.connector_graph.coverage.native_reference_scan_complete,true);assert.equal(p.connector_graph.totals.reciprocal_edges,8);assert(p.projected_bytes<=8192);
 assert.equal(p.connector_graph.connector_geometry.projected_rows_complete,true);
});
