import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Isolated stdio child with all network endpoints deliberately closed. This
// exercises the actual registered tool schema without contacting Revit.
test("capture-view publishes the opt-in mode and rejects invalid mode before native dispatch", {timeout:30_000}, async()=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),"operator-capture-args-"));
  const policyPath=path.resolve(process.cwd(),"../operator-backend/config/tool_exposure_policy.v1.json");
  const policy=JSON.parse(fs.readFileSync(policyPath,"utf8"));
  const source=process.env.OPERATOR_TEST_MCP_SOURCE === "1";
  const transport=new StdioClientTransport({command:process.execPath,
    args:source?["--loader","ts-node/esm",path.resolve("src/server.ts")]:[path.resolve("dist/server.js")],cwd:process.cwd(),stderr:"pipe",
    env:{...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==="string")),
      TS_NODE_TRANSPILE_ONLY:"true",REVIT_OPERATOR_MODE:"development",OPERATOR_TOOL_EXPOSURE_PROFILE:"laboratory",
      OPERATOR_API_BASE_URL:"http://127.0.0.1:1",REVIT_BRIDGE_URL:"http://127.0.0.1:1",OPERATOR_TOKEN:"capture-test-token",
      OPERATOR_WORKSPACE_ROOT:workspace,OPERATOR_TOOL_EXPOSURE_POLICY_PATH:policyPath,OPERATOR_TOOL_EXPOSURE_POLICY_SHA256:policy.policy_hash}});
  const client=new Client({name:"capture-argument-contract",version:"1"},{capabilities:{}});
  try {
    await client.connect(transport);
    const tools=await client.listTools();
    const tool=tools.tools.find(item=>item.name==="revit_capture_view");assert.ok(tool);
    const properties=tool.inputSchema.properties as Record<string,any>;
    assert.deepEqual(properties.exportMode?.enum,["full_view","visible_region"]);
    assert.equal(tool.inputSchema.required?.includes("exportMode")??false,false);
    assert.equal(properties.imageSize.default,2048);
    const response=await client.callTool({name:"revit_capture_view",arguments:{exportMode:"invented_mode"}});
    assert.equal(response.isError,true);
    assert.match(JSON.stringify(response.content),/Invalid enum value|invalid_enum_value/);
  } finally {
    await client.close();await transport.close();
    // The path was created by this test below the OS temp root.
    if (path.dirname(workspace)!==path.resolve(os.tmpdir())) throw Error("Unexpected temporary directory");
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});
