import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {storeEvidence,retrieveEvidence} from '../src/evidence/evidence_store.js';
import {assembleBoundedEvidenceContext,assertBoundedModelEvidencePayload} from '../src/evidence/model_context_budget.js';
import {adaptMcpToolCallResultToDynamicResponse} from '../src/brains/codex_dynamic_result_adapter.js';
const scope={session_id:'ports-session',assignment_id:'ports-assignment',run_id:'ports-run',generation:1};
function isolated(t:any){const previous=process.env.OPERATOR_WORKSPACE_ROOT;const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connector-geometry-'));process.env.OPERATOR_WORKSPACE_ROOT=dir;
 t.after(()=>{if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});}
function fixture(){
 const peer=(ownerId:number,connectorId:number)=>({ownerId,connectorId,connectorIdBasis:'revit_native_connector_id',connectorType:'End',domain:'DomainHvac',isMepSystem:false,isPhysicalElement:true,isConnectedTo:true});
 const port=(id:number,origin:number[],other:any)=>({connectorId:id,connectorIdBasis:'revit_native_connector_id',connectorType:'End',domain:'DomainHvac',shape:'Round',origin,size:{kind:'round',diameterFt:2/3,radiusFt:1/3},systemClassification:'SupplyAir',
  isConnected:true,physicalConnectionCount:1,isPhysicallyConnected:true,physicalConnectionState:'connected',referenceScanComplete:true,referenceReadErrorCount:0,connectedTo:[other],physicalConnectedTo:[other],coordinateSystem:{unneededDetails:'retained'.repeat(2000)}});
 return {status:'Ok',filter:'allConnectors',requestedCount:2,scannedElementCount:2,failedElementCount:0,matchedElementCount:2,totalScannedConnectorCount:2,physicallyConnectedConnectorCount:2,openPhysicalConnectorCount:0,unknownPhysicalConnectorCount:0,connectorScanTruncatedElementCount:0,
  results:[{id:10,ok:true,connectorScanTruncated:false,connectorCount:1,returnedConnectorCount:1,connectors:[port(1,[1,2,3],peer(20,2))]},
   {id:20,ok:true,connectorScanTruncated:false,connectorCount:1,returnedConnectorCount:1,connectors:[port(2,[4,5,6],peer(10,1))]}]};
}
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
