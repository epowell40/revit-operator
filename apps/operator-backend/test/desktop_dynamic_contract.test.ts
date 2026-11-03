import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {desktopNativeModelTools,desktopNativeToolContract,desktopNativeToolDescription} from '../src/assignments/desktop_native_tools.js';
import {boundDesktopNativeOutput} from '../src/assignments/desktop_native_output.js';
import {retrieveEvidence} from '../src/evidence/evidence_store.js';
import {assertBoundedModelEvidencePayload} from '../src/evidence/model_context_budget.js';

test('actual registered C# executor contract reaches owner through bounded documentation and exact retained fields',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-csharp-contract-')),old=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;
 const mcp=path.resolve(process.cwd(),'../mcp-server');
 const env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string'));
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(mcp,'dist/server.js')],cwd:mcp,stderr:'pipe',
  env:{...env,REVIT_OPERATOR_MODE:'development',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_AUTH_MODE:'shared_token',OPERATOR_TOKEN:'test-only',OPERATOR_API_BASE_URL:'http://127.0.0.1:9'}});
 const client=new Client({name:'current-contract-test',version:'1'},{capabilities:{}});
 transport.stderr?.on('data',()=>{});
 try {
  await client.connect(transport);
  const listed=(await client.listTools()).tools;
  assert(!listed.some(t=>t.name==='operator_get_assignment_status'));
  const missing=desktopNativeToolDescription(listed as any,{tool:'operator_get_assignment_status'});
  assert.equal(missing.success,false);assert.equal(missing.payload.authorizationGranted,false);
  const raw=listed.find(t=>t.name==='operator_run_dynamic_revit_program');assert(raw?.description);
  assert(Buffer.byteLength(JSON.stringify({'tool.description':raw.description}),'utf8')<8192,'The exact top-level guide must fit one existing evidence selection');
  assert.match(raw.description,/native_program/);assert.match(raw.description,/tool\.inputSchema\.properties\.source/);
  const tool={name:raw.name,description:raw.description,inputSchema:raw.inputSchema,deferLoading:true};
  const models=desktopNativeModelTools([tool]);assert(models.some(t=>t.name==='native__describe_tool'));
  const primary=models.find(t=>t.name==='native__'+tool.name);
  assert(primary,'the first-class C# executor stays in the owner tool definitions even when other tools are deferred');
  assert.deepEqual(primary.parameters,raw.inputSchema,'the primary tool receives the exact current schema, not a parallel dictionary');
  assert.equal(primary.description,raw.description);
  const contract=desktopNativeToolContract([tool],{tool:tool.name});
  assert.match(contract.tool.description,/IDynamicRevitProgram/);assert.match(contract.tool.description,/c\.Input\.Coverage/);
  const scope={session_id:'s',assignment_id:'a',run_id:'r',generation:1};
  const output=boundDesktopNativeOutput({success:true,contentItems:[{type:'inputText',text:JSON.stringify(contract)}]},scope,'contract');
  const text=(output.contentItems[0] as any).text,visible=JSON.parse(text);
  assertBoundedModelEvidencePayload({type:'function_call_output',output:text});
  if(visible.evidence_projections){
   const projection=visible.evidence_projections[0];assert.equal(projection.trust_level,'untrusted_caller');assert.equal(projection.truncated,true);
   const retrieve=(fields:string[])=>retrieveEvidence({scope,evidence_id:projection.evidence_id,fields,max_bytes:8192,purpose:'Read exact current executor contract'});
   const guide=retrieve(['tool.description']);assert.equal((guide.selection as any)['tool.description'],raw.description);
   const fields=['tool.inputSchema.required','tool.inputSchema.properties.source','tool.inputSchema.properties.mode','tool.inputSchema.properties.category','tool.inputSchema.properties.parameters','tool.inputSchema.properties.snapshot_limit'];
   const selected=retrieve(fields).selection as any;assert.deepEqual(selected['tool.inputSchema.properties.source'],raw.inputSchema.properties?.source);
   assert.deepEqual(selected['tool.inputSchema.properties.mode'],raw.inputSchema.properties?.mode);
   assert.deepEqual(selected['tool.inputSchema.properties.snapshot_limit'],raw.inputSchema.properties?.snapshot_limit);
   assert.match(JSON.stringify(selected['tool.inputSchema.properties.source']),/DynamicMepConnectorSelectorV1/,'Advanced SDK detail remains separately retrievable, not removed');
   const native=retrieve(['tool.inputSchema.properties.native_program']).selection as any;
   assert.deepEqual(native['tool.inputSchema.properties.native_program'],raw.inputSchema.properties?.native_program);
   assert.throws(()=>retrieveEvidence({scope:{...scope,generation:2},evidence_id:projection.evidence_id,fields:['tool.description'],purpose:'Stale scope'}));
  } else assert.deepEqual(visible.tool,tool);
 } finally {await client.close();await transport.close();if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;}
});
