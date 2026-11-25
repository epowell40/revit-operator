import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLifecycleReceiptEffectV1,nativeLifecycleResultEffectV2} from '@revitoperator/assignment-kernel-v2-contracts';
import {isSupportedToolRoute} from '../src/capabilities/supported_tool_inventory.js';
import {isAllowlisted} from '../src/allowlist.js';
const receipt={schema:'revit-operator.native-lifecycle.v1',path:'/revit/sync',action:'sync',document_session_id:'1'.repeat(32),
 native_call_attempted:true,native_call_returned:true,transaction_ownership:'revit_api',status:'returned'};
test('CAD reload cannot borrow Revit-link transaction-free settlement',()=>{
 for(const action of ['load','reload'])assert.equal(nativeLifecycleReceiptEffectV1({...receipt,path:'/revit/link-cad',action},'POST','/revit/link-cad','apply'),null);
});
test('essential lifecycle routes reach the supported inventory and allowlist',()=>{
 for(const path of ['/revit/sync','/revit/link-revit','/revit/link-cad']){
  assert.equal(isSupportedToolRoute('POST',path),true);assert.equal(isAllowlisted('POST',path),true);
  assert.equal(isSupportedToolRoute('GET',path),false);
 }
});
test('native lifecycle requires exact route, action, document and returned native call',()=>{
 assert.equal(nativeLifecycleReceiptEffectV1(receipt,'POST','/revit/sync','apply'),'applied');
 for(const patch of [{native_call_returned:false},{native_call_attempted:false},{document_session_id:''},{document_session_id:'0'.repeat(32)},
  {status:'unknown'},{action:'delete'},{path:'/revit/link-cad'},{transaction_ownership:'actor'}])
  assert.equal(nativeLifecycleReceiptEffectV1({...receipt,...patch},'POST','/revit/sync','apply'),null);
 assert.equal(nativeLifecycleReceiptEffectV1(receipt,'POST','/revit/sync','preview'),null);
 assert.equal(nativeLifecycleReceiptEffectV1(receipt,'GET','/revit/sync','apply'),null);
});
test('lifecycle result is transaction-free but cannot claim task verification',()=>{
 const result={authority:'native-host',dispatch_state:'dispatched',native_transaction_state:'not_applicable',
 observation_required:true,raw_payload_hash:'a'.repeat(64),request_identity:{method:'POST',path:'/revit/sync'},
 result_schema_id:'operator-native/POST:/revit/sync/v2',persistent_effect:'applied',native_lifecycle_receipt:receipt};
 assert.equal(nativeLifecycleResultEffectV2(result),'applied');
 for(const patch of [{authority:'model'},{dispatch_state:'not_dispatched'},{raw_payload_hash:''},{native_transaction_state:'committed'},
 {observation_required:false},{persistent_effect:'none'},{result_schema_id:'other'}])assert.equal(nativeLifecycleResultEffectV2({...result,...patch}),null);
});
