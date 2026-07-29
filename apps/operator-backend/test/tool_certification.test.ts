import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  CERTIFICATION_REASON_CODES,
  EXPOSURE_CHANNELS,
  canonicalJson,
  computeEffectHash,
  computeRequestHash,
  decideTypedMcpAlias,
  generateToolExposurePolicy,
  parseToolCertificationCandidates,
  sealEvidenceRecord,
  sha256NormalizedText,
  type CertificationLevel,
  type EvidenceStatus,
  type JsonValue,
  type ToolCertificationEvidenceFile,
  type ToolCertificationRecord
} from "../src/capabilities/tool_certification.js";
import {
  generatePolicyBytes,
  verifyTypedMcpAliasesAgainstRegistry
} from "../src/tools/generate_tool_exposure_policy.js";
import { findRepoRoot } from "../src/tools/audit_tool_registry.js";

const backendRoot = process.cwd();
const evidencePath = path.join(backendRoot, "config", "tool_certification_evidence.v1.json");
const candidatesPath = path.join(backendRoot, "config", "tool_certification_candidates.v1.json");
const policyPath = path.join(backendRoot, "config", "tool_exposure_policy.v1.json");

type AliasFixtureReceipt = {
  route: string;
  alias: string;
  arguments: Record<string, unknown>;
  request: Record<string, unknown>;
};

const EXACT_ALIAS_FIXTURE_RECEIPT: AliasFixtureReceipt[] = [
  { route: "GET /revit/context", alias: "revit_get_context", arguments: {}, request: {} },
  { route: "GET /revit/native-api-policy", alias: "revit_native_api_policy", arguments: {}, request: {} },
  { route: "GET /revit/ping", alias: "revit_ping", arguments: {}, request: {} },
  { route: "GET /revit/tool-registry", alias: "revit_search_tools", arguments: { query: "views", pathPrefix: "/revit" }, request: {} },
  { route: "GET /revit/tool-registry", alias: "revit_tool_registry", arguments: {}, request: {} },
  { route: "GET /revit/views", alias: "revit_list_views", arguments: {}, request: {} },
  { route: "GET /revit/write-grant-status", alias: "revit_write_grant_status", arguments: {}, request: {} },
  {
    route: "POST /revit/export-image",
    alias: "revit_capture_view",
    arguments: {},
    request: { imageSize: 2048 }
  },
  {
    route: "POST /revit/get-parameters",
    alias: "revit_get_parameters",
    arguments: { elementId: 4978484 },
    request: { elementId: 4978484 }
  },
  {
    route: "POST /revit/native-api-catalog",
    alias: "revit_native_api_catalog",
    arguments: { query: "FilteredElementCollector", namespacePrefix: "Autodesk.Revit.DB", limit: 10 },
    request: { query: "FilteredElementCollector", namespacePrefix: "Autodesk.Revit.DB", offset: 0, limit: 10 }
  },
  {
    route: "POST /revit/native-api-search",
    alias: "revit_native_api_search",
    arguments: { query: "FilteredElementCollector GetElementCount", max: 5 },
    request: { query: "FilteredElementCollector GetElementCount", max: 5 }
  },
  {
    route: "POST /revit/resolve-room-plan-view",
    alias: "revit_resolve_room_plan_view",
    arguments: { roomNumber: "101" },
    request: { roomNumber: "101", maxCandidates: 10 }
  },
  {
    route: "POST /revit/schedules",
    alias: "revit_list_schedules",
    arguments: { action: "list", max: 10 },
    request: { action: "list", exact: false, max: 10 }
  },
  {
    route: "POST /revit/sheets",
    alias: "revit_list_sheets",
    arguments: { action: "count" },
    request: { action: "count", exact: false }
  },
  {
    route: "POST /revit/tool-doc",
    alias: "revit_tool_doc",
    arguments: { method: "POST", path: "/revit/sheets" },
    request: { method: "POST", path: "/revit/sheets" }
  },
  {
    route: "POST /revit/tool-examples",
    alias: "revit_tool_examples",
    arguments: { method: "POST", path: "/revit/schedules" },
    request: { method: "POST", path: "/revit/schedules" }
  },
  {
    route: "POST /revit/tool-search",
    alias: "revit_search_tools",
    arguments: { query: "count sheets", max: 5 },
    request: { query: "count sheets", max: 5 }
  },
  {
    route: "POST /revit/update-schedule-cell",
    alias: "revit_update_schedule_cell",
    arguments: { rowKey: "AHU-1", targetField: "Supply Air", value: "20000 CFM" },
    request: {
      rowKey: "AHU-1",
      targetField: "Supply Air",
      value: "20000 CFM",
      apply: false,
      dryRun: true
    }
  },
  {
    route: "POST /revit/views",
    alias: "revit_query_views",
    arguments: {},
    request: { action: "list", includeTemplates: false, offset: 0, limit: 100 }
  }
];

