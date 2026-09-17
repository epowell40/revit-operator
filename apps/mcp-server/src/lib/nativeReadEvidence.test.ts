import assert from "node:assert/strict";
import test from "node:test";
import { nativeReadEvidence } from "./nativeReadEvidence.js";

const ids=(facts:ReturnType<typeof nativeReadEvidence>)=>facts.map(fact=>fact.fact_id);
const complete=(route:string,body:unknown,payload:unknown)=>nativeReadEvidence(route,body,payload).find(fact=>fact.fact_id==="collection.total")?.value;

test("model contents require a recognized native object read; document labels and API property prose do not qualify",()=>{
  for(const route of ["/revit/context","/revit/native-api-ops","/revit/tool-registry","/revit/native-api-catalog"])
    assert.deepEqual(nativeReadEvidence(route,{}, {documentTitle:"Mechanical Controls",projectNumber:"123-M",total:17,items:[{id:1,category:"Ducts"}]}),[]);
  assert.ok(ids(nativeReadEvidence("/revit/quantify",{categories:["Ducts"]},{summary:{total:24,groups:{Ducts:24}}})).includes("model.content_observed"));
  assert.ok(!ids(nativeReadEvidence("/revit/views",{},[{id:1,name:"Mechanical Controls"}])).includes("model.content_observed"));
});

test("quantify counts preserve zero and reject malformed or conflicting count aliases",()=>{
  assert.equal(complete("/revit/quantify",{}, {summary:{total:0},rows:[]}),0);
  assert.equal(complete("/revit/quantify",{}, {totalCount:17,summary:{total:17}}),17);
  for(const payload of [{total:-1},{total:1.5},{total:"17"},{total:Infinity},{total:17,totalCount:18},{total:NaN,summary:{total:17}},{total:17,summary:{total:18}}])
    assert.deepEqual(nativeReadEvidence("/revit/quantify",{},payload),[]);
});

test("bounded element searches establish positive presence but never a complete count or absence",()=>{
  const payload={status:"Ok",count:1,elementIds:[42],items:[{id:42,category:"Ducts"}],itemsComplete:false,truncated:true,scanCapReached:false,identityExpansionScanCapReached:false};
  assert.deepEqual(ids(nativeReadEvidence("/revit/find-elements",{},payload)),["model.content_observed"]);
  assert.deepEqual(nativeReadEvidence("/revit/find-elements",{},{...payload,count:0,elementIds:[],items:[]}),[]);
  assert.equal(complete("/revit/find-elements",{},{...payload,itemsComplete:true,truncated:false}),1);
  assert.deepEqual(nativeReadEvidence("/revit/find-elements",{},{...payload,count:2,elementIds:[42,42]}),[]);
});

test("view, room and schedule collections retain their actual native truncation limits",()=>{
  assert.equal(complete("/revit/views",{},[]),0);
  assert.equal(complete("/revit/rooms",{action:"list"},[{id:7}]),1);
  assert.equal(complete("/revit/rooms",{action:"list",max:1},[{id:7}]),undefined);
  assert.equal(complete("/revit/rooms",{action:"detail",roomIds:[7]},[{id:7}]),undefined);
  assert.equal(complete("/revit/schedules",{action:"list",max:2},{status:"Ok",action:"list",returned:1,items:[{id:8}]}),1);
  assert.equal(complete("/revit/schedules",{action:"list",max:1},{status:"Ok",action:"list",returned:1,items:[{id:8}]}),undefined);
  assert.deepEqual(nativeReadEvidence("/revit/views",{},[{id:7},{id:7}]),[]);
});

test("targeted native object attributes and connectors do not require a duplicate inventory read",()=>{
  const parameters={id:42,category:"Ducts",parameters:{Width:"1",Height:"0.5"}};
  assert.deepEqual(ids(nativeReadEvidence("/revit/get-parameters",{elementId:42},parameters)),["model.content_observed"]);
  assert.deepEqual(nativeReadEvidence("/revit/get-parameters",{elementId:43},parameters),[]);
  assert.deepEqual(nativeReadEvidence("/revit/get-parameters",{elementId:42},{...parameters,category:null}),[]);
  const summary={id:42,found:true,category:"Ducts",location:{type:"curve"}};
  assert.deepEqual(ids(nativeReadEvidence("/revit/get-element-summary",{elementIds:[42]},[summary])),["model.content_observed"]);
  for(const row of [{...summary,found:false},{...summary,id:43},{...summary,location:null}])
    assert.deepEqual(nativeReadEvidence("/revit/get-element-summary",{elementIds:[42]},[row]),[]);
  const connector={id:42,ok:true,returnedConnectorCount:1,connectors:[{origin:{x:1,y:2,z:3}}]};
  assert.deepEqual(ids(nativeReadEvidence("/revit/get-connectors",{elementIds:[42]},{status:"Ok",results:[connector]})),["model.content_observed"]);
  for(const row of [{...connector,id:43},{...connector,ok:false},{...connector,returnedConnectorCount:2},{...connector,returnedConnectorCount:0,connectors:[]}])
    assert.deepEqual(nativeReadEvidence("/revit/get-connectors",{elementIds:[42]},{status:"Ok",results:[row]}),[]);
});
