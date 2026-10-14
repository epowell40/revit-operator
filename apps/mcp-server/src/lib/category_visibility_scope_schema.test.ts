import test from 'node:test';import assert from 'node:assert/strict';
import {categoryVisibilityScopeSchemaV1} from './category_visibility_scope_schema.js';
const scope={kind:'category_visibility_v1',category:'OST_DataDevices',disciplines:['Electrical'],view_types:['FloorPlan'],hidden:true,sheet_ids:[42]};
test('native category visibility scope schema accepts hidden and shown states, with optional complete sheet domains',()=>{
 assert.deepEqual(categoryVisibilityScopeSchemaV1.parse(scope),scope);
 assert(categoryVisibilityScopeSchemaV1.safeParse({...scope,hidden:false}).success);
 const {sheet_ids,...whole}=scope;assert(categoryVisibilityScopeSchemaV1.safeParse(whole).success);
});
test('schema refuses result claims, explicit view subset shortcuts, coerced states and invalid sheet ids',()=>{
 for(const value of [{...scope,verified:true},{...scope,view_ids:[1]},{...scope,hidden:'true'},{...scope,sheet_ids:[]},{...scope,sheet_ids:[0]},
  {...scope,disciplines:[]},{...scope,view_types:['DrawingSheet']},{...scope,sheet_ids:[42,42]},
  {...scope,category:'OST_bad token'},{...scope,disciplines:['Electrical','Electrical']}])assert(!categoryVisibilityScopeSchemaV1.safeParse(value).success);
});
