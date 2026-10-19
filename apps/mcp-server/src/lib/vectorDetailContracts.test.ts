import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';
import {preflightKnownGenericToolBody} from './genericToolPreflight.js';import {isSupportedNativeTool} from './supportedToolInventory.js';
const contracts=JSON.parse(readFileSync(new URL('../../../revit-bridge-addin/RevitBridge.Common/Contracts/conditional-requests.v1.json',import.meta.url),'utf8'));
const hash='a'.repeat(64),request={sourcePath:'artifacts/uploads/detail.pdf',expectedSourceSha256:hash,nativePlanPath:`artifacts/drafting-vector/source-${hash}.json.gz`,
 expectedNativePlanFileSha256:hash,expectedNativePlanSha256:hash,viewName:'Copied diagram'};
test('withheld vector import retains immutable source/plan schema and owned continuation checks',()=>{
 const check=(body:unknown)=>preflightKnownGenericToolBody({method:'POST',path:'/revit/import-vector-detail',request_schema:contracts['/revit/import-vector-detail']},body);
 for(const body of [request,{...request,partIndex:0},{...request,partIndex:1,manifestElementId:123,expectedImportSnapshotSha256:hash}])assert.equal(check(body),null);
 for(const body of [{...request,sourcePath:'C:/outside.pdf'},{...request,nativePlanPath:'artifacts/uploads/plan.json'},
  {...request,expectedSourceSha256:undefined},{...request,expectedNativePlanFileSha256:'short'},{...request,partIndex:1},
  {...request,manifestElementId:123},{...request,partIndex:2000,manifestElementId:123,expectedImportSnapshotSha256:hash},{...request,viewId:4}])
  assert.equal(check(body)?.request_dispatched,false,JSON.stringify(body));
 assert.equal(isSupportedNativeTool('POST','/revit/import-vector-detail'),false);assert.equal(isSupportedNativeTool('GET','/revit/import-vector-detail'),false);
});
test('vector discovery and summary cannot pose as complete part or record-page inspection',()=>{
 const check=(body:unknown)=>preflightKnownGenericToolBody({method:'POST',path:'/revit/inspect-vector-detail',request_schema:contracts['/revit/inspect-vector-detail']},body);
 for(const body of [{action:'list'},{manifestElementId:123},{manifestElementId:123,partIndex:0},
  {manifestElementId:123,partIndex:0,includeItems:true,offset:10,limit:5}])assert.equal(check(body),null,JSON.stringify(body));
 for(const body of [{action:'list',manifestElementId:123},{manifestElementId:123,includeItems:true},{manifestElementId:123,offset:10},
  {manifestElementId:123,partIndex:2000},{manifestElementId:123,limit:101},{manifestElementId:123,apply:true}])assert.equal(check(body)?.request_dispatched,false,JSON.stringify(body));
 assert.equal(isSupportedNativeTool('POST','/revit/inspect-vector-detail'),true);assert.equal(isSupportedNativeTool('POST','/revit/inspect-vector-detail-other'),false);
});
