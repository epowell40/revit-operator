import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EPIC0439_REQUIRED_DOMAINS,
  buildEpic0439UsefulnessReport,
  loadEpic0439UsefulnessManifest,
  materializeEpic0439Cases,
  validateEpic0439DynamicSelection,
  validateEpic0439Result,
  type Epic0439Result
} from "../src/benchmark/epic0439_usefulness.js";
import {
  ingestEpic0439EvidenceCampaign,
  readAndValidateEpic0439EvidenceManifest,
  type Epic0439EvidenceManifest
} from "../src/benchmark/epic0439_evidence.js";

const manifest = loadEpic0439UsefulnessManifest();

function result(overrides: Partial<Epic0439Result> = {}): Epic0439Result {
  return {
    schema_version: "epic0439_result/v1",
    case_id: "u01_parameter_simple--implementation--0--abc",
    task_id: "u01_parameter_simple",
    config_id: "epic0439_typed_v1",
    representation: "typed_capability_chain",
    evidence_tier: "source_only",
    metrics: {
      completion: true,
      correctness: 1,
      changed_element_precision: 1,
      model_turns: 2,
      tool_rpc_calls: 4,
      generated_code_bytes: 0,
      execution_time_ms: 500,
      estimated_cost_usd: 0.02,
      input_tokens: 100,
      output_tokens: 50,
      preview_repairs: 0,
      verification_quality: 1,
      special_purpose_product_code_bytes: 1200,
      recovery_attempts: 0,
      recovery_outcome: "not_needed"
    },
    failure: null,
    notes: ["Source inspection only; not a live Revit outcome."],
    ...overrides
  };
}

test("EPIC-0439 usefulness manifest covers all 16 required task domains with paired configurations", () => {
  assert.equal(manifest.tasks.length, 16);
  assert.deepEqual(new Set(manifest.tasks.map((task) => task.domain)), new Set(EPIC0439_REQUIRED_DOMAINS));
  assert.deepEqual(
    new Set(manifest.execution_configs.map((config) => config.representation)),
    new Set(["typed_capability_chain", "dynamic_program"])
  );
  for (const task of manifest.tasks) {
    assert.ok(task.implementation_wording.length > 0);
    assert.ok(task.holdout_wording.length > 0);
    assert.ok(task.rule_pool.length >= 2);
    assert.match(task.selection_query, /query|discover|enumerate|graph|evidence|inspect/i);
  }
});

test("case materialization is deterministic, seed-sensitive, and reserves unseen wording", () => {
  const first = materializeEpic0439Cases(manifest, { seed: "review-freeze-01", variants_per_task: 2 });
  const second = materializeEpic0439Cases(manifest, { seed: "review-freeze-01", variants_per_task: 2 });
  const other = materializeEpic0439Cases(manifest, { seed: "review-freeze-02", variants_per_task: 2 });
  const holdout = materializeEpic0439Cases(manifest, { seed: "review-freeze-01", wording_partition: "holdout" });
  assert.deepEqual(first, second);
  assert.equal(first.length, 32);
  assert.notDeepEqual(first.map((entry) => entry.randomized_inputs), other.map((entry) => entry.randomized_inputs));
  assert.ok(holdout.every((entry) => entry.wording_partition === "holdout"));
  assert.ok(holdout.every((entry) => !manifest.tasks.find((task) => task.task_id === entry.task_id)!.implementation_wording.includes(entry.user_prompt)));
});

