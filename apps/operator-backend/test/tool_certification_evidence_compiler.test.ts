import assert from "node:assert/strict";
import { constants, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson, generateToolExposurePolicy, parseToolCertificationCandidates, parseToolCertificationEvidence, sealEvidenceRecord, sha256NormalizedText, type JsonValue } from "../src/capabilities/tool_certification.js";
import { assertEpic0437PromotableRecoveryState, compileArtifactBoundEvidence, parseCertificationProofIndex, validateEpic0437LiveEvidenceRun } from "../src/capabilities/tool_certification_evidence_compiler.js";
import { EPIC_0437_PROMOTION_AUTHORITY_KEY_ID, parseAndVerifyEpic0437PromotionAuthorization } from "../src/capabilities/epic_0437_promotion_authority.js";
import { epic0437SourceInputHash } from "../src/capabilities/epic_0437_source_provenance.js";

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

test("source provenance is cross-platform for line endings but still binds exact text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "epic-0437-source-hash-"));
  const relative = "source.ts";
  const source = path.join(root, relative);
  fs.writeFileSync(source, "const a = 1;\nconst b = 2;\n", "utf8");
  const lfHash = epic0437SourceInputHash(root, relative);
  fs.writeFileSync(source, "const a = 1;\r\nconst b = 2;\r\n", "utf8");
  assert.equal(epic0437SourceInputHash(root, relative), lfHash);
  fs.writeFileSync(source, "const a = 1;\r\nconst b = 3;\r\n", "utf8");
  assert.notEqual(epic0437SourceInputHash(root, relative), lfHash);
  fs.writeFileSync(source, Buffer.from([0xc3, 0x28]));
  assert.throws(() => epic0437SourceInputHash(root, relative), /malformed UTF-8/);
  fs.writeFileSync(source, Buffer.from([0xa0, 0xa1]));
  assert.throws(() => epic0437SourceInputHash(root, relative), /malformed UTF-8/);
  fs.writeFileSync(source, "const a = 1;\0\n", "utf8");
  assert.throws(() => epic0437SourceInputHash(root, relative), /NUL\/binary text/);
  const unsupported = path.join(root, "source.bin");
  fs.writeFileSync(unsupported, "text", "utf8");
  assert.throws(() => epic0437SourceInputHash(root, "source.bin"), /unsupported non-text build input/);
});

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

  const reduced = JSON.parse(proofRaw);
  const reference = reduced.records[0].artifacts[0];
  const artifactPath = path.join(repoRoot, reference.path);
  const originalArtifact = fs.readFileSync(artifactPath, "utf8");
  try {
    const artifact = JSON.parse(originalArtifact);
    artifact.inputs = [artifact.inputs[0]];
    artifact.inputs_hash = sha256NormalizedText(canonicalJson(artifact.inputs));
    const rendered = `${JSON.stringify(artifact, null, 2)}\n`;
    fs.writeFileSync(artifactPath, rendered, "utf8");
    reference.sha256 = sha256NormalizedText(rendered);
    assert.throws(() => compile(reduced), /exact complete current source input set/);
  } finally {
    fs.writeFileSync(artifactPath, originalArtifact, "utf8");
  }

  const falseL2 = JSON.parse(proofRaw);
  const l2Reference = falseL2.records[0].artifacts.find((value: Record<string, unknown>) => value.level === "L2");
  const l2Path = path.join(repoRoot, l2Reference.path);
  const originalL2 = fs.readFileSync(l2Path, "utf8");
  try {
    const artifact = JSON.parse(originalL2);
    artifact.result.checks = ["not-a-real-gate"];
    const rendered = `${JSON.stringify(artifact, null, 2)}\n`;
    fs.writeFileSync(l2Path, rendered, "utf8");
    l2Reference.sha256 = sha256NormalizedText(rendered);
    assert.throws(() => compile(falseL2), /source gate result contract is not exact/);
  } finally {
    fs.writeFileSync(l2Path, originalL2, "utf8");
  }
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

test("EPIC-0437 compiler rejects every manual or discard-only recovery state", () => {
  assert.doesNotThrow(() => assertEpic0437PromotableRecoveryState("L3", "preview_only"));
  assert.doesNotThrow(() => assertEpic0437PromotableRecoveryState("L4", "restored"));
  for (const state of [
    "host_restart_discard_required", "manual_close_without_save_required", "manual_reconciliation_required",
    "reconciliation_required", "restored_after_failure", "preview_only", null
  ]) {
    assert.throws(() => assertEpic0437PromotableRecoveryState("L4", state), /exact safe recovery state/);
  }
});

