import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {evaluateToolExposure,isMcpToolAliasExposed,isToolRouteExposedForSearch,filterRegistryEntriesForSearch} from './toolExposurePolicy.js';

const route={method:'POST',path:'/revit/mep-branch-network-workflow'};
const env={REVIT_OPERATOR_MODE:'development',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',
 OPERATOR_LOCAL_TOOL_EXCLUSIONS_JSON:JSON.stringify({mcp_tools:['operator_run_dynamic_revit_program'],native_routes:['POST '+route.path]})};

test('configured executor is absent from MCP discovery while ordinary tools remain',()=>{
 assert.equal(isMcpToolAliasExposed('operator_run_dynamic_revit_program',env),false);
 assert.equal(isMcpToolAliasExposed('revit_create_duct',env),true);
});
test('configured whole-network route is absent from search and rejects generic dispatch',()=>{
 assert.equal(isToolRouteExposedForSearch(route.method,route.path,env),false);
 assert.deepEqual(filterRegistryEntriesForSearch([route,{method:'POST',path:'/revit/create-duct'}],env),[{method:'POST',path:'/revit/create-duct'}]);
 for(const channel of ['generic_call','typed_mcp','deterministic_workflow'] as const){
  const decision=evaluateToolExposure({...route,channel,env});
  assert.equal(decision.allowed,false);assert.deepEqual(decision.reasonCodes,['LOCAL_TOOL_EXCLUDED']);
 }
 assert.equal(evaluateToolExposure({method:'POST',path:'/revit/create-duct',channel:'generic_call',env}).allowed,true);
});
test('no exclusion preserves the ordinary exposure; malformed or remote configuration fails closed',()=>{
 const ordinary={...env,OPERATOR_LOCAL_TOOL_EXCLUSIONS_JSON:''};
 assert.equal(isMcpToolAliasExposed('operator_run_dynamic_revit_program',ordinary),true);
 assert.equal(isToolRouteExposedForSearch(route.method,route.path,ordinary),true);
 for(const value of ['bad','null','[]','{"unexpected":[]}','{"mcp_tools":[42]}','{"native_routes":["not a route"]}']){
  assert.throws(()=>isMcpToolAliasExposed('revit_ping',{...env,OPERATOR_LOCAL_TOOL_EXCLUSIONS_JSON:value}),/exclusion/i);
 }
 assert.throws(()=>isMcpToolAliasExposed('revit_ping',{...env,REVIT_OPERATOR_MODE:'hosted'}),/exclusion/i);
});

test('actual MCP listing and generic/documentation calls honor the same local reduction without native dispatch',async()=>{
 let requests=0;
 const backend=http.createServer((_req,res)=>{requests++;res.writeHead(500);res.end('Excluded route unexpectedly forwarded');});
 await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));
 const address=backend.address();assert(address&&typeof address!=='string');
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'local-tool-exclusions-'));
 try{
  for(const excluded of [false,true]){
   const transport=new StdioClientTransport({command:process.execPath,args:[path.join(process.cwd(),'dist/server.js')],cwd:process.cwd(),stderr:'pipe',env:{...process.env,...env,
    OPERATOR_LOCAL_TOOL_EXCLUSIONS_JSON:excluded?env.OPERATOR_LOCAL_TOOL_EXCLUSIONS_JSON:'',OPERATOR_WORKSPACE_ROOT:workspace,
    OPERATOR_TOKEN:'test-only',OPERATOR_OPENAI_API_KEY:'test-only',OPERATOR_AUTH_MODE:'shared_token',
    OPERATOR_API_BASE_URL:`http://127.0.0.1:${address.port}`,REVIT_BRIDGE_URL:`http://127.0.0.1:${address.port}`}});
   transport.stderr?.on('data',()=>{});
   const client=new Client({name:'local-capability-reduction',version:'1.0.0'},{capabilities:{}});
   try{
    await client.connect(transport);
    const catalog=await client.listTools();
    assert.equal(catalog.tools.some(t=>t.name==='operator_run_dynamic_revit_program'),!excluded);
    assert(catalog.tools.some(t=>t.name==='revit_create_duct'));
    if(excluded){
     const call=await client.callTool({name:'revit_call_tool',arguments:{...route,body:{}}});
     assert.equal(call.isError,true);assert.match(JSON.stringify(call.content),/LOCAL_TOOL_EXCLUDED/);
     const doc=await client.callTool({name:'revit_tool_doc',arguments:route});
     assert.equal(doc.isError,true);
     const unavailable=await client.callTool({name:'operator_run_dynamic_revit_program',arguments:{source:'unused',mode:'read'}});
     assert.equal(unavailable.isError,true);
     assert.match(JSON.stringify(unavailable.content),/disabled|not found|unknown tool/i);
    }
   }finally{await client.close();await transport.close();}
  }
  assert.equal(requests,0,'no native or provider request is needed for exclusion');
 }finally{await new Promise<void>(resolve=>backend.close(()=>resolve()));fs.rmSync(workspace,{recursive:true,force:true});}
});
