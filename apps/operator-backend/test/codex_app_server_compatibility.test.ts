import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CODEX_APP_SERVER_COMPATIBILITY, evaluateCodexCliVersion, parseCodexCliVersion, resolveCodexExecutable } from "../src/codex/app_server_compatibility.js";
import { adaptDynamicToolCompletedItem, adaptMcpToolCallResultToDynamicResponse, getFreshRevitEvidenceRequirement, getOperatorAgentBaseInstructions, isSuccessfulFreshRevitEvidence } from "../src/brains/codex_brain.js";
import { resolveOperatorMcpServerSpec } from "../src/codex/mcp_tool_runtime.js";
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

test("Codex app-server launch uses the configured binary, strict config, and an observable receipt", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "src", "codex", "app_server.ts"), "utf8");
  assert.match(source, /OPERATOR_CODEX_BIN/);
  assert.match(source, /\["app-server", "--strict-config"\]/);
  assert.match(source, /getCompatibilityReceipt/);
  assert.match(source, /probeCodexVersion/);
  assert.match(source, /notify\("initialized"/);
  assert.match(source, /handleServerRequest/);
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
