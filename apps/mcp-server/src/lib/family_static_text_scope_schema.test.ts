import test from 'node:test';import assert from 'node:assert/strict';
import {familyStaticTextScopeSchemaV1} from './family_static_text_scope_schema.js';
const scope={kind:'family_static_text_v1',category:'OST_TitleBlocks',expected_text:'Example firm\nExample address'};
test('shared family content schema allows complete category selector and multiline wording only',()=>{
 assert(familyStaticTextScopeSchemaV1.safeParse(scope).success);
 for(const s of [{...scope,instance_ids:[1]},{...scope,type_ids:[1]},{...scope,family_names:['Cover']},{...scope,verified:true},
  {...scope,expected_count:26},{...scope,expected_text:''},{...scope,expected_text:' x'},{...scope,expected_text:'x\0'},
  {...scope,expected_text:'x'.repeat(2049)},{...scope,category:'OST_bad token'}])assert(!familyStaticTextScopeSchemaV1.safeParse(s).success);
});
