import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("durable multi-room plan uses authenticated host binding and rejects invalid calls before HTTP", async t => {
  const requests: any[] = [];
  const backend = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const port = (backend.address() as any).port;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "operator-work-plan-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), "dist", "server.js")], cwd: process.cwd(),
    env: { ...env, OPERATOR_API_BASE_URL: `http://127.0.0.1:${port}`, OPERATOR_AUTH_MODE: "shared_token", OPERATOR_TOKEN: "test-only",
      OPERATOR_WORKSPACE_ROOT: workspace, REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" }, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "work-plan-stdio", version: "1.0.0" }, { capabilities: {} });
  t.after(async () => { await client.close(); await transport.close(); await new Promise<void>((resolve,reject) => backend.close(error => error ? reject(error) : resolve())); fs.rmSync(workspace, { recursive: true, force: true }); });
  await client.connect(transport);
  assert((await client.listTools()).tools.some(tool => tool.name === "operator_manage_work_plan"));
  const binding = { assignment_id: "area-assignment", run_id: "area-run", session_id: "area-session", generation: 1, principal_id: "test" };
  const _meta = { "revit-operator/assignment-kernel-binding-v2": binding };
  const items = [{ itemId: "room_a_supply", description: "Supply branch in first room", sourceBasis: "Source plan, first room" },
    { itemId: "room_b_supply", description: "Supply branch in second room", sourceBasis: "Source plan, second room" }];
  const declared = await client.callTool({ name: "operator_manage_work_plan", arguments: { action: "declare", items, assumptions: ["Elevation inferred from context"] }, _meta });
  assert.notEqual(declared.isError, true);
  assert.deepEqual(requests[0], { path: "/api/assignments/v2/work-plan", body: {
    assignment_id: binding.assignment_id, run_id: binding.run_id, session_id: binding.session_id, generation: 1,
    action: "declare", declaration: { items: items.map(item => ({ item_id: item.itemId, description: item.description, source_basis: item.sourceBasis })), assumptions: ["Elevation inferred from context"] }
  } });
  for (const args of [{ action: "declare" }, { action: "complete", itemId: "room_a_supply" }, { action: "complete", itemId: "room_a_supply", operationIds: [] },
    { action: "status", items }, { action: "delete", itemId: "room_b_supply" }, { action: "declare", items: [{ ...items[0], itemId: "../bad" }] }]) {
    assert.equal((await client.callTool({ name: "operator_manage_work_plan", arguments: args, _meta })).isError, true);
  }
  assert.equal((await client.callTool({ name: "operator_manage_work_plan", arguments: { action: "status" } })).isError, true);
  assert.equal(requests.length, 1);
  assert.notEqual((await client.callTool({ name: "operator_manage_work_plan", arguments: { action: "complete", itemId: "room_a_supply", operationIds: ["native-op-a"] }, _meta })).isError, true);
  assert.deepEqual(requests[1].body.operation_ids, ["native-op-a"]);
  assert.notEqual((await client.callTool({ name: "operator_manage_work_plan", arguments: { action: "status", start: 8, operationStart: 16, assumptionStart: 2 }, _meta })).isError, true);
  const qc={itemId:"room_qc",kind:"inspection",dependsOn:["room_a_supply","room_b_supply"],description:"Inspect completed branches",sourceBasis:"Drawing connectivity"};
  assert.notEqual((await client.callTool({name:"operator_manage_work_plan",arguments:{action:"declare",items:[qc]},_meta})).isError,true);
  assert.deepEqual(requests.at(-1).body.declaration.items[0],{item_id:qc.itemId,kind:qc.kind,depends_on:qc.dependsOn,description:qc.description,source_basis:qc.sourceBasis});
  assert.deepEqual(requests[2].body, { assignment_id: binding.assignment_id, run_id: binding.run_id, session_id: binding.session_id,
    generation: 1, action: "status", start: 8, operation_start: 16, assumption_start: 2 });
});
