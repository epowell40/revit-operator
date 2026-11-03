import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { nativeReadEvidence } from "./nativeReadEvidence.js";

const ids=(facts:ReturnType<typeof nativeReadEvidence>)=>facts.map(fact=>fact.fact_id);
const complete=(route:string,body:unknown,payload:unknown)=>nativeReadEvidence(route,body,payload).find(fact=>fact.fact_id==="collection.total")?.value;

test("retained442 active-document collector graph establishes positive observation only",()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../operator-backend/test/fixtures/native-collector-read442.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  assert.deepEqual(nativeReadEvidence('/revit/native-api-ops',fixture.request,fixture.response),[fixture.expected_model_fact]);
});

test("collector observation requires traced current document, preceding collector handles and native receiver identity",()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../operator-backend/test/fixtures/native-collector-read442.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  for(const variant of ['foreign_document','wrong_constructor','wrong_constructor_receipt','broken_filter','future_reference','wrong_filter_type','wrong_filter_result','wrong_first','first_arguments','wrong_preview_id','wrong_preview_uid','foreign_receiver','missing_receivers','wrong_receiver_type','external','cleanup','mutation','short_receipts','missing_result'] as const){
    const body=structuredClone(fixture.request),raw=structuredClone(fixture.response);
    if(variant==='foreign_document')body.operations[0].target='other_document';
    if(variant==='wrong_constructor'){body.operations[1].memberId='ctor:System.Object()';raw.operations[1].member_id=body.operations[1].memberId;}
    if(variant==='wrong_constructor_receipt')raw.operations[1].result_preview.type='System.Object';
    if(variant==='broken_filter')body.operations[3].target='$active_document';
    if(variant==='future_reference')body.operations[1].args=[{$ref:'duct'}];
    if(variant==='wrong_filter_type')raw.operations[2].target_type='Autodesk.Revit.DB.Document';
    if(variant==='wrong_filter_result')raw.operations[2].result_preview.type='Autodesk.Revit.DB.Element';
    if(variant==='wrong_first'){body.operations[4].memberId='method:System.Object.ToString()';raw.operations[4].member_id=body.operations[4].memberId;}
    if(variant==='first_arguments')body.operations[4].args=[42];
    if(variant==='wrong_preview_id')raw.operations[4].result_preview.id=42;
    if(variant==='wrong_preview_uid')raw.operations[4].result_preview.unique_id='foreign';
    if(variant==='foreign_receiver')raw.operations[5].target_identity.active_document=false;
    if(variant==='missing_receivers')raw.operations.forEach((r:any)=>r.target_identity=null);
    if(variant==='wrong_receiver_type')raw.operations[5].target_identity.type_name='System.String';
    if(variant==='external')raw.source={scope:'external_file'};
    if(variant==='cleanup')raw.geometry_cleanup_errors=['not closed'];
    if(variant==='mutation')raw.read_only=false;
    if(variant==='short_receipts')raw.operations.pop();
    if(variant==='missing_result')delete raw.results.length;
    assert.deepEqual(nativeReadEvidence('/revit/native-api-ops',body,raw),[],variant);
  }
  assert.deepEqual(nativeReadEvidence('/revit/native-api-mutation-ops',fixture.request,fixture.response),[]);
});

test("retained417 native graph element receivers establish observation without claiming collection completeness",()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../operator-backend/test/fixtures/native-graph-read417.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  assert.deepEqual(nativeReadEvidence('/revit/native-api-ops',fixture.request,fixture.response),[fixture.expected_model_fact]);
});

