import test from 'node:test';import assert from 'node:assert/strict';
import {validateSheetExportScope as check} from './sheet_export_scope.mjs';
test('an all-sheets request cannot be fulfilled by the active E101 sheet or an absent scope',()=>{
 for(const selection of [undefined,{kind:'active_view_fallback',count:1}]){
  assert.match(check({all:true},{selectedCount:1,selection}),/not confirmed/);
  assert.match(check({},{selectedCount:1,selection}),/not confirmed/);
 }
 assert.equal(check({all:false},{selectedCount:1,selection:{kind:'active_view_fallback',count:1}}),'');
 assert.match(check({all:false,sheet_number_prefix:'E'},{selectedCount:1,selection:{kind:'active_view_fallback',count:1}}),/not confirmed/);
});
test('complete native collections and named print sets retain their actual scope',()=>{
 assert.equal(check({},{selectedCount:4,selection:{kind:'selector',count:4,matchedCount:4,truncated:false}}),'');
 assert.equal(check({print_set_name:'Permit'},{selectedCount:2,selection:{kind:'print_set',count:2}}),'');
 assert.match(check({},{selectedCount:1,selection:{kind:'selector',count:4}}),/does not match/);
});
test('an implicit safety cap cannot silently stand for the complete set',()=>{
 const selection={kind:'selector',count:500,matchedCount:501,truncated:true};
 assert.match(check({},{selectedCount:500,selection}),/500 of 501/);
 for(const max of [0,-1,500.5,'garbage'])assert.match(check({max},{selectedCount:500,selection}),/500 of 501/);
 assert.equal(check({max:500},{selectedCount:500,selection}),'','an explicitly bounded request keeps its reported partial scope');
 for(const matchedCount of [499,500.5,'501'])assert.match(check({},{selectedCount:500,selection:{...selection,matchedCount}}),/inconsistent/);
 assert.match(check({},{selectedCount:500,selection:{...selection,truncated:false}}),/inconsistent/);
});
