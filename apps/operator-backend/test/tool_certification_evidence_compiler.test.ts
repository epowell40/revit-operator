import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { generateToolExposurePolicy, parseToolCertificationCandidates, parseToolCertificationEvidence, sealEvidenceRecord, sha256NormalizedText } from "../src/capabilities/tool_certification.js";
import { compileArtifactBoundEvidence, parseCertificationProofIndex } from "../src/capabilities/tool_certification_evidence_compiler.js";

const backendRoot = process.cwd();
const repoRoot = path.resolve(backendRoot, "../..");
const candidateRaw = fs.readFileSync(path.join(backendRoot, "config/tool_certification_candidates.v1.json"), "utf8");
const evidenceRaw = fs.readFileSync(path.join(backendRoot, "config/tool_certification_evidence.v1.json"), "utf8");
const proofRaw = fs.readFileSync(path.join(backendRoot, "config/tool_certification_proofs.v1.json"), "utf8");

function compile(proofs = JSON.parse(proofRaw)) {
  return compileArtifactBoundEvidence({
    candidates: parseToolCertificationCandidates(JSON.parse(candidateRaw)),
    candidateSourceHash: sha256NormalizedText(candidateRaw),
    baseline: parseToolCertificationEvidence(JSON.parse(evidenceRaw)),
    proofIndex: parseCertificationProofIndex(proofs),
    repoRoot
  });
}

test("artifact-bound compiler verifies exact cumulative L0-L2 proof files against current inputs", () => {
  const compiled = compile();
  const records = compiled.records.filter(record => record.evidence_contract);
  assert.equal(records.length, 3);
  assert.ok(records.every(record => JSON.stringify(record.evidence.levels) === JSON.stringify(["L0", "L1", "L2"])));
  assert.ok(records.every(record => record.evidence.artifacts?.length === 3));
});

test("artifact-bound compiler rejects proof hash tamper, missing levels, and stale candidate source", () => {
  const tampered = JSON.parse(proofRaw);
  tampered.records[0].artifacts[0].sha256 = `sha256:${"0".repeat(64)}`;
  assert.throws(() => compile(tampered), /artifact hash mismatch/);

  const gapped = JSON.parse(proofRaw);
  gapped.records[0].artifacts.splice(1, 1);
  assert.throws(() => compile(gapped), /not cumulative/);

  const stale = JSON.parse(proofRaw);
  stale.candidate_source_hash = `sha256:${"0".repeat(64)}`;
  assert.throws(() => compile(stale), /stale for the candidate source/);
});

test("artifact-bound evidence cannot be hand-promoted without one exact proof per claimed level", () => {
  const candidate = parseToolCertificationCandidates(JSON.parse(candidateRaw)).candidates.find(item => item.path === "/revit/export-visible-elements")!;
  const record = sealEvidenceRecord({
    method: candidate.method, path: candidate.path, typed_mcp_aliases: candidate.typed_mcp_aliases,
    request: candidate.request, effect: { resolved_effect: "read" }, requested_channels: ["typed_mcp"], visibility: "candidate",
    evidence_contract: candidate.evidence_contract,
    evidence: { levels: ["L0", "L1", "L2", "L3", "L4"], state: "verified", provenance: "config/tool_certification_candidates.v1.json", artifacts: [] }
  });
  const policy = generateToolExposurePolicy({
    schema: "revit-operator.tool-certification-evidence.v1", hash_algorithm: "sha256",
    provenance: { source: "config/tool_certification_candidates.v1.json", source_hash: sha256NormalizedText(candidateRaw) },
    records: [record]
  });
  assert.equal(policy.records[0]?.channels.typed_mcp.exposed, false);
  assert.ok(policy.records[0]?.channels.typed_mcp.reason_codes.includes("CERT_EVIDENCE_MISMATCHED"));
});
