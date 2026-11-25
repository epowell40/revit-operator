import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {NATIVE_CSHARP_TOOL_SHAPE,NATIVE_CSHARP_TOOL_GUIDE} from './nativeCsharpToolContract.js';

const schema=z.object(NATIVE_CSHARP_TOOL_SHAPE).strict();
const source='public class ReadCount { public static string Execute(Autodesk.Revit.DB.Document doc) { return "read"; } }';
test('one native C# contract accepts custom reads and writes without graph or planning prerequisites',()=>{
 const read={source,mode:'read',native_program:{entry_type:'ReadCount'}};
 assert.deepEqual(schema.parse(read),read);
 const write={source,mode:'apply',target_revit_year:'2024',native_program:{entry_type:'ReadCount',effect_scope:'active_document',result_targets:{result_field:'createdIds'}}};
 assert.deepEqual(schema.parse(write),write);
 assert.match(NATIVE_CSHARP_TOOL_GUIDE,/Native API\/MCP tools remain available/);
 assert.match(NATIVE_CSHARP_TOOL_GUIDE,/Unknown effects require reconciliation/);
});
test('legacy graph lanes are absent while native bounds and identity validation remain enforced',()=>{
 const base={source,mode:'read',native_program:{entry_type:'ReadCount'}};
 for(const value of [{source,mode:'read'}, {...base,mode:'preview'}, {...base,snapshot_limit:200},
   {...base,native_program:{entry_type:''}}, {...base,native_program:{entry_type:'ReadCount',deadline_ms:10001}},
   {...base,native_program:{entry_type:'ReadCount',parameter_checks:[{element_id:0,parameter_name:'Mark',expected_value:'A'}]}},
   {...base,native_program:{entry_type:'ReadCount',result_targets:{result_field:'nested.ids'}}}])
   assert.equal(schema.safeParse(value).success,false);
 assert.equal(schema.safeParse({...base,native_program:{entry_type:'ReadCount',allowed_existing_unique_ids:['known-id'],allow_create:false,max_affected_elements:1}}).success,true);
});
