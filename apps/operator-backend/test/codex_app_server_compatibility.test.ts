import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { __testOnlyResetCodexVersionProbeCache, probeCodexVersion } from "../src/codex/app_server.js";
import { CODEX_APP_SERVER_COMPATIBILITY, evaluateCodexCliVersion, parseCodexCliVersion, resolveCodexExecutable } from "../src/codex/app_server_compatibility.js";
import { adaptDynamicToolCompletedItem, adaptMcpToolCallResultToDynamicResponse, getFreshRevitEvidenceRequirement, getOperatorAgentBaseInstructions, isMissingCodexThreadError, isSuccessfulFreshRevitEvidence } from "../src/brains/codex_brain.js";
import { EAGER_OPERATOR_MCP_TOOLS, resolveOperatorMcpServerSpec } from "../src/codex/mcp_tool_runtime.js";
import { canonicalizeProtocolJson, sortProtocolFiles } from "../src/tools/verify_codex_app_server_protocol.js";

test("Codex app-server compatibility pins the generated protocol version", () => {
  assert.equal(parseCodexCliVersion("codex-cli 0.144.5\n"), "0.144.5");
  const receipt = evaluateCodexCliVersion("codex-cli 0.144.5", {});
  assert.equal(receipt.compatible, true);
  assert.equal(receipt.actual_version, CODEX_APP_SERVER_COMPATIBILITY.codex_cli_version);
  assert.equal(CODEX_APP_SERVER_COMPATIBILITY.generated_typescript.file_count, 671);
  assert.equal(CODEX_APP_SERVER_COMPATIBILITY.generated_json_schema.file_count, 337);
});

test("Codex app-server compatibility rejects drift unless explicitly overridden", () => {
  assert.throws(() => evaluateCodexCliVersion("codex-cli 0.145.0", {}), /pinned to 0\.144\.5/);
  const receipt = evaluateCodexCliVersion("codex-cli 0.145.0", { OPERATOR_CODEX_ALLOW_UNPINNED: "1" });
  assert.equal(receipt.compatible, false);
  assert.equal(receipt.override_used, true);
});

test("Codex protocol receipts use platform-independent ordinal path ordering", () => {
  const root = path.resolve("protocol-root");
  const files = [path.join(root, "a.json"), path.join(root, "B.json"), path.join(root, "nested", "c.json")];
  assert.deepEqual(sortProtocolFiles(root, files).map(file => path.relative(root, file).replace(/\\/g, "/")), [
    "B.json",
    "a.json",
    "nested/c.json"
  ]);
});

test("Codex protocol receipts canonicalize JSON object order without changing array order", () => {
  assert.equal(JSON.stringify(canonicalizeProtocolJson({ z: 1, a: { d: 2, b: 3 }, list: [{ y: 2, x: 1 }] })),
    '{"a":{"b":3,"d":2},"list":[{"x":1,"y":2}],"z":1}');
});

test("Codex executable resolution preserves explicit non-shim binaries", () => {
  assert.equal(resolveCodexExecutable("/opt/revitoperator/bin/codex", "linux", {}), "/opt/revitoperator/bin/codex");
  assert.equal(resolveCodexExecutable("C:\\tools\\codex-custom.exe", "win32", {}), "C:\\tools\\codex-custom.exe");
});

test("backend restart recovery recognizes a stale Codex app-server thread", () => {
  assert.equal(isMissingCodexThreadError(new Error("thread not found: thread_123")), true);
  assert.equal(isMissingCodexThreadError(new Error("transport closed")), false);
});

test("Codex executable resolution supports npm's hoisted Windows platform package", () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "operator-codex-appdata-"));
  try {
    const native = path.join(appData, "npm", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, "fixture");
    assert.equal(resolveCodexExecutable("codex", "win32", { APPDATA: appData }), native);
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
  }
});

test("Codex app-server launch uses the configured binary, strict config, and an observable receipt", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "src", "codex", "app_server.ts"), "utf8");
  assert.match(source, /OPERATOR_CODEX_BIN/);
  assert.match(source, /\["app-server", "--strict-config"\]/);
  assert.match(source, /getCompatibilityReceipt/);
  assert.match(source, /probeCodexVersion/);
  assert.match(source, /notify\("initialized"/);
  assert.match(source, /handleServerRequest/);
});