test("native graph observation rejects metadata, foreign or mismatched receipts and incomplete results",()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../operator-backend/test/fixtures/native-graph-read417.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  const route='/revit/native-api-ops';
  for(const variant of ['failed','mutation','version','missing_receiver','foreign','wrong_uid','wrong_id','wrong_type','wrong_member','wrong_op','short_receipts','duplicate_ids','wrong_count','missing_result','extra_result','wrong_request','cleanup','external'] as const){
    const body=structuredClone(fixture.request),raw=structuredClone(fixture.response);
    if(variant==='failed')raw.ok=false;
    if(variant==='mutation')raw.read_only=false;
    if(variant==='version')raw.version='operator.native_api_mutation_ops.v1';
    if(variant==='missing_receiver')raw.operations.forEach((r:any)=>r.target_identity=null);
    if(variant==='foreign')raw.operations[1].target_identity.active_document=false;
    if(variant==='wrong_uid')raw.operations[0].result_preview.unique_id='foreign';
    if(variant==='wrong_id')raw.operations[0].result_preview.id=-1;
    if(variant==='wrong_type')raw.operations[1].target_identity.type_name='System.String';
    if(variant==='wrong_member')raw.operations[1].member_id='other';
    if(variant==='wrong_op')raw.operations[1].op='construct';
    if(variant==='short_receipts')raw.operations.pop();
    if(variant==='duplicate_ids')body.operations[1].id=body.operations[0].id;
    if(variant==='wrong_count')raw.operation_count++;
    if(variant==='missing_result')delete raw.results.leader_count;
    if(variant==='extra_result')raw.results.unrequested='text';
    if(variant==='wrong_request')body.operations[0].args=[43];
    if(variant==='cleanup')raw.geometry_cleanup_errors=['failed'];
    if(variant==='external')raw.source={scope:'external_file'};
    assert.deepEqual(nativeReadEvidence(route,body,raw),[],variant);
  }
  assert.deepEqual(nativeReadEvidence('/revit/native-api-mutation-ops',fixture.request,fixture.response),[]);
  assert.deepEqual(nativeReadEvidence('/revit/inspect-family-content',{filePath:'family.rfa'},
    {ok:true,source:{scope:'external_file'},labels:[{driverParameters:['Mark','Flow']}]}),[]);
  // Native default returns only the final operation; it does not certify a list.
  const body=structuredClone(fixture.request),raw=structuredClone(fixture.response);
  delete body.returns;raw.results={owner_view_name:raw.results.owner_view_name};
  assert.deepEqual(ids(nativeReadEvidence(route,body,raw)),['model.content_observed']);
});

test("retained HVAC and link inventories have separate query identities, not contradictory route totals",()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../operator-backend/test/fixtures/ui-inventory-scope-collision.json',import.meta.url),'utf8'));
  const totals=fixture.cases.map((entry:any)=>nativeReadEvidence('/revit/find-elements',entry.request.input.body,entry.payload)
    .find(fact=>fact.fact_id==='collection.total'));
  assert.deepEqual(totals.map((fact:any)=>fact.value),[7,6]);
  assert.ok(totals.every((fact:any)=>typeof fact.dimensions.query_scope==='string'));
  assert.notEqual(totals[0].dimensions.query_scope,totals[1].dimensions.query_scope);
  for(let index=0;index<totals.length;index++)assert.equal(totals[index].dimensions.query_scope,fixture.expected_query_scopes[index]);
});

test("same element query keeps its identity across count changes, category order, defaults, and presentation limits",()=>{
  const payload={status:'Ok',count:1,elementIds:[42],items:[{id:42}],itemsComplete:true,truncated:false,scanCapReached:false,identityExpansionScanCapReached:false};
  const scope=(body:unknown,result:unknown=payload)=>nativeReadEvidence('/revit/find-elements',body,result).find(f=>f.fact_id==='collection.total')?.dimensions?.query_scope;
  const query={categories:['OST_DuctCurves','OST_DuctFitting'],physicalElementsOnly:true};
  const expected=scope(query);
  assert.equal(typeof expected,'string');
  assert.equal(scope({...query,categories:['OST_DuctFitting','OST_DuctCurves','OST_DuctCurves'],limit:2000,includeGeometry:true,topLevelInstancesOnly:false}),expected);
  assert.equal(scope({category:'OST_DuctCurves',categories:['OST_DuctFitting'],physicalElementsOnly:true}),expected);
  assert.equal(scope({...query,requestId:'another-id',timestamp:'later',ignoredNativeField:'noise'}),expected,'ignored JSON fields cannot hide a real count disagreement');
  assert.equal(scope(query,{...payload,count:2,elementIds:[42,43],items:[{id:42},{id:43}]}),expected,'result cardinality must never create a new query scope');
  for(const body of [{...query,viewId:99},{...query,physicalElementsOnly:false},{...query,familyNameContains:'HRU'}])assert.notEqual(scope(body),expected);
  const identityTerms=['one','two','three','four','five','six','seven','eight','nine'];
  const bounded=scope({...query,identityTerms});
  assert.notEqual(scope({...query,identityTerms:[...identityTerms].reverse()}),bounded,'native keeps the first eight distinct terms before applying the filter');
  assert.equal(scope({...query,identityTerms:[...identityTerms.slice(0,8),'ignored ninth']}),bounded);
  assert.equal(scope({...query,identityTerms:[' ONE ',...identityTerms]}),bounded,'native deduplicates case-insensitively before the eight-term cap');
});

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

