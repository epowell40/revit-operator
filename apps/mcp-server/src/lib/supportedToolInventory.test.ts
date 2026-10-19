import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SUPPORTED_MCP_ALIASES, isSupportedNativeTool } from "./supportedToolInventory.js";
import { filterRegistryEntriesForSearch, isKnownToolExposureRoute, isToolRouteExposedForSearch } from "./toolExposurePolicy.js";
import { protectedSmokeResponse, writeNativeReceipt } from './nativeTransport.testSupport.js';
import { NATIVE_TRANSPORT_CONTENT_TYPE, NATIVE_TRANSPORT_PATH } from './nativeTransport.js';

const nativeSource = fs.readFileSync(path.resolve(process.cwd(), "../revit-bridge-addin/RevitBridge/Operator/OperatorToolManifest.cs"), "utf8");
const implemented = [...nativeSource.matchAll(/new OperatorToolInfo\("[^"\r\n]+",\s*"(GET|POST)",\s*"([^"]+)"/g)]
  .map(match => ({ method: match[1]!, path: match[2]! }));
const excluded = implemented.filter(route => !isSupportedNativeTool(route.method, route.path));

test("fixed supported inventory narrows search before all laboratory and hosted overrides", () => {
  assert.equal(isSupportedNativeTool("POST", "/revit/project-parameters"), true);
  assert.equal(isSupportedNativeTool("POST", "/revit/existing-conditions-mep-draft-workflow"), true);
  assert.equal(implemented.length, 223);
  assert.equal(excluded.length, 105);
  assert.equal(isSupportedNativeTool("POST", "/revit/connect-existing-mep-branch"), true);
  for (const mode of ["development", "hosted", "production"]) {
    const env = { REVIT_OPERATOR_MODE: mode, OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" };
    assert.equal(filterRegistryEntriesForSearch(implemented, env).length, 118);
    for(const path of ['/revit/import-excel-output','/revit/inspect-excel-import','/revit/import-vector-detail','/revit/inspect-vector-detail']){
      assert.equal(isToolRouteExposedForSearch('POST',path,env),true);assert.equal(isToolRouteExposedForSearch('GET',path,env),false);
      assert.equal(isToolRouteExposedForSearch('POST',path+'-other',env),false);
    }
    assert.equal(isToolRouteExposedForSearch("POST", "/revit/inspect-excel-source", env), true);
    assert.equal(isToolRouteExposedForSearch("GET", "/revit/inspect-excel-source", env), false);
    assert.equal(isToolRouteExposedForSearch("POST", "/revit/inspect-drawing-spec", env), true);
    assert.equal(isToolRouteExposedForSearch("GET", "/revit/inspect-drawing-spec", env), false);
    assert.equal(isToolRouteExposedForSearch("POST", "/revit/import-drawing-spec", env), true);
    assert.equal(isToolRouteExposedForSearch("GET", "/revit/import-drawing-spec", env), false);
    assert.equal(isToolRouteExposedForSearch("POST", "/revit/import-excel-table", env), false);
    assert.equal(isToolRouteExposedForSearch("POST", "/revit/link-cad", env), true);
    assert.equal(isToolRouteExposedForSearch("GET", "/revit/link-cad", env), false);
    assert.equal(isToolRouteExposedForSearch("POST", "/revit/locate-elements", env), true);
    assert.equal(isToolRouteExposedForSearch("GET", "/revit/locate-elements", env), false);
    for (const route of excluded) {
      assert.equal(isKnownToolExposureRoute(route.method, route.path, env), false);
      assert.equal(isToolRouteExposedForSearch(route.method, route.path, env), false);
    }
  }
});

for (const documentedRoute of ['/revit/project-parameters', '/revit/import-drawing-spec', '/revit/inspect-drawing-spec', '/revit/inspect-excel-source'])
test(`actual MCP documentation discovers ${documentedRoute} without executing its mutation`,async()=>{
 const requests:string[]=[];
 const schema=JSON.parse(fs.readFileSync(new URL('../../../revit-bridge-addin/RevitBridge.Common/Contracts/conditional-requests.v1.json',import.meta.url),'utf8'))[documentedRoute];
 const token='p'.repeat(32),epoch=Buffer.alloc(32,7).toString('base64url');
 const backend=http.createServer(async(request,response)=>{const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
  assert.equal(request.url,NATIVE_TRANSPORT_PATH);response.setHeader('content-type',NATIVE_TRANSPORT_CONTENT_TYPE);
  response.end(protectedSmokeResponse(Buffer.concat(chunks).toString('utf8'),token,200,inner=>{
   requests.push(inner.path);assert.equal(inner.method,'POST');assert.equal(inner.path,'/revit/tool-doc');
   assert.deepEqual(JSON.parse(inner.body_json),{method:'POST',path:documentedRoute});
   return JSON.stringify({method:'POST',path:documentedRoute,request_schema:schema});
  }));});
 await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));const address=backend.address();assert(address&&typeof address!=='string');
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'parameter-discovery-stdio-'));
 writeNativeReceipt(workspace,`http://127.0.0.1:${address.port}`,epoch);
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(process.cwd(),'dist/server.js')],cwd:process.cwd(),stderr:'pipe',
  env:{...process.env,REVIT_OPERATOR_MODE:'development',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_TOKEN:token,OPERATOR_OPENAI_API_KEY:'test-only',OPERATOR_AUTH_MODE:'shared_token',
   LOCALAPPDATA:workspace,OPERATOR_REVIT_TRANSPORT:'direct',OPERATOR_UNSAFE_LEGACY_PLAINTEXT_REVIT_TRANSPORT:'0',
   OPERATOR_WORKSPACE_ROOT:workspace,OPERATOR_API_BASE_URL:`http://127.0.0.1:${address.port}`,REVIT_BRIDGE_URL:`http://127.0.0.1:${address.port}`}});
 transport.stderr?.on('data',()=>{});const client=new Client({name:'parameter-discovery',version:'1.0.0'},{capabilities:{}});
 try{
  await client.connect(transport);const doc=await client.callTool({name:'revit_tool_doc',arguments:{method:'POST',path:documentedRoute}});
  assert.notEqual(doc.isError,true,JSON.stringify(doc.content));
  const value=JSON.parse((doc.content as Array<{type:string,text?:string}>).find(c=>c.type==='text')!.text!);
  assert.equal(value.path,documentedRoute);
  if(documentedRoute==='/revit/project-parameters') assert(value.request_schema.oneOf.some((m:any)=>m.properties.action.enum.includes('detail')));
  else if(documentedRoute==='/revit/inspect-drawing-spec')assert(value.request_schema.oneOf.some((m:any)=>m.required.includes('manifestElementId')&&m.required.includes('sourcePath')));
  else assert.deepEqual(value.request_schema.required,['sourcePath']);
  if(documentedRoute==='/revit/import-drawing-spec')assert(value.request_schema.oneOf.some((m:any)=>m.properties.action.enum.includes('update')&&m.required.includes('expectedNativeSnapshotSha256')));
  assert(requests.length>0);assert(requests.every(p=>p.endsWith('/revit/tool-doc')),'Discovery must never execute the parameter mutation.');
 }finally{await client.close();await transport.close();await new Promise<void>((resolve,reject)=>backend.close(error=>error?reject(error):resolve()));fs.rmSync(workspace,{recursive:true,force:true});}
});