test("Codex version probing retries a timed-out cold start and caches the successful result", async () => {
  __testOnlyResetCodexVersionProbeCache();
  let spawnCount = 0;
  const spawnProcess = (() => {
    spawnCount += 1;
    const proc = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: string) => boolean;
    };
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {
      queueMicrotask(() => proc.emit("exit", null, "SIGKILL"));
      return true;
    };
    if (spawnCount > 1) {
      queueMicrotask(() => {
        proc.stdout.write("codex-cli 0.144.5\n");
        proc.emit("exit", 0, null);
      });
    }
    return proc;
  }) as unknown as typeof import("node:child_process").spawn;

  const options = { timeoutMs: 100, retryDelayMs: 0, maxAttempts: 2, spawnProcess };
  assert.equal(await probeCodexVersion("codex-test", "/workspace", { PATH: "/fixture" }, options), "codex-cli 0.144.5");
  assert.equal(spawnCount, 2);
  assert.equal(await probeCodexVersion("codex-test", "/workspace", { PATH: "/fixture" }, options), "codex-cli 0.144.5");
  assert.equal(spawnCount, 2);
  __testOnlyResetCodexVersionProbeCache();
});

test("MCP results adapt to app-server dynamic tool responses without losing errors or images", () => {
  assert.deepEqual(adaptMcpToolCallResultToDynamicResponse({ content: [{ type: "text", text: "ok" }] }), {
    contentItems: [{ type: "inputText", text: "ok" }],
    success: true
  });
  assert.deepEqual(adaptMcpToolCallResultToDynamicResponse({ content: [{ type: "image", mimeType: "image/png", data: "AA==" }], isError: true }), {
    contentItems: [{ type: "inputImage", imageUrl: "data:image/png;base64,AA==" }],
    success: false
  });
});

