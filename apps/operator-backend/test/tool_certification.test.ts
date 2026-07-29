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
const candidatesPath = path.join(backendRoot, "config", "tool_certification_candidates.v1.json");
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

test("seeded audit candidates remain unexposed while L2 is absent", () => {
  const evidenceText = fs.readFileSync(evidencePath, "utf8");
  const candidatesText = fs.readFileSync(candidatesPath, "utf8");
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

  const generatedOnce = generatePolicyBytes(evidenceText, candidatesText);
  const generatedAgain = generatePolicyBytes(
    `\uFEFF${evidenceText.replace(/\n/g, "\r\n")}`,
    `\uFEFF${candidatesText.replace(/\n/g, "\r\n")}`
  );
  assert.equal(generatedOnce, generatedAgain);
  assert.equal(generatedOnce, fs.readFileSync(policyPath, "utf8").replace(/\r\n?/g, "\n"));
  assert.doesNotMatch(generatedOnce, /generated_at|[A-Z]:\\|\\Users\\/i);
});
