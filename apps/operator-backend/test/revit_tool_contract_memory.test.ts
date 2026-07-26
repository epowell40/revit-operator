import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyRevitToolFailure,
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