function literalValue(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  throw new Error(`Unsupported non-literal MCP default in fixture contract: ${node.getText()}`);
}

function typedMcpSchemaDefaults(repoRoot: string): Map<string, Record<string, unknown>> {
  const sourcePath = fs.existsSync(path.join(repoRoot, "apps", "mcp-server", "src", "server.ts"))
    ? path.join(repoRoot, "apps", "mcp-server", "src", "server.ts")
    : path.join(repoRoot, "mcp-server", "src", "server.ts");
  const source = ts.createSourceFile(
    sourcePath,
    fs.readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const defaults = new Map<string, Record<string, unknown>>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === "server"
      && node.expression.name.text === "tool"
      && node.arguments.length >= 3
      && ts.isStringLiteral(node.arguments[0]!)
      && ts.isObjectLiteralExpression(node.arguments[2]!)
    ) {
      const alias = node.arguments[0].text;
      if (!EXACT_ALIAS_FIXTURE_RECEIPT.some(fixture => fixture.alias === alias)) {
        ts.forEachChild(node, visit);
        return;
      }
      const values: Record<string, unknown> = {};
      for (const property of node.arguments[2].properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = property.name.getText(source).replace(/^['"]|['"]$/g, "");
        let defaultCall: ts.CallExpression | null = null;
        const findDefault = (candidate: ts.Node): void => {
          if (
            ts.isCallExpression(candidate)
            && ts.isPropertyAccessExpression(candidate.expression)
            && candidate.expression.name.text === "default"
          ) {
            defaultCall = candidate;
          }
          ts.forEachChild(candidate, findDefault);
        };
        findDefault(property.initializer);
        if (defaultCall) {
          const argument = (defaultCall as ts.CallExpression).arguments[0];
          if (!argument) throw new Error(`Missing default argument for ${alias}.${name}`);
          values[name] = literalValue(argument);
        }
      }
      defaults.set(alias, values);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return defaults;
}

function projectedWireRequest(
  fixture: AliasFixtureReceipt,
  defaults: Map<string, Record<string, unknown>>
): Record<string, unknown> {
  if (fixture.route.startsWith("GET ")) return {};
  const parsedArguments = { ...(defaults.get(fixture.alias) ?? {}), ...fixture.arguments };
  if (fixture.alias === "revit_search_tools") {
    const request: Record<string, unknown> = {
      query: parsedArguments.query,
      max: Math.min(Number(parsedArguments.max), 12)
    };
    for (const key of ["method", "group", "risk"]) {
      if (parsedArguments[key]) request[key] = parsedArguments[key];
    }
    return request;
  }
  if (fixture.alias === "revit_update_schedule_cell") {
    return { ...parsedArguments, apply: false, dryRun: true };
  }
  return parsedArguments;
}

function record(
  levels: string[],
  state: EvidenceStatus | string = "verified",
  overrides: Partial<Omit<ToolCertificationRecord, "request_hash" | "effect_hash" | "record_hash">> = {}
): ToolCertificationRecord {
  return sealEvidenceRecord({
    method: "POST",
    path: "/revit/example",
    typed_mcp_aliases: ["revit_example"],
    request: { action: "count", nested: { limit: 10 } },
    effect: { resolved_effect: "read" },
    requested_channels: [...EXPOSURE_CHANNELS],
    visibility: "candidate",
    evidence: {
      levels: levels as CertificationLevel[],
      state: state as EvidenceStatus,
      provenance: "config/test-fixture.json"
    },
    ...overrides
  });
}

function evidenceFile(records: ToolCertificationRecord[]): ToolCertificationEvidenceFile {
  return {
    schema: "revit-operator.tool-certification-evidence.v1",
    hash_algorithm: "sha256",
    provenance: {
      source: "config/test-fixture.json",
      source_hash: `sha256:${"0".repeat(64)}`
    },
    records
  };
}

function allDenied(input: ToolCertificationRecord): string[] {
  const generated = generateToolExposurePolicy(evidenceFile([input])).records[0]!;
  assert.ok(EXPOSURE_CHANNELS.every(channel => generated.channels[channel].exposed === false));
  return [...new Set(EXPOSURE_CHANNELS.flatMap(channel => generated.channels[channel].reason_codes))];
}

test("canonical identity normalizes object order and CRLF but binds method, path, request, and effect", () => {
  assert.equal(canonicalJson({ b: "line 1\r\nline 2", a: 1 }), canonicalJson({ a: 1, b: "line 1\nline 2" }));
  const first = computeRequestHash("post", "\\revit\\example", { b: 2, a: 1 });
  assert.equal(first, computeRequestHash("POST", "/revit/example", { a: 1, b: 2 }));
  assert.notEqual(first, computeRequestHash("GET", "/revit/example", { a: 1, b: 2 }));
  assert.notEqual(first, computeRequestHash("POST", "/revit/example", { a: 1, b: 3 }));
  assert.notEqual(computeEffectHash({ resolved_effect: "read" }), computeEffectHash({ resolved_effect: "write" }));
});

test("complete cumulative evidence exposes only requested channels at their thresholds", () => {
  const generated = generateToolExposurePolicy(evidenceFile([record(["L0", "L1", "L2", "L3", "L4"] as CertificationLevel[])]));
  const row = generated.records[0]!;
  assert.equal(row.highest_cumulative_level, "L4");
  assert.ok(EXPOSURE_CHANNELS.every(channel => row.channels[channel].exposed));
  assert.match(row.policy_record_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(generated.policy_hash, /^sha256:[0-9a-f]{64}$/);
});

test("typed MCP alias decisions bind one exact route/effect and fail closed for unknown or generic aliases", () => {
  const generated = generateToolExposurePolicy(evidenceFile([record(["L0", "L1", "L2", "L3", "L4"])]));
  assert.deepEqual(decideTypedMcpAlias(generated, "revit_example"), {
    alias: "revit_example",
    exposed: true,
    method: "POST",
    path: "/revit/example",
    effect_hash: generated.records[0]!.effect_hash,
    reason_codes: [CERTIFICATION_REASON_CODES.certified],
    bindings: [{
      method: "POST",
      path: "/revit/example",
      effect_hash: generated.records[0]!.effect_hash,
      exposed: true,
      reason_codes: [CERTIFICATION_REASON_CODES.certified]
    }]
  });
  assert.equal(decideTypedMcpAlias(generated, "unknown_alias").exposed, false);
  assert.deepEqual(
    decideTypedMcpAlias(generated, "unknown_alias").reason_codes,
    [CERTIFICATION_REASON_CODES.typedMcpAliasUnknown]
  );
  assert.equal(decideTypedMcpAlias(generated, "revit_call_tool").exposed, false);
});

test("typed MCP aliases are hash-bound and intentional multi-route aliases use conjunction", () => {
  const original = record(["L0", "L1", "L2", "L3", "L4"]);
  const changed = record(["L0", "L1", "L2", "L3", "L4"], "verified", {
    typed_mcp_aliases: ["revit_example_v2"]
  });
  assert.notEqual(original.record_hash, changed.record_hash);
  assert.notEqual(
    generateToolExposurePolicy(evidenceFile([original])).policy_hash,
    generateToolExposurePolicy(evidenceFile([changed])).policy_hash
  );

  const secondRoute = record(["L0"], "verified", {
    path: "/revit/other",
    typed_mcp_aliases: ["revit_example"]
  });
  const multiRoute = decideTypedMcpAlias(
    generateToolExposurePolicy(evidenceFile([original, secondRoute])),
    "revit_example"
  );
  assert.equal(multiRoute.exposed, false);
  assert.equal(multiRoute.method, null);
  assert.equal(multiRoute.bindings.length, 2);
  assert.ok(multiRoute.bindings.some(binding => binding.exposed));
  assert.ok(multiRoute.bindings.some(binding => !binding.exposed));
});

test("missing, unknown, gapped, stale, revoked, and mismatched evidence fail closed with stable reasons", () => {
  assert.ok(allDenied(record([])).includes(CERTIFICATION_REASON_CODES.missing));
  assert.ok(allDenied(record(["L0", "L1"], "unknown")).includes(CERTIFICATION_REASON_CODES.unknown));
  assert.ok(allDenied(record(["L0", "L2"])).includes(CERTIFICATION_REASON_CODES.gap));
  assert.ok(allDenied(record(["L0", "L1"], "stale")).includes(CERTIFICATION_REASON_CODES.stale));
  assert.ok(allDenied(record(["L0", "L1"], "revoked")).includes(CERTIFICATION_REASON_CODES.revoked));
  assert.ok(allDenied(record(["L0", "L1"], "mismatched")).includes(CERTIFICATION_REASON_CODES.mismatched));
});

test("tampered request, effect, or record hashes fail closed", () => {
  const requestTamper = { ...record(["L0", "L1", "L2", "L3", "L4"]), request: { action: "list" } };
  assert.ok(allDenied(requestTamper).includes(CERTIFICATION_REASON_CODES.requestHashMismatch));
  assert.ok(allDenied(requestTamper).includes(CERTIFICATION_REASON_CODES.recordHashMismatch));

  const effectTamper = { ...record(["L0", "L1", "L2", "L3", "L4"]), effect: { resolved_effect: "write" } };
  assert.ok(allDenied(effectTamper).includes(CERTIFICATION_REASON_CODES.effectHashMismatch));
  assert.ok(allDenied(effectTamper).includes(CERTIFICATION_REASON_CODES.recordHashMismatch));

  const hashTamper = { ...record(["L0", "L1", "L2", "L3", "L4"]), record_hash: `sha256:${"f".repeat(64)}` };
  assert.deepEqual(allDenied(hashTamper), [CERTIFICATION_REASON_CODES.recordHashMismatch]);
});

test("workflow-only certification never exposes direct channels", () => {
  const workflow = record(["L0", "L1", "L2", "L3", "L4"], "verified", {
    path: "/revit/update-schedule-cell",
    requested_channels: ["deterministic_workflow"],
    visibility: "workflow_only",
    effect: { resolved_effect: "write", workflow: "schedule_cell_update_runtime" }
  });
  const row = generateToolExposurePolicy(evidenceFile([workflow])).records[0]!;
  assert.equal(row.channels.deterministic_workflow.exposed, true);
  for (const channel of ["search", "generic_call", "typed_mcp"] as const) {
    assert.equal(row.channels[channel].exposed, false);
    assert.deepEqual(row.channels[channel].reason_codes, [CERTIFICATION_REASON_CODES.workflowOnly]);
  }
});

test("runtime validation rejects malformed methods, paths, enums, arrays, hashes, and provenance", () => {
  const expectRecordReject = (mutate: (value: Record<string, any>) => void, pattern: RegExp): void => {
    const candidate = structuredClone(record(["L0", "L1", "L2", "L3", "L4"])) as unknown as Record<string, any>;
    mutate(candidate);
    assert.throws(() => generateToolExposurePolicy(evidenceFile([candidate as ToolCertificationRecord])), pattern);
  };

  expectRecordReject(value => { value.method = "FETCH"; }, /unsupported|Invalid HTTP method/);
  expectRecordReject(value => { value.path = "/revit/example?unsafe=true"; }, /Invalid exact Revit tool path/);
  expectRecordReject(value => { value.visibility = "canddiate"; }, /visibility has unsupported value/);
  expectRecordReject(value => { value.typed_mcp_aliases = ["RevitExample"]; }, /canonical typed MCP tool name/);
  expectRecordReject(value => { value.typed_mcp_aliases = ["revit_call_tool"]; }, /generic MCP dispatcher/);
  expectRecordReject(value => { value.typed_mcp_aliases = ["revit_z", "revit_a"]; }, /ordinal-sorted aliases/);
  expectRecordReject(value => { value.typed_mcp_aliases = ["revit_a", "revit_a"]; }, /duplicate alias/);
  expectRecordReject(value => { value.requested_channels = ["search", "future"]; }, /requested_channels\[1\] has unsupported value/);
  expectRecordReject(value => { value.requested_channels = ["search", "search"]; }, /requested_channels contains duplicate value/);
  expectRecordReject(value => { value.evidence.levels = ["L0", "LX"]; }, /levels\[1\] has unsupported value/);
  expectRecordReject(value => { value.evidence.levels = ["L0", "L0"]; }, /levels contains duplicate value/);
  expectRecordReject(value => { value.evidence.levels = ["L1", "L0"]; }, /levels must follow canonical order/);
  expectRecordReject(value => { value.evidence.state = "trusted"; }, /state has unsupported value/);
  expectRecordReject(value => { value.request_hash = "sha256:not-a-digest"; }, /request_hash must be a lowercase sha256 digest/);
  expectRecordReject(value => { value.evidence.provenance = "config/other.json"; }, /must match evidence file provenance/);
  expectRecordReject(value => { delete value.requested_channels; }, /missing field: requested_channels/);
  expectRecordReject(value => { value.unexpected = true; }, /unknown field: unexpected/);
});

test("canonical JSON uses normalized ordinal keys and rejects recursive NFC key collisions", () => {
  assert.equal(canonicalJson({ "\u00e4": 3, z: 2, A: 1 }), "{\"A\":1,\"z\":2,\"ä\":3}");
  assert.throws(
    () => canonicalJson({ nested: { "\u00e9": 1, "e\u0301": 2 } }),
    /NFC-normalized key collision/
  );
});

test("candidate provenance hash and exact identity set detect tamper, removal, and replacement", () => {
  const rawEvidence = fs.readFileSync(evidencePath, "utf8");
  const rawCandidates = fs.readFileSync(candidatesPath, "utf8");
  const hashMismatch = JSON.parse(rawEvidence) as any;
  hashMismatch.provenance.source_hash = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => generatePolicyBytes(JSON.stringify(hashMismatch), rawCandidates),
    /source hash does not match/
  );

  const removed = JSON.parse(rawEvidence) as any;
  removed.records.pop();
  assert.throws(
    () => generatePolicyBytes(JSON.stringify(removed), rawCandidates),
    /identity count mismatch/
  );

  const replaced = JSON.parse(rawEvidence) as any;
  replaced.records[0].path = "/revit/replacement";
  assert.throws(
    () => generatePolicyBytes(JSON.stringify(replaced), rawCandidates),
    /identity missing or replaced/
  );

  const provenanceMismatch = JSON.parse(rawEvidence) as any;
  provenanceMismatch.records[0].evidence.provenance = "config/other.json";
  assert.throws(
    () => generatePolicyBytes(JSON.stringify(provenanceMismatch), rawCandidates),
    /must match evidence file provenance/
  );
});

test("candidate aliases exactly match typed wrapper attribution from the corrected registry audit", () => {
  const rawCandidates = fs.readFileSync(candidatesPath, "utf8");
  const candidates = parseToolCertificationCandidates(JSON.parse(rawCandidates));
  const repoRoot = findRepoRoot(backendRoot);
  verifyTypedMcpAliasesAgainstRegistry(candidates, repoRoot);
  assert.equal(candidates.candidates.length, 24);
  assert.equal(candidates.candidates.flatMap(candidate => candidate.typed_mcp_aliases).length, 19);
  assert.equal(new Set(candidates.candidates.flatMap(candidate => candidate.typed_mcp_aliases)).size, 18);
  assert.ok(!candidates.candidates.flatMap(candidate => candidate.typed_mcp_aliases).includes("revit_call_tool"));
  assert.equal(
    candidates.candidates.flatMap(candidate => candidate.typed_mcp_aliases).filter(alias => alias === "revit_search_tools").length,
    2
  );

  const tampered = structuredClone(candidates);
  tampered.candidates.find(candidate => candidate.path === "/revit/ping")!.typed_mcp_aliases = ["revit_unknown"];
  assert.throws(
    () => verifyTypedMcpAliasesAgainstRegistry(tampered, repoRoot),
    /do not match exact registry attribution/
  );

  const candidateHash = sha256NormalizedText(rawCandidates);
  assert.match(candidateHash, /^sha256:[0-9a-f]{64}$/);
});

test("all typed alias bindings record exact wrapper inputs and canonical outbound request bodies", () => {
  const rawCandidates = fs.readFileSync(candidatesPath, "utf8");
  const candidates = parseToolCertificationCandidates(JSON.parse(rawCandidates));
  const repoRoot = findRepoRoot(backendRoot);
  const defaults = typedMcpSchemaDefaults(repoRoot);
  const receipts = candidates.candidates.flatMap(candidate =>
    candidate.typed_mcp_request_fixtures.map(fixture => ({
      route: `${candidate.method} ${candidate.path}`,
      alias: fixture.alias,
      arguments: fixture.arguments as Record<string, unknown>,
      request: fixture.request as Record<string, unknown>
    }))
  ).sort((left, right) =>
    left.route < right.route ? -1 : left.route > right.route ? 1 : left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0
  );

  assert.deepEqual(receipts, EXACT_ALIAS_FIXTURE_RECEIPT);
  assert.equal(receipts.length, 19);
  assert.equal(new Set(receipts.map(item => item.alias)).size, 18);
  for (const fixture of receipts) {
    assert.deepEqual(
      projectedWireRequest(fixture, defaults),
      fixture.request,
      `${fixture.alias} must preserve its exact defaulted outbound request for ${fixture.route}`
    );
  }

  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as ToolCertificationEvidenceFile;
  for (const fixture of receipts) {
    const record = evidence.records.find(item => `${item.method} ${item.path}` === fixture.route);
    assert.ok(record, `Missing evidence route for ${fixture.alias}: ${fixture.route}`);
    assert.deepEqual(record.request, fixture.request);
    assert.equal(record.request_hash, computeRequestHash(record.method, record.path, fixture.request as JsonValue));
  }
});

test("candidate request fixtures fail closed on missing aliases, mismatched requests, or stale hashes", () => {
  const parsed = JSON.parse(fs.readFileSync(candidatesPath, "utf8")) as any;

  const missing = structuredClone(parsed);
  missing.candidates.find((item: any) => item.path === "/revit/ping").typed_mcp_request_fixtures = [];
  assert.throws(
    () => parseToolCertificationCandidates(missing),
    /must provide one ordinal fixture for every typed MCP alias/
  );

  const mismatched = structuredClone(parsed);
  mismatched.candidates.find((item: any) => item.path === "/revit/export-image")
    .typed_mcp_request_fixtures[0].request.imageSize = 1024;
  assert.throws(
    () => parseToolCertificationCandidates(mismatched),
    /must match the candidate exact outbound request/
  );

  const stale = structuredClone(parsed);
  const staleSheet = stale.candidates.find((item: any) => item.path === "/revit/sheets");
  staleSheet.request.exact = true;
  staleSheet.typed_mcp_request_fixtures[0].request.exact = true;
  assert.throws(
    () => parseToolCertificationCandidates(stale),
    /request_hash does not match/
  );
});

test("seeded audit candidates remain unexposed while L2 is absent", () => {
  const evidenceText = fs.readFileSync(evidencePath, "utf8");
  const candidatesText = fs.readFileSync(candidatesPath, "utf8");
  const evidence = JSON.parse(evidenceText) as ToolCertificationEvidenceFile;
  const policy = generateToolExposurePolicy(evidence);
  const reads = evidence.records.filter(item => (item.effect as { resolved_effect?: string }).resolved_effect === "read");
  assert.equal(reads.length, 23);
  assert.equal(evidence.records.length, 24);
  assert.equal(evidence.records.flatMap(item => item.typed_mcp_aliases).length, 19);
  assert.ok(policy.records.every(item => EXPOSURE_CHANNELS.every(channel => !item.channels[channel].exposed)));
  assert.ok(policy.records.every(item => item.channels.search.reason_codes.includes(CERTIFICATION_REASON_CODES.gap)));

  const scheduleCell = policy.records.find(item => item.path === "/revit/update-schedule-cell");
  assert.equal(scheduleCell?.visibility, "workflow_only");
  assert.equal(scheduleCell?.channels.deterministic_workflow.exposed, false);
  assert.equal(scheduleCell?.channels.generic_call.exposed, false);

  const generatedOnce = generatePolicyBytes(evidenceText, candidatesText);
  const generatedAgain = generatePolicyBytes(
    `\uFEFF${evidenceText.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n")}`,
    `\uFEFF${candidatesText.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n")}`
  );
  assert.equal(generatedOnce, generatedAgain);
  assert.equal(generatedOnce, fs.readFileSync(policyPath, "utf8").replace(/\r\n?/g, "\n"));
  assert.doesNotMatch(generatedOnce, /generated_at|[A-Z]:\\|\\Users\\/i);
});