test("post-freeze reviewer wording can replace selected holdout slots without changing source", () => {
  const cases = materializeEpic0439Cases(manifest, {
    seed: "independent-reviewer",
    wording_partition: "reviewer_holdout",
    reviewer_wording: {
      u16_novel_egress_overlay: ["Independent challenge: analyze {{count}} rooms in {{view_context}} under {{rule}} and call the overlay {{label}}."]
    }
  });
  const novel = cases.find((entry) => entry.task_id === "u16_novel_egress_overlay")!;
  assert.equal(novel.wording_partition, "reviewer_holdout");
  assert.match(novel.user_prompt, /^Independent challenge:/);
  assert.doesNotMatch(novel.user_prompt, /\{\{/);
});

test("materialized prompts do not disclose randomized fixture target ids", () => {
  const cases = materializeEpic0439Cases(manifest, { seed: "anti-demo", variants_per_task: 3, wording_partition: "holdout" });
  for (const benchmarkCase of cases) {
    for (const candidate of benchmarkCase.fixture_evidence.candidates) {
      assert.equal(benchmarkCase.user_prompt.includes(candidate.element_id), false);
    }
    assert.equal(benchmarkCase.target_selection.required_strategy, "live_evidence_query");
    assert.equal(benchmarkCase.target_selection.generated_source_may_contain_fixture_ids, false);
  }
});

test("dynamic target selection rejects fixture constants and unobserved operated ids", () => {
  const benchmarkCase = materializeEpic0439Cases(manifest, { seed: "selector" })[0]!;
  const targetId = benchmarkCase.evaluator_ground_truth.expected_target_ids[0]!;
  assert.doesNotThrow(() => validateEpic0439DynamicSelection(benchmarkCase, {
    strategy: "live_evidence_query",
    generated_source: "var targets = await sdk.Elements.QueryAsync(predicate);",
    observed_element_ids: [targetId],
    operated_element_ids: [targetId]
  }));
  assert.throws(() => validateEpic0439DynamicSelection(benchmarkCase, {
    strategy: "live_evidence_query",
    generated_source: `await sdk.Parameters.SetAsync(\"${targetId}\", \"QA Status\", value);`,
    observed_element_ids: [targetId],
    operated_element_ids: [targetId]
  }), /fixture element id/);
  assert.throws(() => validateEpic0439DynamicSelection(benchmarkCase, {
    strategy: "live_evidence_query",
    generated_source: "var targets = await sdk.Elements.QueryAsync(predicate);",
    observed_element_ids: [],
    operated_element_ids: [targetId]
  }), /not present in live evidence/);
});

test("evidence tiers cannot mislabel source or mock results as live Revit", () => {
  assert.doesNotThrow(() => validateEpic0439Result(result(), manifest));
  assert.throws(() => validateEpic0439Result(result({ evidence_tier: "live_revit" }), manifest), /caller-authored result JSON/);
  assert.throws(() => validateEpic0439Result(result({
    evidence_tier: "mocked",
    live_revit_receipt: {
      receipt_id: "r",
      revit_version: "2025",
      document_session_id: "d",
      admission_hash: "a",
      preview_receipt_hash: "p",
      apply_receipt_hash: "x",
      verification_receipt_hash: "v"
    }
  }), manifest), /must not carry a live Revit receipt/);
});

function sha256(value: Buffer | string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const worker = {
    schema: "dynamic-revit-worker-output/v0",
    ok: true,
    sourceHash: `sha256:${"1".repeat(64)}`,
    programHash: `sha256:${"2".repeat(64)}`,
    sdkHash: `sha256:${"3".repeat(64)}`,
    graph: {
      schema: "dynamic-revit-operation-graph/v0",
      inputHash: `sha256:${"4".repeat(64)}`,
      graphHash: `sha256:${"5".repeat(64)}`,
      operations: []
    }
  };
  const admission = {
    schema: "dynamic-revit-admission/v0",
    operationGraphHash: worker.graph.graphHash,
    documentFingerprint: `sha256:${"6".repeat(64)}`,
    documentSessionId: "session-1"
  };
  const preview = {
    schema: "dynamic-revit-preview-receipt/v0",
    ok: true,
    preview_id: "preview-1",
    source_hash: worker.sourceHash,
    program_hash: worker.programHash,
    sdk_hash: worker.sdkHash,
    input_hash: worker.graph.inputHash,
    graph_hash: worker.graph.graphHash,
    document_fingerprint: admission.documentFingerprint,
    document_session_id: admission.documentSessionId,
    target_ids: [],
    projected_changed_element_ids: [],
    rollback_verified_element_ids: [],
    rollback_truth: true
  };
  return {
    schema: "dynamic-revit-phase2-live-evidence/v0",
    ok: true,
    startedUtc: "2026-08-09T10:00:00.000Z",
    completedUtc: "2026-08-09T10:00:01.000Z",
    workerOutput: worker,
    admission,
    previewReceipt: JSON.stringify(preview),
    failure: null,
    ...overrides
  };
}

function campaignFixture(): {
  root: string;
  caseSetPath: string;
  evidenceManifestPath: string;
  evidencePath: string;
  evidenceManifest: Epic0439EvidenceManifest;
  rewriteManifest: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "epic0439-evidence-"));
  const cases = materializeEpic0439Cases(manifest, { seed: "anti-forgery" });
  const caseSetPath = path.join(root, "cases.json");
  fs.writeFileSync(caseSetPath, `${JSON.stringify({
    schema_version: "epic0439_case_set/v1",
    suite_id: manifest.suite_id,
    evidence_tier: "source_only",
    generated_outcomes: false,
    seed: "anti-forgery",
    wording_partition: "implementation",
    cases
  }, null, 2)}\n`);
  const evidencePath = path.join(root, "receipt.json");
  fs.writeFileSync(evidencePath, `${JSON.stringify(receipt(), null, 2)}\n`);
  const evidenceHash = sha256(fs.readFileSync(evidencePath));
  const entries = cases.flatMap((benchmarkCase) => benchmarkCase.execution_config_ids.map((configId) => {
    const config = manifest.execution_configs.find((candidate) => candidate.config_id === configId)!;
    return {
      case_id: benchmarkCase.case_id,
      task_id: benchmarkCase.task_id,
      config_id: configId,
      representation: config.representation,
      evidence_file: "receipt.json",
      evidence_sha256: evidenceHash,
      telemetry: {
        model_turns: 1,
        tool_rpc_calls: 1,
        generated_code_bytes: config.representation === "dynamic_program" ? 100 : 0,
        estimated_cost_usd: 0,
        input_tokens: 1,
        output_tokens: 1,
        preview_repairs: 0,
        special_purpose_product_code_bytes: config.representation === "dynamic_program" ? 0 : 100,
        recovery_attempts: 0
      }
    };
  }));
  const evidenceManifest: Epic0439EvidenceManifest = {
    schema_version: "epic0439_evidence_manifest/v1",
    suite_id: manifest.suite_id,
    case_set_sha256: sha256(fs.readFileSync(caseSetPath)),
    entries
  };
  const evidenceManifestPath = path.join(root, "evidence.json");
  const rewriteManifest = () => fs.writeFileSync(evidenceManifestPath, `${JSON.stringify(evidenceManifest, null, 2)}\n`);
  rewriteManifest();
  return { root, caseSetPath, evidenceManifestPath, evidencePath, evidenceManifest, rewriteManifest };
}

