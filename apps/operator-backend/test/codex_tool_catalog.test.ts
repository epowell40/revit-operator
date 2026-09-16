import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServer } from "../src/codex/app_server.js";
import { CodexMcpToolRuntime } from "../src/codex/mcp_tool_runtime.js";
import { READ_ATTACHMENT_TOOL } from "../src/attachments/read_attachment.js";
import { CODE_MODE_IMAGE_DISPLAY } from "../src/codex/code_mode_images.js";
import { getOrCreateCodexThread } from "../src/brains/codex_thread_lifecycle.js";
import { getCodexThreadStartProfile } from "../src/brains/codex_turn_profile.js";
import { codexTelemetryThreadKey } from "../src/brains/codex_turn_model_telemetry.js";
import { codexToolCatalogHash, withCodexCapabilityHandoff } from "../src/brains/codex_tool_catalog.js";
import { appendEvent, setCodexThreadId, getCodexThreadId, getCodexThreadCapabilities } from "../src/memory/sqlite_store.js";

test("actual runtime advertisement includes the host PDF reader eagerly even when MCP omits it", async () => {
  const runtime = new CodexMcpToolRuntime({backendCwd:process.cwd(),workspaceRoot:process.cwd(),codexHome:process.cwd(),spawnEnv:{}});
  (runtime as any).ensureStarted = async () => {};
  (runtime as any).client = { listTools: async () => ({ tools: [{ name: "old_reader", inputSchema: { type: "object" } }] }) };
  const catalog = await runtime.getDynamicToolNamespace();
  assert.deepEqual(catalog.tools[0], READ_ATTACHMENT_TOOL);
  assert.equal(catalog.tools.filter((t: any) => t.name === "operator_read_attachment").length, 1);
  const reordered = [{ ...catalog, tools: [...catalog.tools].reverse() }];
  assert.equal(codexToolCatalogHash([catalog]), codexToolCatalogHash(reordered));
  assert.notEqual(codexToolCatalogHash([catalog]), codexToolCatalogHash([{ ...catalog, tools: catalog.tools.slice(1) }]));
  assert.notEqual(codexToolCatalogHash([catalog]), codexToolCatalogHash([{ ...catalog, tools: [{ ...READ_ATTACHMENT_TOOL, deferLoading: true }, ...catalog.tools.slice(1)] }]));
});

test("actual dynamic namespace advertises the same image display recipe on native image tools without changing other tool contracts", async () => {
  const runtime = new CodexMcpToolRuntime({ backendCwd: process.cwd(), workspaceRoot: process.cwd(), codexHome: process.cwd(), spawnEnv: {} });
  const tools = ["revit_call_tool", "revit_export_view_frame", "revit_get_context"].map(name => ({ name, description: "Original contract", inputSchema: { type: "object", additionalProperties: false, properties: {} } }));
  (runtime as any).ensureStarted = async () => {};
  (runtime as any).client = { listTools: async () => ({ tools }) };
  const catalog = await runtime.getDynamicToolNamespace();
  for (const original of tools) {
    const actual = catalog.tools.find((item: any) => item.name === original.name);
    assert.deepEqual(actual.inputSchema, original.inputSchema);
    if (original.name === "revit_get_context") assert.equal(actual.description, original.description);
    else { assert.ok(actual.description.includes(CODE_MODE_IMAGE_DISPLAY)); assert.match(actual.description, /same call|same.*result|Keep the result/); }
  }
  assert.ok(catalog.tools[0].description.includes(CODE_MODE_IMAGE_DISPLAY));
});

