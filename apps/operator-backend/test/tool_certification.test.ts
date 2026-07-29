import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  CERTIFICATION_REASON_CODES,
  EXPOSURE_CHANNELS,
  canonicalJson,
  computeEffectHash,
  computeRequestHash,
  generateToolExposurePolicy,
  sealEvidenceRecord,
  type CertificationLevel,
  type EvidenceStatus,
  type ToolCertificationEvidenceFile,
  type ToolCertificationRecord
} from "../src/capabilities/tool_certification.js";
import { generatePolicyBytes } from "../src/tools/generate_tool_exposure_policy.js";

const backendRoot = process.cwd();
const evidencePath = path.join(backendRoot, "config", "tool_certification_evidence.v1.json");
const policyPath = path.join(backendRoot, "config", "tool_exposure_policy.v1.json");

function record(
  levels: string[],
  state: EvidenceStatus | string = "verified",
  overrides: Partial<Omit<ToolCertificationRecord, "request_hash" | "effect_hash" | "record_hash">> = {}
): ToolCertificationRecord {
  return sealEvidenceRecord({
    method: "POST",
    path: "/revit/example",
    request: { action: "count", nested: { limit: 10 } },
    effect: { resolved_effect: "read" },
    requested_channels: [...EXPOSURE_CHANNELS],
    visibility: "candidate",
    evidence: { levels, state, provenance: "test-fixture" },
    ...overrides
  });
}

function evidenceFile(records: ToolCertificationRecord[]): ToolCertificationEvidenceFile {
  return {
    schema: "revit-operator.tool-certification-evidence.v1",
    hash_algorithm: "sha256",
    provenance: { source: "fixture", source_hash: "sha256:fixture" },
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

test("missing, unknown, gapped, stale, revoked, and mismatched evidence fail closed with stable reasons", () => {
  assert.ok(allDenied(record([])).includes(CERTIFICATION_REASON_CODES.missing));
  assert.ok(allDenied(record(["L0", "L1"], "unknown")).includes(CERTIFICATION_REASON_CODES.unknown));
  assert.ok(allDenied(record(["L0", "L2"])).includes(CERTIFICATION_REASON_CODES.gap));
  assert.ok(allDenied(record(["L0", "LX"])).includes(CERTIFICATION_REASON_CODES.unknownLevel));
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

  const hashTamper = { ...record(["L0", "L1", "L2", "L3", "L4"]), record_hash: "sha256:tampered" };
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

test("seeded audit candidates remain unexposed while L2 is absent", () => {
  const evidenceText = fs.readFileSync(evidencePath, "utf8");
  const evidence = JSON.parse(evidenceText) as ToolCertificationEvidenceFile;
  const policy = generateToolExposurePolicy(evidence);
  const reads = evidence.records.filter(item => (item.effect as { resolved_effect?: string }).resolved_effect === "read");
  assert.equal(reads.length, 23);
  assert.equal(evidence.records.length, 24);
  assert.ok(policy.records.every(item => EXPOSURE_CHANNELS.every(channel => !item.channels[channel].exposed)));
  assert.ok(policy.records.every(item => item.channels.search.reason_codes.includes(CERTIFICATION_REASON_CODES.gap)));

  const scheduleCell = policy.records.find(item => item.path === "/revit/update-schedule-cell");
  assert.equal(scheduleCell?.visibility, "workflow_only");
  assert.equal(scheduleCell?.channels.deterministic_workflow.exposed, false);
  assert.equal(scheduleCell?.channels.generic_call.exposed, false);

  const generatedOnce = generatePolicyBytes(evidenceText);
  const generatedAgain = generatePolicyBytes(`\uFEFF${evidenceText.replace(/\n/g, "\r\n")}`);
  assert.equal(generatedOnce, generatedAgain);
  assert.equal(generatedOnce, fs.readFileSync(policyPath, "utf8").replace(/\r\n?/g, "\n"));
  assert.doesNotMatch(generatedOnce, /generated_at|[A-Z]:\\|\\Users\\/i);
});
