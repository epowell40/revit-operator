import test from 'node:test';import assert from 'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import http from'node:http';
import{Client}from'@modelcontextprotocol/sdk/client/index.js';import{StdioClientTransport}from'@modelcontextprotocol/sdk/client/stdio.js';
test('work-plan MCP exposes pre-change discovery guidance and preserves HTTP dependency diagnostics without retry',async t=>{
 const fixture=JSON.parse(fs.readFileSync(path.resolve('../operator-backend/test/fixtures/work-plan-dependencies-398.json'),'utf8').replace(/^\uFEFF/,''));
 const requests:any[]=[];const backend=http.createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));requests.push(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({error:'work_plan_dependencies_invalid',guidance:fixture.domain_guidance}));});
 await new Promise<void>(r=>backend.listen(0,'127.0.0.1',r));const root=fs.mkdtempSync(path.join(os.tmpdir(),'work-plan-diagnostic-mcp-'));
 const env=Object.fromEntries(Object.entries(process.env).filter((x):x is[string,string]=>typeof x[1]==='string'));
 const transport=new StdioClientTransport({command:process.execPath,args:import.meta.url.endsWith('.ts')?['--loader','ts-node/esm',path.join(process.cwd(),'src/server.ts')]:[path.join(process.cwd(),'dist/server.js')],cwd:process.cwd(),env:{...env,OPERATOR_API_BASE_URL:`http://127.0.0.1:${(backend.address() as any).port}`,OPERATOR_AUTH_MODE:'shared_token',OPERATOR_TOKEN:'fixture-only',OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory'},stderr:'pipe'});
 transport.stderr?.on('data',()=>{});const client=new Client({name:'plan-diagnostic',version:'1'},{capabilities:{}});
 t.after(async()=>{await client.close();await transport.close();backend.closeAllConnections();await new Promise<void>(r=>backend.close(()=>r()));assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('work-plan-diagnostic-mcp-'));fs.rmSync(root,{recursive:true,force:true});});
 await client.connect(transport);const tool=(await client.listTools()).tools.find(x=>x.name==='operator_manage_work_plan');assert(tool);
 const binding={assignment_id:'fixture-task',run_id:'fixture-run',session_id:'fixture-session',generation:1,principal_id:'fixture'};
 for(const args of fixture.cases){const result=await client.callTool({name:tool.name,arguments:args,_meta:{'revit-operator/assignment-kernel-binding-v2':binding}});assert.equal(result.isError,true);assert(JSON.stringify(result.content).includes(fixture.domain_guidance));}
 assert.equal(requests.length,3,'a rejected declaration must not be retried by transport');
 assert.equal(requests[2].declaration.items[0].depends_on,undefined,'omitted dependencies remain omitted');
 assert.match(tool.description??'',/Pre-change discovery.*outside.*dependent.*inspection/i,'the actor must distinguish investigation from post-edit proof');
 assert.match(tool.description??'',/Do not invent.*edits.*checklist/i);
});
