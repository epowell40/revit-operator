import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {preflightKnownGenericToolBody} from './genericToolPreflight.js';
import {isSupportedNativeTool} from './supportedToolInventory.js';

const contracts=JSON.parse(readFileSync(new URL('../../../revit-bridge-addin/RevitBridge.Common/Contracts/conditional-requests.v1.json',import.meta.url),'utf8'));
const request={sourcePath:'uploads/table.xlsx',sheetName:'Output',expectedSourceSha256:'a'.repeat(64),viewName:'Output Table'};
test('Excel table import admits source-bound first and continuation parts but rejects guessed or redirected continuation',()=>{
 const check=(body:unknown)=>preflightKnownGenericToolBody({method:'POST',path:'/revit/import-excel-output',request_schema:contracts['/revit/import-excel-output']},body);
 for(const body of [request,{...request,layout:{repeatHeaderRows:3,pageHeightInches:25}},
  {...request,partIndex:1,manifestElementId:123,expectedImportSnapshotSha256:'b'.repeat(64)}])assert.equal(check(body),null);
 for(const body of [{...request,expectedSourceSha256:undefined},{...request,partIndex:1},{...request,manifestElementId:123},
  {...request,viewId:4},{...request,layout:{maximumDigitWidthPixels:1}},{...request,borderWeights:{medium:17}}])
  assert.equal(check(body)?.request_dispatched,false,JSON.stringify(body));
 assert.equal(isSupportedNativeTool('POST','/revit/import-excel-output'),true);
 assert.equal(isSupportedNativeTool('POST','/revit/import-excel-table'),false);
});
test('Excel part summary and paged details are distinct from import discovery and require exact cursor binding',()=>{
 const check=(body:unknown)=>preflightKnownGenericToolBody({method:'POST',path:'/revit/inspect-excel-import',request_schema:contracts['/revit/inspect-excel-import']},body);
 const read={sourcePath:request.sourcePath,manifestElementId:123};
 for(const body of [{action:'list'},read,{...read,partIndex:0},{...read,partIndex:0,section:'notes',pageOffset:10,expectedInspectionSnapshotSha256:'c'.repeat(64)}])
  assert.equal(check(body),null,JSON.stringify(body));
 for(const body of [{action:'list',sourcePath:'x'},{...read,section:'notes'},{...read,partIndex:0,pageOffset:10},{...read,partIndex:0,dryRun:false},{...read,partIndex:0,pageSize:101}])
  assert.equal(check(body)?.request_dispatched,false,JSON.stringify(body));
 assert.equal(isSupportedNativeTool('POST','/revit/inspect-excel-import'),true);
 assert.equal(isSupportedNativeTool('GET','/revit/inspect-excel-import'),false);
 assert.equal(isSupportedNativeTool('POST','/revit/inspect-excel-import-other'),false);
});