test("view-owned detailing requires exact independent source and copy inventories before declaring completeness",()=>{
  const item=(elementId:number,ownerViewId:number)=>({elementId,ownerViewId,uniqueId:`uid-${elementId}`,className:"TextNote",
    isAnnotation:true,semanticSignatureComplete:true,semanticSignature:`sha256:${"a".repeat(64)}`});
  const inventory=(id:number,elementId:number)=>({view:{id,uniqueId:`view-${id}`,name:id===11?"L4":"M-COORDINATION COPY",viewType:"FloorPlan"},
    limit:1000,totalOwnedCount:1,annotationCount:1,returnedCount:1,truncated:false,unreadableCount:0,
    unclassifiedCount:0,incompleteTextCount:0,incompleteSignatureCount:0,itemsComplete:true,items:[item(elementId,id)]});
  const request={viewIds:[11,12]},route="/revit/view-owned-detailing";
  const payload={schema:"revit-operator.view-owned-detailing/v1",documentTitle:"Sample",scope:"exact_owner_view",
    requestedViewIds:[11,12],viewsComplete:true,views:[inventory(11,21),inventory(12,22)]};
  assert.equal(complete(route,request,payload),2);
  assert.deepEqual(nativeReadEvidence(route,request,{...payload,views:[payload.views[0],{...payload.views[1],
    items:[{...item(22,12),semanticSignatureComplete:false}]}]}),[]);
  assert.deepEqual(nativeReadEvidence(route,request,{...payload,views:[payload.views[0],{...payload.views[1],
    annotationCount:0}]}),[]);
  assert.deepEqual(nativeReadEvidence(route,request,{...payload,views:[payload.views[0],{...payload.views[1],
    items:[item(22,11)]}]}),[]);
  assert.deepEqual(nativeReadEvidence(route,request,{...payload,requestedViewIds:[12,11]}),[]);
  assert.deepEqual(nativeReadEvidence(route,request,{...payload,views:[payload.views[0],{...payload.views[1],
    totalOwnedCount:2,truncated:true,itemsComplete:false}],viewsComplete:false}).map(f=>f.fact_id),["model.content_observed"]);
  assert.deepEqual(nativeReadEvidence(route,request,{...payload,views:[payload.views[0],{...payload.views[1],
    totalOwnedCount:2,truncated:true,itemsComplete:false}],viewsComplete:true}),[]);
});

test("complete detailing inventories exclude only native non-drafting infrastructure from signature requirements",()=>{
  const route="/revit/view-owned-detailing",request={viewIds:[11]};
  const item={elementId:21,ownerViewId:11,uniqueId:"uid-21",className:"SketchPlane",isAnnotation:false,
    comparisonExcluded:true,semanticSignatureComplete:false,semanticSignature:null};
  const payload={schema:"revit-operator.view-owned-detailing/v1",scope:"exact_owner_view",requestedViewIds:[11],viewsComplete:true,
    views:[{view:{id:11,uniqueId:"view-11",name:"Copy",viewType:"FloorPlan"},limit:1000,
      totalOwnedCount:1,annotationCount:0,returnedCount:1,truncated:false,unreadableCount:0,
      unclassifiedCount:0,incompleteTextCount:0,incompleteSignatureCount:0,itemsComplete:true,items:[item]}]};
  const withItem=(replacement:object)=>({...payload,views:[{...payload.views[0],items:[replacement]}]});
  for(const infrastructure of [item,{...item,className:"SunAndShadowSettings"},
    {...item,className:"Element",name:"ExtentElem"},{...item,className:"Element",builtInCategory:"OST_SunStudy"}])
    assert.equal(complete(route,request,withItem(infrastructure)),1);
  for(const invalid of [{...item,className:"DetailCurve"},{...item,isAnnotation:true},
    {...item,comparisonExcluded:false},{...item,semanticSignatureComplete:true},
    {...item,semanticSignature:`sha256:${"a".repeat(64)}`}])
    assert.deepEqual(nativeReadEvidence(route,request,withItem(invalid)),[]);
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