test("evidence ingestion owns scores and classifies current receipts below authenticated live", () => {
  const fixture = campaignFixture();
  const results = ingestEpic0439EvidenceCampaign({
    manifest,
    caseSetPath: fixture.caseSetPath,
    evidenceManifestPath: fixture.evidenceManifestPath,
    evidenceRoot: fixture.root
  });
  assert.equal(results.length, 32);
  assert.ok(results.every((entry) => entry.evidence_tier === "live_revit_unverified"));
  assert.ok(results.every((entry) => entry.metrics.completion));
  assert.ok(results.every((entry) => entry.metrics.correctness === 0));
  assert.ok(results.every((entry) => entry.metrics.changed_element_precision === 0));
  assert.ok(results.every((entry) => entry.metrics.verification_quality === 0));
  assert.ok(results.every((entry) => entry.scorer_evidence_receipt?.authenticated_campaign_binding === false));
  const report = buildEpic0439UsefulnessReport(manifest, results);
  assert.equal(report.unverified_live_result_count, 32);
  assert.equal(report.live_acceptance_claimable, false);
  assert.match(report.evidence_warning ?? "", /no authenticated campaign binding/i);
});

test("evidence manifest rejects caller-authored perfect metrics and arbitrary properties", () => {
  const fixture = campaignFixture();
  Object.assign(fixture.evidenceManifest.entries[0]!, {
    metrics: { completion: true, correctness: 1, changed_element_precision: 1, verification_quality: 1 }
  });
  fixture.rewriteManifest();
  assert.throws(() => readAndValidateEpic0439EvidenceManifest(fixture.evidenceManifestPath), /must NOT have additional properties/);
});

test("evidence campaign rejects duplicates, missing pairs, and wrong case/config assignments", () => {
  const duplicate = campaignFixture();
  duplicate.evidenceManifest.entries[1] = structuredClone(duplicate.evidenceManifest.entries[0]!);
  duplicate.rewriteManifest();
  assert.throws(() => ingestEpic0439EvidenceCampaign({
    manifest, caseSetPath: duplicate.caseSetPath, evidenceManifestPath: duplicate.evidenceManifestPath, evidenceRoot: duplicate.root
  }), /Duplicate evidence entry/);

  const missing = campaignFixture();
  missing.evidenceManifest.entries.pop();
  missing.rewriteManifest();
  assert.throws(() => ingestEpic0439EvidenceCampaign({
    manifest, caseSetPath: missing.caseSetPath, evidenceManifestPath: missing.evidenceManifestPath, evidenceRoot: missing.root
  }), /exactly 32/);

  const wrong = campaignFixture();
  wrong.evidenceManifest.entries[0]!.task_id = "u16_novel_egress_overlay";
  wrong.rewriteManifest();
  assert.throws(() => ingestEpic0439EvidenceCampaign({
    manifest, caseSetPath: wrong.caseSetPath, evidenceManifestPath: wrong.evidenceManifestPath, evidenceRoot: wrong.root
  }), /wrong task id/);

  const wrongConfig = campaignFixture();
  wrongConfig.evidenceManifest.entries[0]!.config_id = "epic0439_not_a_config";
  wrongConfig.rewriteManifest();
  assert.throws(() => ingestEpic0439EvidenceCampaign({
    manifest, caseSetPath: wrongConfig.caseSetPath, evidenceManifestPath: wrongConfig.evidenceManifestPath, evidenceRoot: wrongConfig.root
  }), /wrong config/);

  const wrongCase = campaignFixture();
  wrongCase.evidenceManifest.entries[0]!.case_id = "not-a-materialized-case";
  wrongCase.rewriteManifest();
  assert.throws(() => ingestEpic0439EvidenceCampaign({
    manifest, caseSetPath: wrongCase.caseSetPath, evidenceManifestPath: wrongCase.evidenceManifestPath, evidenceRoot: wrongCase.root
  }), /unknown case/);
});