test("actual MCP list generic call and tool documentation cannot expose or dispatch excluded routes", async () => {
  let requests = 0;
  const backend = http.createServer((_request, response) => { requests++; response.statusCode = 500; response.end("Unexpected excluded request"); });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "supported-inventory-stdio-"));
  try {
    for (const mode of ["development", "hosted"]) {
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), "dist/server.js")], cwd: process.cwd(), stderr: "pipe",
        env: { ...process.env, REVIT_OPERATOR_MODE: mode, OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
          OPERATOR_TOKEN: "test-only", OPERATOR_OPENAI_API_KEY: "test-only", OPERATOR_AUTH_MODE: "shared_token",
          OPERATOR_WORKSPACE_ROOT: workspace, OPERATOR_API_BASE_URL: `http://127.0.0.1:${address.port}`, REVIT_BRIDGE_URL: `http://127.0.0.1:${address.port}` } });
      transport.stderr?.on("data", () => {});
      const client = new Client({ name: "supported-inventory-boundary", version: "1.0.0" }, { capabilities: {} });
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [...SUPPORTED_MCP_ALIASES].sort());
        for (const route of excluded.filter(route => route.path.startsWith("/revit/"))) {
          const denied = await client.callTool({ name: "revit_call_tool", arguments: { ...route, body: {}, requireKnownPath: false },
            _meta: { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" } });
          assert.equal(denied.isError, true, route.path);
          assert.match(JSON.stringify(denied.content), /outside the supported product inventory/i);
          for (const name of ["revit_tool_doc", "revit_tool_examples"]) {
            const doc = await client.callTool({ name, arguments: route });
            assert.equal(doc.isError, true, `${name} leaked ${route.path}`);
          }
        }
        for (const path of ["/revit/not-a-real-tool", "/revit/dynamic-runtime/bootstrap"]) {
          const denied = await client.callTool({ name: "revit_call_tool", arguments: { method: "POST", path, requireKnownPath: false } });
          assert.equal(denied.isError, true);
        }
        const unsourcedStage = await client.callTool({ name: "revit_call_tool", arguments: {
          method: "POST", path: "/revit/existing-conditions-mep-draft-workflow",
          body: { dryRun: true, operations: [] }, requireKnownPath: false
        } });
        assert.equal(unsourcedStage.isError, true);
        assert.match(JSON.stringify(unsourcedStage.content), /registered_existing_conditions_stage_v2_binding_required/);
        const probe = await client.callTool({ name: "operator_runtime_probe", arguments: {} });
        assert.notEqual(probe.isError, true);
        assert.equal(requests, 0, "Excluded calls and introspection must stop before any backend or native network request.");
      } finally { await client.close(); await transport.close(); }
    }
  } finally {
    await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
    // Exact temporary folder created by this test; no caller-controlled deletion path.
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