function writeForgeableLegacyLiveFixture(level: "L3" | "L4"): { root: string; relative: string; save: () => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "epic-0437-live-proof-"));
  const directory = path.join(root, "artifacts/certification/epic-0437/runs");
  fs.mkdirSync(directory, { recursive: true });
  const transport_evidence = Array.from({ length: level === "L3" ? 7 : 11 }, (_, index) => {
    const dispatch = String(index + 1).padStart(64, "0");
    const files = level === "L3"
      ? [{ name: `${index}.transport.json`, value: { version: "revit-operator.native-transport.v1", algorithm: "A256CBC-HS512", transport_path: "/revit/operator-transport/v1" } }]
      : [
          { name: `${index}.job.json`, value: { version: "revit-operator.revit-tool-job.v1", id: dispatch, correlation_id: dispatch } },
          { name: `${index}.result.json`, value: { version: "revit-operator.revit-tool-result.v1", id: dispatch, correlation_id: dispatch, status: "succeeded", outcome_unknown: false } }
        ];
    return {
      step: `step-${index}`, kind: level === "L3" ? "protected_native" : "courier_sidecar", dispatch_id: dispatch, correlation_id: dispatch,
      files: files.map(file => {
        const relative = `artifacts/certification/epic-0437/runs/${file.name}`;
        const raw = `${JSON.stringify(file.value)}\n`;
        fs.writeFileSync(path.join(root, relative), raw, "utf8");
        return { path: relative, sha256: sha256NormalizedText(raw) };
      })
    };
  });
  const before = { kind: "LocationPoint", pointXyz: [1, 2, 3] };
  const after = { kind: "LocationPoint", pointXyz: [1.25, 2, 3] };
  const moved = (rolledBack: boolean, first = before, second = after) => ({ rolledBack, movedTogether: false, movedIds: [4821], skipped: [], snapshots: [{ id: 4821, before: first, after: second }] });
  const run: any = {
    schema: "revit-operator.epic-0437-live-evidence-run.v1", level, transport: level === "L3" ? "direct_protected_native" : "courier_sidecar",
    runtime: { mode: "development", exposure_profile: "laboratory", production_certified: false },
    document: {
      title: "Snowdon Towers Sample HVAC", fingerprint: `sha256:${"a".repeat(64)}`, session_id: "1".repeat(32), final_session_id: "1".repeat(32),
      native_attestation: { schema: "revit-operator.native-execution-attestation-key.v1", algorithm: "RS256", key_id: `sha256:${"b".repeat(64)}`, modulus_base64url: "A".repeat(342), exponent_base64url: "AQAB" }
    },
    view: { id: 9948, type: "FloorPlan" },
    observation: { alias: "revit_observe_model", observation_id: "observation-1", count: 1, certified_target_count: 1, image_attached: true },
    readback: { alias: "revit_read_move_targets_certified", observation_id: "observation-2", target_count: 1, selected_target: { elementId: 4821, sourceScopedId: "host:4821", observationId: "observation-2", pointXyz: { x: 1, y: 2, z: 3 } } },
    preview: { alias: "revit_move_one_certified", request_sha256: `sha256:${"c".repeat(64)}`, result: moved(true), rollback_readback_observation_id: "observation-3", rollback_point: { x: 1, y: 2, z: 3 } },
    apply: level === "L3" ? null : {
      result: moved(false), committed_point: { x: 1.25, y: 2, z: 3 }, committed_readback_observation_id: "observation-4",
      restore_result: moved(false, after, before), restored_point: { x: 1, y: 2, z: 3 }, restored_readback_observation_id: "observation-5"
    },
    transport_evidence
  };
  const relative = "artifacts/certification/epic-0437/runs/run.json";
  const save = () => {
    const raw = `${JSON.stringify(run, null, 2)}\n`;
    fs.writeFileSync(path.join(root, relative), raw, "utf8");
    return sha256NormalizedText(raw);
  };
  return { root, relative, save };
}

test("EPIC-0437 compiler rejects legacy self-authored live evidence and requires an independent live-process key pin", () => {
  for (const level of ["L3", "L4"] as const) {
    const fixture = writeForgeableLegacyLiveFixture(level);
    const digest = fixture.save();
    assert.throws(() => validateEpic0437LiveEvidenceRun(fixture.root, fixture.relative, digest, level), /independently authenticated live-process key pin/);
    assert.throws(() => validateEpic0437LiveEvidenceRun(fixture.root, fixture.relative, digest, level, {
      algorithm: "RS256", key_id: `sha256:${"f".repeat(64)}`, modulus_base64url: "A".repeat(342), exponent_base64url: "AQAB"
    }), /keys are not exact|identity, source, or transport/);
  }
});

test("EPIC-0437 promotion compiler rejects a self-authored signer even when every payload field is well shaped", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const payload = {
    schema: "revit-operator.epic-0437-promotion-payload.v1",
    evidence_run_id: "1".repeat(32), level: "L3", candidate_source_hash: `sha256:${"2".repeat(64)}`,
    policy_hash: `sha256:${"3".repeat(64)}`,
    native_build_manifest_path: "artifacts/certification/epic-0437/native-build-manifest.v1.json",
    native_build_manifest_sha256: `sha256:${"4".repeat(64)}`,
    run_receipt_path: "artifacts/certification/epic-0437/runs/forged.json",
    run_receipt_sha256: `sha256:${"5".repeat(64)}`,
    candidate: { method: "POST", path: "/revit/export-visible-elements", request_hash: `sha256:${"6".repeat(64)}`, effect_hash: `sha256:${"7".repeat(64)}` },
    capability: "observation_readback",
    native_attestation: { algorithm: "RS256", key_id: `sha256:${"8".repeat(64)}`, modulus_base64url: "A".repeat(342), exponent_base64url: "AQAB" },
    issued_at_utc: "2026-08-08T12:00:00.000Z"
  } as const;
  const signature = sign("sha256", Buffer.from(canonicalJson(payload as unknown as JsonValue), "utf8"), {
    key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32
  }).toString("base64url");
  assert.throws(() => parseAndVerifyEpic0437PromotionAuthorization({
    schema: "revit-operator.epic-0437-promotion-authorization.v1", algorithm: "PS256",
    key_id: EPIC_0437_PROMOTION_AUTHORITY_KEY_ID, payload, signature_base64url: signature
  }), /signature is invalid/);
});