test("app-server dynamic Revit parameter reads are compacted before returning to Codex", () => {
  const items = Array.from({ length: 500 }, (_, index) => ({
    id: 4000 + index,
    name: `Panel ${index}`,
    category: "Electrical Equipment",
    parameterDetails: [{ name: "Panel Name", value: `B2-G-${index}`, storageType: "String", isReadOnly: false }]
  }));
  const response = adaptMcpToolCallResultToDynamicResponse(
    { content: [{ type: "text", text: JSON.stringify({
      selector: "allModelInstances",
      valueContains: "-G-",
      caseSensitive: true,
      totalScanned: 368985,
      totalMatched: 1734,
      returnedCount: 500,
      offset: 0,
      hasMore: true,
      nextOffset: 500,
      items
    }) }] },
    { tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/get-parameters", body: { valueContains: "-G-" } } }
  );
  const compacted = JSON.parse((response.contentItems[0] as { text: string }).text);
  assert.equal(compacted._compacted, true);
  assert.equal(compacted.compaction, "parameter-evidence-summary");
  assert.equal(compacted.totalMatched, 1734);
  assert.equal(compacted.hasMore, true);
  assert.equal(compacted.nextOffset, 500);
  assert.equal(compacted.matchingElementIds.length, 64);
  assert.equal(compacted.matchingElementIdsOmitted, 436);
  assert.equal(compacted.evidenceSample.length, 16);
  assert.equal((response.contentItems[0] as { text: string }).text.includes("Panel 499"), false);
});

test("app-server preserves bounded explicit sheet parameter evidence in one compact response", () => {
  const elementIds = Array.from({ length: 17 }, (_, index) => 1400000 + index);
  const names = ["Sheet Number", "Sheet Group", "Discipline", "Drawn By", "Checked By"];
  const response = adaptMcpToolCallResultToDynamicResponse(
    { content: [{ type: "text", text: JSON.stringify({
      selector: "elementIds",
      totalMatched: 17,
      returnedCount: 17,
      hasMore: false,
      items: elementIds.map((id, index) => ({
        id,
        name: `M${String(index).padStart(3, "0")}`,
        category: "Sheets",
        parameterDetails: names.map((name) => ({
          name,
          value: name === "Checked By" && index === 16 ? "" : `${name}-${index}`,
          storageType: "String",
          isReadOnly: false
        }))
      }))
    }) }] },
    { tool: "revit_call_tool", arguments: {
      method: "POST",
      path: "/revit/get-parameters",
      body: { elementIds, names, includeEmpty: true }
    } }
  );
  const compacted = JSON.parse((response.contentItems[0] as { text: string }).text);
  assert.deepEqual(compacted.requestedParameterNames, names);
  assert.equal(compacted.evidenceSample.length, 85);
  assert.equal(compacted.evidenceOmitted, 0);
  assert.equal(compacted.evidenceSample.at(-1).elementId, elementIds.at(-1));
  assert.equal(compacted.evidenceSample.at(-1).parameterName, "Checked By");
  assert.equal(compacted.evidenceSample.at(-1).value, "");
});

test("completed dynamic tool items retain exact tool arguments, output, and failures for journaling", () => {
  assert.deepEqual(adaptDynamicToolCompletedItem({
    type: "dynamicToolCall",
    namespace: "revit_operator",
    tool: "revit_list_sheets",
    arguments: { action: "count" },
    status: "completed",
    contentItems: [{ type: "inputText", text: "{\"totalSheets\":345}" }],
    success: true,
    durationMs: 42
  }), {
    server: "revit_operator",
    tool: "revit_list_sheets",
    status: "completed",
    arguments: { action: "count" },
    duration_ms: 42,
    result: [{ type: "inputText", text: "{\"totalSheets\":345}" }],
    error: null,
    success: true
  });
  assert.equal(adaptDynamicToolCompletedItem({
    type: "dynamicToolCall",
    tool: "revit_ping",
    status: "failed",
    contentItems: [{ type: "inputText", text: "bridge unavailable" }],
    success: false
  })?.error, "bridge unavailable");
});

test("Codex instructions route exact sheet totals through the typed sheet counter", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /Sheet-count rule/);
  assert.match(instructions, /revit_list_sheets/);
  assert.match(instructions, /action:\"count\"/);
  assert.match(instructions, /Do not infer sheet totals/);
  assert.match(instructions, /Schedule-row edit rule/);
  assert.match(instructions, /revit_update_schedule_cell/);
});

test("Codex PDF instructions keep preflight output under the Operator workspace", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /PDF preflight or dry-run/);
  assert.match(instructions, /omit `outputFolder`[\s\S]*`artifacts\/prints`/);
  assert.match(instructions, /never invent an OS temp\/test-run directory/);
  assert.match(instructions, /rejects `outputFolder`[\s\S]*retry once with `artifacts\/prints`/);
  assert.match(instructions, /dry-run or file-verification receipt/);
});

test("Codex instructions diagnose cross-floor visibility beyond view depth", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /View-visibility diagnosis rule/);
  assert.match(instructions, /exact PlanViewRange planes/);
  assert.match(instructions, /Underlay base\/top\/orientation/);
  assert.match(instructions, /applied view template/);
  assert.match(instructions, /Never attribute below-floor visibility to View Depth alone/);
});

test("Codex instructions use bounded bulk sheet parameter readback and target-aware exception verification", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /Sheet\/titleblock parameter reads and verification must preserve sheet identity/);
  assert.match(instructions, /For one sheet, call `revit_verify_parameter_on_sheet` directly/);
  assert.match(instructions, /For two or more sheets[\s\S]*one bounded `revit_get_parameters` call/);
  assert.match(instructions, /do not fan out one call per sheet or parameter/);
  assert.match(instructions, /only for bulk rows that are missing or ambiguous/);
});

test("core Revit lifecycle recovery is available before deferred capability discovery", () => {
  assert.equal(EAGER_OPERATOR_MCP_TOOLS.has("revit_open_model"), true);
});

test("Codex instructions reuse known primitives before capability discovery", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /reuse an exact primitive/i);
  assert.match(instructions, /Call `operator_discover_capabilities` only when/i);
  assert.match(instructions, /session-cached/i);
  assert.match(instructions, /document\/model results are never satisfied from that cache/i);
  assert.doesNotMatch(instructions, /call `operator_discover_capabilities` first/i);
});

