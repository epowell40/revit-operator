import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';import path from 'node:path';
import {desktopNativeModelTools,desktopNativeToolContract,desktopNativeResponseCall} from '../src/assignments/desktop_native_tools.js';
function fixture(name:string){const file=[path.join(import.meta.dirname,'fixtures',name),path.resolve(import.meta.dirname,'../../test/fixtures',name)].find(p=>fs.existsSync(p));assert(file);return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
const program=fixture('desktop-native-program-contract293.json').tool;
const supplemental=fixture('desktop-owner-supplemental-tools298.json').tools;
test('primary owner has the exact frequently-used work ledger schema without evidence lookup round trips',()=>{
 const plan=supplemental.find((t:any)=>t.name==='operator_manage_work_plan');assert(plan);
 const direct=desktopNativeModelTools([program,...supplemental]).find(t=>t.name==='native__operator_manage_work_plan');assert(direct);
 assert.equal(direct.description,plan.description);assert.deepEqual(direct.parameters,plan.inputSchema);
 assert(!desktopNativeModelTools([program]).some(t=>t.name==='native__operator_manage_work_plan'),'No fabricated tool when missing from current catalog');
});

test('single owner keeps executor and work ledger contracts while less-used supplemental schemas stay deferred',()=>{
 const catalog=[program,...supplemental,{name:'revit_set_parameters',description:'An ordinary known edit',inputSchema:{type:'object'},deferLoading:false}];
 const exposed=desktopNativeModelTools(catalog);
 for(const tool of supplemental.filter((t:any)=>t.name!=='operator_manage_work_plan'))assert(!exposed.some(t=>t.name==='native__'+tool.name),tool.name+' remains deferred');
 const direct=exposed.find(t=>t.name==='native__'+program.name);assert(direct);
 assert.equal(direct.description,program.description);assert.deepEqual(direct.parameters,program.inputSchema);
 assert(exposed.some(t=>t.name==='native__revit_set_parameters'));
 assert(exposed.some(t=>t.name==='native__invoke'));assert(exposed.some(t=>t.name==='native__describe_tool'));
 for(const tool of supplemental){
  const contract=desktopNativeToolContract(catalog,{tool:tool.name});
  assert.equal(contract.tool,tool,'on-demand documentation keeps the complete current contract');
  const record:any={status:'complete',message_id:'message',binding:{session_id:'session'},response:{id:'response',status:'completed',
   model_call_receipt:{call_id:'response',success:true,route:'desktop_computer'},
   provider_response_usage:{disposition:'completed',message_id:'message',session_id:'session',raw_response_ids:['response']},
   output:[{type:'function_call',call_id:'call',name:'native__invoke',arguments:JSON.stringify({tool:tool.name,arguments:{}})}]}};
  assert.deepEqual(desktopNativeResponseCall(record,'response','call'),{tool:tool.name,arguments:{}});
 }
 const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v),'utf8');
 assert(bytes(exposed)<bytes(desktopNativeModelTools(supplemental))+bytes(direct),'Unused schemas still stay out of the active catalog');
});
test('catalog without the general executor preserves legacy eager and already-deferred exposure',()=>{
 const ordinary=desktopNativeModelTools([...supplemental,{...program,name:'other_program'}]);
 for(const tool of supplemental)assert(ordinary.some(t=>t.name==='native__'+tool.name));
 assert(!ordinary.some(t=>t.name==='native__other_program'));
 assert(!ordinary.some(t=>t.name==='native__'+program.name));
 assert.throws(()=>desktopNativeToolContract(supplemental,{tool:program.name}),/not_exposed/);
});