test("saved pre-reader thread receives a new catalog without losing conversation, replaying work, or replacing an active turn", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-catalog-"));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  t.after(() => { if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous; });
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const fixture = [path.join(dir,"fixtures/codex_app_server_fixture.js"),path.join(dir,"../../test/fixtures/codex_app_server_fixture.js")].find(fs.existsSync)!;
  const status = path.join(root,"status"); fs.writeFileSync(status,"idle");
  const trace = path.join(root,"trace.jsonl");
  const makeClient = () => new CodexAppServer({ cwd: root, codexHome: path.join(root,".codex"), command: process.execPath, commandPrefixArgs: [fixture],
    spawnEnv: { ...process.env, CODEX_FIXTURE_STATE_PATH: path.join(root,"state.json"), CODEX_FIXTURE_TRACE_PATH: trace, CODEX_FIXTURE_RESUME_STATUS_PATH: status } });
  const client = makeClient(), restarted = makeClient(); t.after(() => { client.stop(); restarted.stop(); });
  const profile = getCodexThreadStartProfile({ session_id: "same-conversation", context: {} }, { baseInstructions: "Same assistant", developerInstructions: "Same policy" });
  const key = codexTelemetryThreadKey(profile);
  await client.ensureStarted();
  const legacy = await client.startThread({ ...profile, dynamicTools: [] } as any);
  setCodexThreadId(key,legacy.thread.id);
  appendEvent("same-conversation","user","chat.message",{ display: { message_id:"prior",text:"Review all eight pages. Do not modify the model.",attachments:[{id:"registered-pdf",name:"Checklist.pdf"}] } });
  appendEvent("another-conversation","user","chat.message",{ display: { message_id:"private",text:"Other conversation must not leak." } });
  const tools = [{ type:"namespace",name:"revit_operator",description:"Operator",tools:[READ_ATTACHMENT_TOOL] }] as any;
  const args = { sessionId:"same-conversation",client,profile,cwd:root,settings:{model:"fixture",reasoning_effort:"medium" as const},getDynamicTools:async()=>tools };
  fs.writeFileSync(status,"active");
  await assert.rejects(getOrCreateCodexThread(args),/prior thread is active/);
  assert.equal(getCodexThreadId(key),legacy.thread.id);
  assert.equal(await getOrCreateCodexThread({ ...args, monitoringOnly:true }),legacy.thread.id);
  fs.writeFileSync(status,"idle");
  const next = await getOrCreateCodexThread(args);
  assert.notEqual(next,legacy.thread.id); assert.equal(getCodexThreadId(key),next);
  assert.equal(getCodexThreadCapabilities(next)?.tool_sha256,codexToolCatalogHash(tools));
  const input = withCodexCapabilityHandoff([{type:"text",text:"Continue the review",text_elements:[]}],next);
  const text = JSON.stringify(input);
  assert.match(text,/all eight pages/); assert.match(text,/registered-pdf/); assert.doesNotMatch(text,/Other conversation/); assert.match(text,/Do not restart or replay prior work/);
  client.stop(); await restarted.ensureStarted();
  assert.equal(await getOrCreateCodexThread({...args,client:restarted}),next);
  assert.deepEqual(withCodexCapabilityHandoff(input.slice(1),next),input,"handoff survives host restart before provider acceptance");
  const turn = await restarted.startBoundTurn({threadId:next,input},profile);
  appendEvent("same-conversation","assistant","codex.turn.start",{thread_id:next,turn_id:turn.turn.id});
  restarted.acknowledgePersistedTurnInstructionBinding(next,turn.turn.id);
  assert.deepEqual(withCodexCapabilityHandoff(input.slice(1),next),input.slice(1),"accepted history is not repeated on every turn");
  const requests = fs.readFileSync(trace,"utf8").trim().split('\n').map(s=>JSON.parse(s)).filter(r=>r.direction==='in');
  assert.equal(requests.filter(r=>r.method==='thread/start').length,2);
  assert.equal(requests.filter(r=>r.method==='turn/start').length,1);
  assert.equal(requests.filter(r=>r.method==='turn/interrupt').length,0);
  assert.equal(requests.filter(r=>r.method==='thread/start')[1].params.dynamicTools[0].tools[0].name,"operator_read_attachment");
});