test("Codex instructions keep negative searches scoped and require physical MEP serving connections", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /Negative-result scope rule/);
  assert.match(instructions, /category-agnostic identity discovery/);
  assert.match(instructions, /no `category`\/`categories`/);
  assert.match(instructions, /MEP serving-connection precondition/);
  assert.match(instructions, /nearest pipe\/duct is not the serving system/);
  assert.match(instructions, /Do not request a write grant until connectivity/);
});

test("Codex instructions investigate duplicates with spatial and network evidence", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /Duplicate-element investigation rule/);
  assert.match(instructions, /do not rule duplicates out when those checks return zero/);
  assert.match(instructions, /project-scope `\/revit\/find-elements` inventory/);
  assert.match(instructions, /`includeGeometry:true`/);
  assert.match(instructions, /Every document-scope `\/revit\/find-elements` request must include a real/);
  assert.match(instructions, /`limit` alone is not a bounded predicate/);
  assert.match(instructions, /user-facing aliases such as `air terminals` are accepted/);
  assert.match(instructions, /do not export every view before trying this complete inventory/);
  assert.match(instructions, /`spatialDuplicateCandidates`/);
  assert.match(instructions, /unique Marks are not duplicate-instance proof/);
  assert.match(instructions, /creation-adjacency triage signal, never as duplicate proof/);
  assert.match(instructions, /same-category and same-family\/type instances/);
  assert.match(instructions, /overlapping bounding-box footprints or insertion-point\/center separation relative to element size/);
  assert.match(instructions, /Compare host, level, facing\/hand orientation, parameters, and connector\/network relationships/);
  assert.match(instructions, /opposite-facing peers on different connector ports may be intentional/);
  assert.match(instructions, /rollback\/dry-run delete/);
});

test("Codex instructions require an executable create operation for a new-view preview", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /New-view preview truth/);
  assert.match(instructions, /resolving a source view, rooms, crop bounds, or geometry is discovery only/);
  assert.match(instructions, /`\/revit\/transaction-plan` with `duplicateView` or `createDependentView`/);
  assert.match(instructions, /crop-computation or MEP-workflow receipt alone does not preview/);
});

test("fresh Revit evidence contracts reject stale or unrelated sheet-count claims", () => {
  const requirement = getFreshRevitEvidenceRequirement("How many sheets are in the model?");
  assert.equal(requirement.kind, "sheet_count");
  assert.match(requirement.prompt, /Do not answer from memory/);
  assert.equal(isSuccessfulFreshRevitEvidence(requirement, {
    server: "revit_operator",
    tool: "revit_tool_registry",
    arguments: {},
    success: true,
    status: "completed"
  }), false);
  assert.equal(isSuccessfulFreshRevitEvidence(requirement, {
    server: "revit_operator",
    tool: "revit_list_sheets",
    arguments: { action: "count", exact: true },
    success: true,
    status: "completed"
  }), true);
  assert.equal(isSuccessfulFreshRevitEvidence(requirement, {
    server: "revit-operator",
    tool: "revit_call_tool",
    arguments: { path: "/revit/sheets", body: { action: "count", exact: true } },
    status: "success"
  }), true);
  assert.equal(isSuccessfulFreshRevitEvidence(requirement, {
    server: "revit_operator",
    tool: "revit_list_sheets",
    arguments: { action: "count" },
    success: false,
    status: "failed",
    error: "bridge unavailable"
  }), false);
});

test("fresh Revit evidence is required for live-model work but not conceptual help", () => {
  assert.equal(getFreshRevitEvidenceRequirement("List the equipment in the active model").kind, "revit_tool");
  assert.equal(getFreshRevitEvidenceRequirement("What is a Revit sheet?").required, false);
});

test("backend MCP adapter resolves the sibling built server", () => {
  const spec = resolveOperatorMcpServerSpec(process.cwd());
  assert.equal(path.basename(spec.serverJs), "server.js");
  assert.equal(fs.existsSync(spec.serverJs), true);
});
