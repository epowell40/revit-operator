import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyRevitToolFailure,
  getRevitToolContractMemoryAttestation,
  filterQuarantinedToolSearchResult,
  findActiveToolQuarantine,
  formatRevitToolContractMemoryForPrompt,
  readRevitToolContractStoreForTests,
  recordRevitToolOutcome,
  setRevitToolQuarantine
} from "../src/codex/revit_tool_contract_memory.js";

function withStore<T>(fn: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-tool-contract-memory-"));
  const previous = process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH;
  process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH = path.join(root, "memory.json");
  try {
    return fn(root);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH;
    else process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("memory runtime attestation does not mistake a missing or fallback store for a fresh campaign", { concurrency: false }, () => {
  withStore(root => {
    const target = path.join(root, "memory.json");
    const empty = { version: "revit-operator.tool-contract-memory.v1", pending_failures: [], failure_receipts: [], corrections: [], quarantines: [] };
    assert.equal(getRevitToolContractMemoryAttestation().initial_empty, false);
    fs.writeFileSync(target, JSON.stringify(empty));
    assert.equal(getRevitToolContractMemoryAttestation().initial_empty, true);
    fs.copyFileSync(target, `${target}.bak`);
    assert.equal(getRevitToolContractMemoryAttestation().initial_empty, false);
    fs.writeFileSync(target, "{");
    const fallback = getRevitToolContractMemoryAttestation();
    assert.equal(fallback.effective_source, "backup");
    assert.equal(fallback.initial_empty, false);
    assert.deepEqual(readRevitToolContractStoreForTests(), empty);
  });
});

test("contract memory persists a compact failed-then-successful correction", { concurrency: false }, () => {
  withStore(() => {
    recordRevitToolOutcome({
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/sheets", body: { action: "count_all", token: "do-not-store", limit: 25 } },
      success: false,
      error: "sheets.action must be 'list' or 'detail'; token=do-not-store-error"
    });
    const correction = recordRevitToolOutcome({
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/sheets", body: { action: "list", token: "still-secret", limit: 25 } },
      success: true
    });

    assert.ok(correction);
    const store = readRevitToolContractStoreForTests();
    assert.equal(store.pending_failures.length, 0);
    assert.equal(store.corrections.length, 1);
    const serialized = JSON.stringify(store);
    assert.doesNotMatch(serialized, /do-not-store|still-secret/);
    assert.match(serialized, /\[redacted\]/);
    assert.match(serialized, /<number>/);
    const prompt = formatRevitToolContractMemoryForPrompt();
    assert.match(prompt, /POST \/revit\/sheets/);
    assert.match(prompt, /"action":"list"/);
    assert.match(prompt, /current live tool docs remain authoritative/i);
  });
});

test("non-contract failures and identical retry arguments do not become corrections", { concurrency: false }, () => {
  withStore(() => {
    recordRevitToolOutcome({ tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/tag-elements", body: { dryRun: false } }, success: false, error: "No professionally clear tag position remained." });
    const nonContractStore = readRevitToolContractStoreForTests();
    assert.equal(nonContractStore.pending_failures.length, 0);
    assert.equal(nonContractStore.failure_receipts[0].classification, "unknown");

    const args = { method: "POST", path: "/revit/views", body: { action: "list" } };
    recordRevitToolOutcome({ tool: "revit_call_tool", arguments: args, success: false, error: "request body must be an object" });
    recordRevitToolOutcome({ tool: "revit_call_tool", arguments: args, success: true });
    assert.equal(readRevitToolContractStoreForTests().corrections.length, 0);
  });
});

test("approved plan-type corrections survive redaction without retaining project data", { concurrency: false }, () => {
  withStore(() => {
    const args = (planType: string) => ({ method: "POST", path: "/revit/create-view", body: {
      action: "create_floor_plan", planType, name: "Private project coordination", levelName: "Private level", levelId: 9946, dryRun: false
    } });
    recordRevitToolOutcome({ tool: "revit_call_tool", arguments: args("private-invalid-plan-type"), success: false,
      error: 'body.planType must be one of "floor", "ceiling", "engineering", "structural"' });
    const correction = recordRevitToolOutcome({ tool: "revit_call_tool", arguments: args("engineering"), success: true });
    assert.ok(correction);
    assert.match(JSON.stringify(correction.accepted_arguments), /"planType":"engineering"/);
    assert.match(JSON.stringify(correction.failed_arguments), /"planType":"<string>"/);
    assert.doesNotMatch(JSON.stringify(readRevitToolContractStoreForTests()), /Private project|Private level|private-invalid|9946/);
    assert.match(formatRevitToolContractMemoryForPrompt(), /"planType":"engineering"/);
  });
});

test("failure classifier preserves the required operational categories", () => {
  assert.equal(classifyRevitToolFailure("request body must be an object"), "contract");
  assert.equal(classifyRevitToolFailure("route not found (404)"), "routing");
  assert.equal(classifyRevitToolFailure("revit_external_event_busy deadline exceeded"), "scheduler");
  assert.equal(classifyRevitToolFailure("No active document"), "revit_context");
  assert.equal(classifyRevitToolFailure("signature unsupported by native API gateway"), "unsupported_api");
  assert.equal(classifyRevitToolFailure("Unhandled NullReferenceException"), "implementation_defect");
  assert.equal(classifyRevitToolFailure("Printer dependency not found"), "environment_dependency");
  assert.equal(classifyRevitToolFailure("Tag position must be professionally clear"), "unknown");
});

test("failure classifier covers exact observed courier and bridge diagnostics", () => {
  const cases = [
    ["<html><head><title>502 Bad Gateway</title></head></html>", "environment_dependency"],
    ["An error occurred while sending the request.", "environment_dependency"],
    ["export-visible-elements.limit out of range.", "contract"],
    ["native-api-mutation-ops affected 4 elements, exceeding transaction.maxAffectedElements=1; the transaction group was rolled back.", "contract"],
    ["native-api-mutation-ops affected existing elements outside transaction.allowedExistingElementIds: 711263; the transaction group was rolled back.", "contract"],
    ["native-api-mutation-ops operation 'setName' targets a document other than the active transaction document.", "revit_context"],
    ["Overriding 'folder' is not allowed.", "contract"],
    ["Unknown memberId: method:System.Object.GetType()", "unsupported_api"]
  ] as const;
  for (const [diagnostic, expected] of cases) {
    assert.equal(classifyRevitToolFailure(diagnostic), expected, diagnostic);
  }
});

test("serialized native failure schema does not teach dropping focused parameter names", { concurrency: false }, () => withStore(() => {
  const failure = JSON.stringify({schema:"revit-operator.revit-bridge-failure.v1",ok:false,code:"revit_bridge_http_error",
    method:"POST",path:"/revit/get-parameters",status:500,
    error:`[revit_bridge_http_error] POST /revit/get-parameters received HTTP 500: ${JSON.stringify({error:"Element not found",type:"System.InvalidOperationException",stack:"native stack ".repeat(100)})}`});
  assert.equal(classifyRevitToolFailure(failure),"revit_context");
  const args={method:"POST",path:"/revit/get-parameters",body:{elementId:1,names:["Comments"]}};
  recordRevitToolOutcome({tool:"revit_call_tool",arguments:args,success:false,error:failure});
  recordRevitToolOutcome({tool:"revit_call_tool",arguments:{...args,body:{elementId:2}},success:true});
  const store=readRevitToolContractStoreForTests();
  assert.equal(store.failure_receipts.length,1);assert.equal(store.failure_receipts[0].classification,"revit_context");
  assert.equal(store.pending_failures.length,0);assert.equal(store.corrections.length,0);
  assert.equal(formatRevitToolContractMemoryForPrompt(),"");
}));

test("structured genuine validation still learns and malformed wrapper metadata cannot learn", { concurrency: false }, () => withStore(() => {
  assert.equal(classifyRevitToolFailure(JSON.stringify({schema:"failure.v1",issues:[{message:"Required",path:["action"]}]})),"contract");
  assert.equal(classifyRevitToolFailure('{"schema":"failure.v1","error":"request body must be'),"unknown");
  recordRevitToolOutcome({tool:"revit_call_tool",arguments:{method:"POST",path:"/revit/views",body:{action:"bad"}},success:false,
    error:JSON.stringify({schema:"failure.v1",error:"views.action must be 'list'",stack:"noise".repeat(500)})});
  const corrected=recordRevitToolOutcome({tool:"revit_call_tool",arguments:{method:"POST",path:"/revit/views",body:{action:"list"}},success:true});
  assert.ok(corrected);assert.match(formatRevitToolContractMemoryForPrompt(),/action must be 'list'/);
  assert.doesNotMatch(formatRevitToolContractMemoryForPrompt(),/noise|failure.v1/);
}));

test("explicit MCP validation issues support redacted correction learning only", { concurrency: false }, () => withStore(() => {
  const failure = {code:"mcp_request_validation_failed",validation_issues:[{field_path:"body.planType",expected_type:"enum",
    expected_constraint:{allowed_values:["floor","engineering"]},actual_value:"confidential-invalid-value"}]};
  assert.equal(classifyRevitToolFailure(JSON.stringify(failure)),"contract");
  for (const value of [{...failure,code:"native_execution_failed"},{validation_issues:failure.validation_issues},
    {...failure,validation_issues:[]},{...failure,validation_issues:[{field_path:"private data",expected_type:"enum"}]},
    {...failure,validation_issues:[{field_path:"body.planType",expected_type:"private data"}]}]) {
    assert.equal(classifyRevitToolFailure(value),"unknown");
  }
  const args={method:"POST",path:"/revit/create-view",body:{planType:"confidential-invalid-value",name:"Private project"}};
  recordRevitToolOutcome({threadId:"structured",tool:"revit_call_tool",arguments:args,success:false,error:failure});
  assert.ok(recordRevitToolOutcome({threadId:"structured",tool:"revit_call_tool",arguments:{...args,body:{planType:"engineering",name:"Private project"}},success:true}));
  const prompt=formatRevitToolContractMemoryForPrompt();
  assert.match(prompt,/"planType":"engineering"/);assert.doesNotMatch(prompt,/confidential-invalid-value|Private project|allowed_values/);
}));

test("legacy false corrections are excluded from prompts without deleting receipts or quarantines", { concurrency: false }, () => withStore(root => {
  recordRevitToolOutcome({threadId:"legacy",tool:"revit_call_tool",arguments:{path:"/revit/get-parameters",body:{names:["Comments"]}},success:false,error:"schema validation failed"});
  recordRevitToolOutcome({threadId:"legacy",tool:"revit_call_tool",arguments:{path:"/revit/get-parameters",body:{}},success:true});
  setRevitToolQuarantine({method:"POST",path:"/revit/unsafe",active:true,reason:"confirmed native defect"});
  const target=path.join(root,"memory.json");const store=JSON.parse(fs.readFileSync(target,"utf8"));
  store.corrections[0].failure_summary=JSON.stringify({schema:"revit-operator.revit-bridge-failure.v1",error:"Element not found"});
  fs.writeFileSync(target,JSON.stringify(store));const before=fs.readFileSync(target,"utf8");
  const prompt=formatRevitToolContractMemoryForPrompt();assert.doesNotMatch(prompt,/get-parameters|Element not found/);assert.match(prompt,/QUARANTINED POST \/revit\/unsafe/);
  assert.equal(fs.readFileSync(target,"utf8"),before,"projection must not rewrite historical store");
  assert.equal(readRevitToolContractStoreForTests().corrections.length,1);
  assert.equal(readRevitToolContractStoreForTests().failure_receipts.length,1);
}));

test("legacy misclassified pending failure cannot become a new correction after success", { concurrency: false }, () => withStore(root => {
  recordRevitToolOutcome({tool:"revit_call_tool",arguments:{path:"/revit/get-parameters",body:{names:["Comments"]}},success:false,error:"schema validation failed"});
  const target=path.join(root,"memory.json"),store=JSON.parse(fs.readFileSync(target,"utf8"));
  store.pending_failures[0].error=JSON.stringify({schema:"failure.v1",error:"Element not found"});fs.writeFileSync(target,JSON.stringify(store));
  assert.equal(recordRevitToolOutcome({tool:"revit_call_tool",arguments:{path:"/revit/get-parameters",body:{}},success:true}),null);
  assert.equal(readRevitToolContractStoreForTests().corrections.length,0);
  assert.equal(readRevitToolContractStoreForTests().failure_receipts.length,1);
}));

test("pending contract failures are paired within their thread instead of across sessions", { concurrency: false }, () => {
  withStore(() => {
    recordRevitToolOutcome({ sessionId: "session-a", threadId: "thread-a", tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/sheets", body: { action: "bad-a" } }, success: false, error: "A action must be 'list'" });
    recordRevitToolOutcome({ sessionId: "session-b", threadId: "thread-b", tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/sheets", body: { action: "bad-b" } }, success: false, error: "B action must be 'list'" });
    const correction = recordRevitToolOutcome({ sessionId: "session-a", threadId: "thread-a", tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/sheets", body: { action: "list" } }, success: true });
    assert.ok(correction);
    assert.match(correction.failure_summary, /^A action/);
    const store = readRevitToolContractStoreForTests();
    assert.equal(store.pending_failures.length, 1);
    assert.equal(store.pending_failures[0].thread_id, "thread-b");
  });
});

test("active quarantine blocks exact route, filters autonomous search, and preserves cleared history", { concurrency: false }, () => {
  withStore(() => {
    const active = setRevitToolQuarantine({
      method: "POST",
      path: "/revit/unsafe-demo",
      active: true,
      reason: "confirmed deterministic bridge defect",
      evidence: "regression receipt 42"
    });
    assert.equal(active.active, true);
    assert.equal(findActiveToolQuarantine("revit_call_tool", { method: "POST", path: "/revit/unsafe-demo" })?.id, active.id);
    assert.equal(findActiveToolQuarantine("revit_call_tool", { method: "GET", path: "/revit/unsafe-demo" }), null);

    const filtered = filterQuarantinedToolSearchResult({
      content: [{
        type: "text",
        text: JSON.stringify({ returned: 2, matches: [
          { method: "POST", path: "/revit/unsafe-demo" },
          { method: "GET", path: "/revit/ping" }
        ] })
      }]
    });
    const parsed = JSON.parse(filtered.content[0].text);
    assert.equal(parsed.returned, 1);
    assert.equal(parsed.quarantine_filtered, 1);
    assert.equal(parsed.matches[0].path, "/revit/ping");

    const cleared = setRevitToolQuarantine({ method: "POST", path: "/revit/unsafe-demo", active: false, reason: "fixed by regression-tested repair" });
    assert.equal(cleared.active, false);
    assert.ok(cleared.cleared_at);
    assert.equal(findActiveToolQuarantine("revit_call_tool", { method: "POST", path: "/revit/unsafe-demo" }), null);
    assert.equal(readRevitToolContractStoreForTests().quarantines.length, 1);
  });
});

test("corrupt primary store recovers from the last valid backup", { concurrency: false }, () => {
  withStore(root => {
    const target = path.join(root, "memory.json");
    setRevitToolQuarantine({ method: "POST", path: "/revit/first", active: true, reason: "first defect" });
    setRevitToolQuarantine({ method: "POST", path: "/revit/second", active: true, reason: "second defect" });
    assert.equal(fs.existsSync(`${target}.bak`), true);
    fs.writeFileSync(target, "{not-json", "utf8");
    const recovered = readRevitToolContractStoreForTests();
    assert.equal(recovered.quarantines.length, 1);
    assert.equal(recovered.quarantines[0].path, "/revit/first");
  });
});
