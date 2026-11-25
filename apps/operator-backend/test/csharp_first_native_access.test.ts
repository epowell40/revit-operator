import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {findRepoRoot} from '../src/tools/audit_tool_registry.js';
import {EAGER_OPERATOR_MCP_TOOLS} from '../src/codex/mcp_tool_runtime.js';
import {desktopNativeModelTools,desktopNativeToolContract} from '../src/assignments/desktop_native_tools.js';
const root=findRepoRoot(process.cwd());
const inventory=JSON.parse(fs.readFileSync(path.join(root,'contracts/supported-tool-inventory.v1.json'),'utf8'));
const fixture=[path.join(import.meta.dirname,'fixtures/csharp-first-native-access-baseline.json'),path.resolve(import.meta.dirname,'../../test/fixtures/csharp-first-native-access-baseline.json')].find(p=>fs.existsSync(p));assert(fixture);
const baseline=JSON.parse(fs.readFileSync(fixture,'utf8').replace(/^\uFEFF/,''));
const retired=['operator_plan_existing_conditions_duct_continuation','operator_plan_semantic_mep_route','operator_record_execution_strategy','operator_register_existing_conditions_interpretation','operator_resume_existing_conditions_registration','operator_validate_existing_conditions_interpretation'];
test('C# simplification preserves every pinned native route, MCP alias and internal execution boundary',()=>{
 assert.deepEqual(inventory.native_routes,[...baseline.native_routes,{method:'POST',path:'/revit/sync'},{method:'POST',path:'/revit/link-revit'}]);
 for(const field of ['internal_routes','standalone_routes'])assert.deepEqual(inventory[field],baseline[field],field);
 assert.deepEqual(inventory.mcp_aliases.filter((x:string)=>x.startsWith('revit_')),[...baseline.native_mcp_aliases,'revit_sync_model']);
 for(const name of retired)assert(!inventory.mcp_aliases.includes(name),name);
 for(const name of ['operator_run_dynamic_revit_program','operator_manage_work_plan','operator_request_assignment_input','read_excel','read_pdf_text','read_word'])assert(inventory.mcp_aliases.includes(name),name);
});
test('native shortcuts stay callable on demand without crowding the default actor toolset',()=>{
 assert.equal(EAGER_OPERATOR_MCP_TOOLS.size,21);
 for(const name of retired)assert(!EAGER_OPERATOR_MCP_TOOLS.has(name));
 const tools=inventory.mcp_aliases.map((name:string)=>({name,description:'Bound current contract for '+name,inputSchema:{type:'object',properties:{}},deferLoading:!EAGER_OPERATOR_MCP_TOOLS.has(name)}));
 const direct=desktopNativeModelTools(tools);
 assert(direct.some(t=>t.name==='native__operator_run_dynamic_revit_program'));
 assert(direct.some(t=>t.name==='native__revit_call_tool'));
 for(const name of baseline.native_mcp_aliases){
   const described=desktopNativeToolContract(tools,{tool:name});
   assert.equal(described.tool.name,name);
 }
 assert(!direct.some(t=>t.name==='native__revit_set_parameters'));
 assert.equal(desktopNativeToolContract(tools,{tool:'revit_set_parameters'}).tool.name,'revit_set_parameters');
 for(const name of ['revit_open_model','revit_close_doc','revit_list_views','revit_list_sheets','revit_activate_view','revit_create_sheet','revit_create_drafting_view','revit_place_view','revit_export_pdf'])
  assert(direct.some(t=>t.name==='native__'+name),name+' must remain directly available');
 for(const route of ['/revit/save-as','/revit/print','/revit/create-view'])
  assert(inventory.native_routes.some((r:{method:string,path:string})=>r.method==='POST'&&r.path===route),route);
});