test("evidence campaign recomputes file hashes and rejects tamper", () => {
  const fixture = campaignFixture();
  fs.appendFileSync(fixture.evidencePath, " ");
  assert.throws(() => ingestEpic0439EvidenceCampaign({
    manifest, caseSetPath: fixture.caseSetPath, evidenceManifestPath: fixture.evidenceManifestPath, evidenceRoot: fixture.root
  }), /Evidence hash mismatch/);

  const caseTamper = campaignFixture();
  const caseSet = JSON.parse(fs.readFileSync(caseTamper.caseSetPath, "utf8")) as { cases: Array<{ user_prompt: string }> };
  caseSet.cases[0]!.user_prompt = "tampered campaign case";
  fs.writeFileSync(caseTamper.caseSetPath, JSON.stringify(caseSet));
  caseTamper.evidenceManifest.case_set_sha256 = sha256(fs.readFileSync(caseTamper.caseSetPath));
  caseTamper.rewriteManifest();
  assert.throws(() => ingestEpic0439EvidenceCampaign({
    manifest, caseSetPath: caseTamper.caseSetPath, evidenceManifestPath: caseTamper.evidenceManifestPath, evidenceRoot: caseTamper.root
  }), /does not match canonical materialization/);
});

test("evidence campaign rejects empty, arbitrary, and canonically inconsistent receipts", () => {
  for (const badReceipt of [{}, { schema: "made-up/v1", ok: true }]) {
    const fixture = campaignFixture();
    fs.writeFileSync(fixture.evidencePath, JSON.stringify(badReceipt));
    const hash = sha256(fs.readFileSync(fixture.evidencePath));
    fixture.evidenceManifest.entries.forEach((entry) => { entry.evidence_sha256 = hash; });
    fixture.rewriteManifest();
    assert.throws(() => ingestEpic0439EvidenceCampaign({
      manifest, caseSetPath: fixture.caseSetPath, evidenceManifestPath: fixture.evidenceManifestPath, evidenceRoot: fixture.root
    }), /must be a non-empty string|Unsupported live evidence schema/);
  }

  const mismatch = campaignFixture();
  const bad = receipt();
  (bad.admission as Record<string, unknown>).operationGraphHash = `sha256:${"9".repeat(64)}`;
  fs.writeFileSync(mismatch.evidencePath, JSON.stringify(bad));
  const hash = sha256(fs.readFileSync(mismatch.evidencePath));
  mismatch.evidenceManifest.entries.forEach((entry) => { entry.evidence_sha256 = hash; });
  mismatch.rewriteManifest();
  assert.throws(() => ingestEpic0439EvidenceCampaign({
    manifest, caseSetPath: mismatch.caseSetPath, evidenceManifestPath: mismatch.evidenceManifestPath, evidenceRoot: mismatch.root
  }), /canonical binding/);
});

test("report compares paired metrics and keeps source-only evidence non-live", () => {
  const typed = result();
  const dynamic = result({
    config_id: "epic0439_dynamic_v1",
    representation: "dynamic_program",
    metrics: {
      ...result().metrics,
      tool_rpc_calls: 2,
      generated_code_bytes: 2400,
      special_purpose_product_code_bytes: 0,
      input_tokens: 130,
      output_tokens: 90
    }
  });
  const report = buildEpic0439UsefulnessReport(manifest, [typed, dynamic]);
  assert.equal(report.live_revit_result_count, 0);
  assert.equal(report.source_only_result_count, 2);
  assert.equal(report.live_acceptance_claimable, false);
  assert.match(report.evidence_warning ?? "", /not live acceptance/i);
  assert.equal(report.paired_deltas.length, 1);
  assert.equal(report.paired_deltas[0]!.tool_calls_dynamic_minus_typed, -2);
  assert.equal(report.paired_deltas[0]!.product_code_bytes_dynamic_minus_typed, -1200);
});
