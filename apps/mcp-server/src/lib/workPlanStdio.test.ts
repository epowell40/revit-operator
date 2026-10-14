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
  const transport = new StdioClientTransport({ command: process.execPath, args: import.meta.url.endsWith(".ts") ? ["--loader", "ts-node/esm", path.join(process.cwd(), "src", "server.ts")] : [path.join(process.cwd(), "dist", "server.js")], cwd: process.cwd(),
    env: { ...env, OPERATOR_API_BASE_URL: `http://127.0.0.1:${port}`, OPERATOR_AUTH_MODE: "shared_token", OPERATOR_TOKEN: "test-only",
      OPERATOR_WORKSPACE_ROOT: workspace, REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" }, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "work-plan-stdio", version: "1.0.0" }, { capabilities: {} });
  t.after(async () => { await client.close(); await transport.close(); await new Promise<void>((resolve,reject) => backend.close(error => error ? reject(error) : resolve())); fs.rmSync(workspace, { recursive: true, force: true }); });
  await client.connect(transport);
  const workPlanTool = (await client.listTools()).tools.find(tool => tool.name === "operator_manage_work_plan");
  assert(workPlanTool);
  assert.match(workPlanTool.description??'',/at most 24 entries.*at most 1000 characters/);
  assert.match(workPlanTool.description??'',/Correct rejected report arguments without redoing model edits/);
  for(const action of ["defer","resume_item"]) {
    const meta={"revit-operator/assignment-kernel-binding-v2":{assignment_id:"area-assignment",run_id:"area-run",session_id:"area-session",generation:1,principal_id:"test"}};
    assert.notEqual((await client.callTool({name:"operator_manage_work_plan",arguments:{action,itemId:"coordination",reason:"Need architect response"},_meta:meta})).isError,true);
    assert.equal(requests.at(-1).body.reason,"Need architect response");
    assert.equal(requests.at(-1).body.action,action);
  }
  requests.splice(0,requests.length);
  assert.match(workPlanTool.description ?? "", /\/revit\/view-owned-detailing/,
    "the agent must be told that a native copied-view read can close a detailing inspection");
  const binding = { assignment_id: "area-assignment", run_id: "area-run", session_id: "area-session", generation: 1, principal_id: "test" };
  const _meta = { "revit-operator/assignment-kernel-binding-v2": binding };
  const scopeCheck={category:'OST_ElectricalEquipmentTags',view_ids:[123],subject_family_names:['Panelboard'],has_leader:false};
  assert.notEqual((await client.callTool({name:'operator_manage_work_plan',arguments:{action:'check_scope',itemId:'typical',operationIds:['inventory','property'],scopeCheck},_meta})).isError,true);
  assert.deepEqual(requests.at(-1).body.scope_check,scopeCheck);
  const scopeRequests=requests.length;
  for(const arguments_ of [{action:'status',scopeCheck},{action:'check_scope',scopeCheck},
    {action:'check_scope',scopeCheck:{...scopeCheck,pass:true},itemId:'typical',operationIds:['inventory']}])
    assert.equal((await client.callTool({name:'operator_manage_work_plan',arguments:arguments_,_meta})).isError,true);
  assert.equal(requests.length,scopeRequests,'invalid scope arguments must not cross the HTTP boundary');
  const graphicsScope={kind:'category_graphics_v1',category:'Plumbing Fixtures',disciplines:['Electrical'],view_types:['FloorPlan','Section','Elevation','ThreeD'],halftone:true,hidden_policy:'exclude_hidden'};
  assert.notEqual((await client.callTool({name:'operator_manage_work_plan',arguments:{action:'check_scope',itemId:'typical',operationIds:['view-census','read-all-views'],scopeCheck:graphicsScope},_meta})).isError,true);
  assert.deepEqual(requests.at(-1).body.scope_check,graphicsScope);
  const noOpaqueIds=await client.callTool({name:'operator_manage_work_plan',arguments:{action:'check_scope',itemId:'plumbing-halftone',scopeCheck:{...graphicsScope,category:'OST_PlumbingFixtures',view_types:['FloorPlan','CeilingPlan','EngineeringPlan','Section','Elevation','ThreeD']}},_meta});
  assert.notEqual(noOpaqueIds.isError,true,'retained49 second request must reach host evidence selection without opaque operation IDs');
  assert.equal(requests.at(-1).body.operation_ids,undefined);
  const graphicsRequests=requests.length;
  for(const scope of [{...graphicsScope,pass:true},{...graphicsScope,view_ids:[123]},{...graphicsScope,view_types:['DrawingSheet']},{...graphicsScope,halftone:'true'},{...graphicsScope,hidden_policy:'verified_unchanged'}])
    assert.equal((await client.callTool({name:'operator_manage_work_plan',arguments:{action:'check_scope',itemId:'typical',operationIds:['view-census'],scopeCheck:scope},_meta})).isError,true);
  assert.equal(requests.length,graphicsRequests,'graphics selectors cannot claim a pass or drop census views at the MCP boundary');
  requests.splice(0,requests.length);
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
  const checkpoint = { claimed_completed: ["Drafted visible routes"], remaining_work: ["Independent grade pending"], uncertainties: ["Unknown drawing elevation"] };
  assert.notEqual((await client.callTool({ name: "operator_manage_work_plan", arguments: { action: "propose_completion", completionProposal: checkpoint }, _meta })).isError, true);
  assert.deepEqual(requests.at(-1).body, { assignment_id: binding.assignment_id, run_id: binding.run_id, session_id: binding.session_id, generation: 1,
    action: "propose_completion", completion_proposal: checkpoint });
  const followup = { command_id: "split-scope", item_id: "followup:2:remaining_work:0", expected_version: 2,
    disposition: "superseded", reason: "The unresolved clause is retained separately.",
    replacements: [{ kind: "remaining_work", text: "Confirm the exterior devices." }] };
  assert.notEqual((await client.callTool({ name: "operator_manage_work_plan", arguments: { action: "update_followup", followup }, _meta })).isError, true);
  assert.deepEqual(requests.at(-1).body, { assignment_id: binding.assignment_id, run_id: binding.run_id, session_id: binding.session_id, generation: 1,
    action: "update_followup", followup });
  assert.notEqual((await client.callTool({ name: "operator_manage_work_plan", arguments: { action: "status", followupStart: 8 }, _meta })).isError, true);
  assert.equal(requests.at(-1).body.followup_start, 8);
  const followupCount = requests.length;
  for (const args of [{ action: "update_followup" }, { action: "status", followup }, { action: "update_followup", followup, completionProposal: checkpoint },
    { action: "update_followup", followup: { ...followup, expected_version: 0 } },
    { action: "update_followup", followup: { ...followup, verified: true } },
    { action: "update_followup", followup: { ...followup, replacements: [{ kind: "remaining_work", text: "x".repeat(1001) }] } },
    { action: "update_followup", followup: { ...followup, replacements: Array(9).fill({ kind: "remaining_work", text: "Unresolved" }) } },
    { action: "status", followupStart: -1 }])
    assert.equal((await client.callTool({ name: "operator_manage_work_plan", arguments: args, _meta })).isError, true);
  assert.equal((await client.callTool({ name: "operator_manage_work_plan", arguments: { action: "update_followup", followup } })).isError, true);
  assert.equal(requests.length, followupCount, "invalid followups must not reach HTTP or obtain an untrusted binding");
  const count = requests.length;
  for (const args of [{ action: "propose_completion" }, { action: "status", completionProposal: checkpoint },
    { action: "propose_completion", completionProposal: { ...checkpoint, uncertainties: ["x".repeat(1001)] } },
    { action: "propose_completion", completionProposal: checkpoint, items },
    { action: "propose_completion", completionProposal: { ...checkpoint, execution_policy: "local_advisory_v1" } }])
    assert.equal((await client.callTool({ name: "operator_manage_work_plan", arguments: args, _meta })).isError, true);
  assert.equal(requests.length, count, "invalid proposals must not reach the backend");
  assert.deepEqual(requests[2].body, { assignment_id: binding.assignment_id, run_id: binding.run_id, session_id: binding.session_id,
    generation: 1, action: "status", start: 8, operation_start: 16, assumption_start: 2 });
  const locationHint={status:"candidate",reason:"Located mark on full sheet; recheck model address before editing.",
    source:{attachment_id:"binder",filename:"drawings.pdf",sha256:"a".repeat(64),page:4,page_count:26,sheet_label:"E010",region:{min_u:.48,min_v:.6,max_u:.76,max_v:.727}},
    native:{document_fingerprint:"document-a",view_id:1661139,view_name:"CONCEPTUAL POWER DISTRIBUTION",sheet_number:"E010"}};
  assert.notEqual((await client.callTool({name:"operator_manage_work_plan",arguments:{action:"locate",itemId:"room_a_supply",locationHint},_meta})).isError,true);
  assert.deepEqual(requests.at(-1).body,{assignment_id:binding.assignment_id,run_id:binding.run_id,session_id:binding.session_id,generation:1,
    action:"locate",item_id:"room_a_supply",location_hint:locationHint});
  const locationCount=requests.length;
  for(const args of [{action:"locate",itemId:"room_a_supply"},{action:"locate",locationHint},
    {action:"status",locationHint},{action:"locate",itemId:"room_a_supply",locationHint,operationIds:["native-op-a"]},
    {action:"locate",itemId:"room_a_supply",locationHint:{...locationHint,verified:true}},
    {action:"locate",itemId:"room_a_supply",locationHint:{...locationHint,source:{...locationHint.source,page:27}}},
    {action:"locate",itemId:"room_a_supply",locationHint:{...locationHint,source:{...locationHint.source,region:{min_u:.8,min_v:.6,max_u:.7,max_v:.8}}}},
    {action:"locate",itemId:"room_a_supply",locationHint:{status:"candidate",reason:"No address"}},
    {action:"locate",itemId:"room_a_supply",locationHint:{...locationHint,native:{...locationHint.native,view_id:0}}}])
    assert.equal((await client.callTool({name:"operator_manage_work_plan",arguments:args,_meta})).isError,true);
  assert.equal((await client.callTool({name:"operator_manage_work_plan",arguments:{action:"locate",itemId:"room_a_supply",locationHint}})).isError,true);
  assert.equal(requests.length,locationCount,"invalid or unbound locations must not reach HTTP");
});
