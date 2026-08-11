import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EPIC0441_REQUIRED_REDLINE_FAMILIES,
  loadEpic0441Campaign,
  sealEpic0441NovelTasks,
  validateEpic0441Campaign,
  type Epic0441Campaign
} from "../src/benchmark/epic0441_campaign.js";
import {
  createEpic0441EvidenceManifestSkeleton,
  epic0441ReviewerPacketSha256,
  epic0441Ordering,
  scoreEpic0441Campaign,
  type Epic0441EvidenceManifest
} from "../src/benchmark/epic0441_scoreboard.js";

const campaign = loadEpic0441Campaign();

test("EPIC-0441 evidence skeleton is complete, balanced, and conservatively unscored", () => {
  const manifest = createEpic0441EvidenceManifestSkeleton({ campaign, campaignSeed: "epic0441-frozen-20260809", reviewerPacketSha256: hash("packet") });
  assert.equal(manifest.rows.length, 60);
  assert.equal(manifest.rows.filter(row => row.pair_order === 1 && row.representation === "typed_capability_chain").length, 15);
  assert.equal(manifest.rows.filter(row => row.pair_order === 1 && row.representation === "dynamic_program").length, 15);
  assert.equal(manifest.rows.filter(row => row.classification === "sealed_not_yet_run").length, 6);
  assert.ok(manifest.rows.filter(row => row.classification !== "sealed_not_yet_run").every(row => row.classification === "source_only"));
});

test("EPIC-0441 reviewer packet seal is stable across Git LF and Windows CRLF checkouts", () => {
  assert.equal(epic0441ReviewerPacketSha256(Buffer.from("{\n  \"task\": \"n28\"\n}\n")),
    epic0441ReviewerPacketSha256(Buffer.from("{\r\n  \"task\": \"n28\"\r\n}\r\n")));
  assert.throws(() => epic0441ReviewerPacketSha256(Buffer.from([0xff, 0xfe])), /UTF-8/);
});

test("EPIC-0441 current-runtime baseline blocks unsupported dynamic arms without inflating evidence", () => {
  const manifest = createEpic0441EvidenceManifestSkeleton({ campaign, campaignSeed: "baseline", reviewerPacketSha256: hash("packet"),
    dynamicSupportedTaskIds: ["r04_bulk_status_rule", "r12_move_device"] });
  assert.equal(manifest.rows.filter(row => row.representation === "dynamic_program" && row.classification === "unsupported").length, 25);
  assert.equal(manifest.rows.find(row => row.task_id === "r12_move_device" && row.representation === "dynamic_program")?.classification, "source_only");
  assert.equal(manifest.rows.find(row => row.task_id === "n28_novel_holdout" && row.representation === "dynamic_program")?.classification, "sealed_not_yet_run");
});

test("EPIC-0441 freezes thirty paired, redline-led task slots", () => {
  assert.equal(campaign.tasks.length, 30);
  assert.equal(campaign.tasks.filter((task) => task.wave === "redline_primary").length, 21);
  assert.equal(campaign.tasks.filter((task) => task.wave === "novel_post_freeze").length, 3);
  assert.deepEqual(new Set(campaign.execution_configs.map((entry) => entry.representation)), new Set(["typed_capability_chain", "dynamic_program"]));
  const redlineFamilies = new Set(campaign.tasks.filter((task) => task.wave === "redline_primary").map((task) => task.operation_family));
  for (const family of EPIC0441_REQUIRED_REDLINE_FAMILIES) assert.ok(redlineFamilies.has(family));
});

test("campaign records missing raw corpus, live hydration, and non-authoritative self-report", () => {
  assert.equal(campaign.corpus_basis.raw_sources_available_to_runner, false);
  assert.equal(campaign.fixture_contract.hydrate_from_live_observation, true);
  assert.equal(campaign.truth_policy.old_redline_targets_may_be_replayed, false);
  assert.equal(campaign.truth_policy.self_reported_metrics_are_authoritative, false);
  assert.ok(campaign.fixture_contract.forbidden_fixture_families.includes("duke_three_byte_availability_sentinel"));
});

test("existing-model deletion stays dry-run-only and prompts leak no numeric target ids", () => {
  for (const task of campaign.tasks) {
    if (task.operation_family === "delete") assert.equal(task.action_policy, "dry_run_only");
    if (task.prompt) assert.doesNotMatch(task.prompt, /\b\d{5,}\b/);
  }
});

test("novel slots cannot be populated before independent post-freeze input", () => {
  const mutable = structuredClone(campaign) as Epic0441Campaign;
  const novel = mutable.tasks.find((task) => task.wave === "novel_post_freeze")!;
  novel.prompt = "Premature implementation-visible prompt that is long enough to otherwise look valid.";
  assert.throws(() => validateEpic0441Campaign(mutable), /must remain sealed/);
});

test("independent reviewer must fill every novel slot without fixture ids", () => {
  const shared = {
    substrate: "snowdon_architectural",
    action_policy: "apply_cleanup",
    fixture_adapter: "Hydrate all selectors from a reviewer-held geometric oracle after implementation freeze.",
    success_assertions: ["targets discovered", "invariants verified", "created artifacts cleaned"]
  };
  assert.throws(() => sealEpic0441NovelTasks(campaign, [{
    task_id: "n28_novel_holdout",
    prompt: "Find the targets with element id 123456 and update them according to the hidden rule.",
    ...shared
  }]), /every and only/);
  const sealed = sealEpic0441NovelTasks(campaign, [
    {task_id:"n28_novel_holdout",prompt:"Lay out a reviewer-defined clearance pattern around observed equipment without using stored target identities.",...shared},
    {task_id:"n29_novel_holdout",prompt:"Create a reviewer-defined spatial overlay from current room geometry and prove every boundary calculation.",...shared},
    {task_id:"n30_novel_holdout",prompt:"Detect a reviewer-defined cross-discipline mismatch and place bounded host-owned coordination markers for each proven case.",...shared}
  ]);
  assert.equal(sealed.tasks.filter((task) => task.wave === "novel_post_freeze" && task.prompt).length, 3);
});

function hash(value: Buffer | string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function scoreboardFixture(): {
  root: string;
  reviewerPacketPath: string;
  evidenceManifestPath: string;
  manifest: Epic0441EvidenceManifest;
  writeManifest: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "epic0441-scoreboard-"));
  const reviewerPacketPath = path.join(root, "private-reviewer-packet.json");
  fs.writeFileSync(reviewerPacketPath, JSON.stringify({ selectors: "reviewer-only-secret" }));
  const campaignSeed = "campaign-order-01";
  const ordering = epic0441Ordering(campaign, campaignSeed);
  const rows = campaign.tasks.flatMap((task) => campaign.execution_configs.map((config) => {
    const expected = ordering.get(task.task_id)!;
    return {
      task_id: task.task_id,
      config_id: config.config_id,
      representation: config.representation,
      pair_order: (config.representation === expected.first_representation ? 1 : 2) as 1 | 2,
      ordering_key: expected.ordering_key,
      classification: task.wave === "novel_post_freeze" ? "sealed_not_yet_run" as const : "source_only" as const,
      reason: task.wave === "novel_post_freeze" ? "Private reviewer packet is sealed and the task has not run." : "Source-only calibration row; no live claim."
    };
  }));
  const manifest: Epic0441EvidenceManifest = {
    schema_version: "epic0441_evidence_manifest/v1",
    suite_id: campaign.suite_id,
    campaign_seed: campaignSeed,
    ordering_algorithm: "sha256-balanced-pairs/v1",
    reviewer_packet_sha256: hash(fs.readFileSync(reviewerPacketPath)),
    rows
  };
  const evidenceManifestPath = path.join(root, "evidence-manifest.json");
  const writeManifest = () => fs.writeFileSync(evidenceManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeManifest();
  return { root, reviewerPacketPath, evidenceManifestPath, manifest, writeManifest };
}

function scoreFixture(fixture: ReturnType<typeof scoreboardFixture>) {
  return scoreEpic0441Campaign({
    campaign,
    evidenceManifestPath: fixture.evidenceManifestPath,
    evidenceRoot: fixture.root,
    reviewerPacketPath: fixture.reviewerPacketPath
  });
}

test("EPIC-0441 scorer emits exactly sixty unscored rows with balanced deterministic A/B order", () => {
  const fixture = scoreboardFixture();
  const first = scoreFixture(fixture);
  const second = scoreFixture(fixture);
  assert.deepEqual(first, second);
  assert.equal(first.results.length, 60);
  assert.equal(first.scoreboard.row_count, 60);
  assert.equal(first.scoreboard.complete_pair_count, 30);
  assert.equal(first.results.filter((row) => row.pair_order === 1 && row.representation === "typed_capability_chain").length, 15);
  assert.equal(first.results.filter((row) => row.pair_order === 1 && row.representation === "dynamic_program").length, 15);
  assert.equal(first.scoreboard.ordering_algorithm, "sha256-balanced-pairs/v1");
  assert.equal(first.scoreboard.sealed_not_yet_run_count, 6);
  assert.ok(first.results.filter((row) => row.classification === "sealed_not_yet_run")
    .every((row) => row.reviewer_packet_sha256 === first.scoreboard.reviewer_packet_sha256));
  assert.equal(first.scoreboard.broad_live_acceptance_claimable, false);
  assert.equal(first.scoreboard.authenticated_live_pair_count, 0);
  assert.ok(first.results.every((row) => row.scored === false && row.authenticated_campaign_binding === false));
  assert.equal(JSON.stringify(first).includes("reviewer-only-secret"), false);
  assert.equal(first.scoreboard.source_mock_calibration[0]!.source_only_count, 27);
  assert.equal(first.scoreboard.source_mock_calibration[1]!.source_only_count, 27);
});

test("EPIC-0441 scorer rejects missing, duplicate, wrong task, config, and ordering rows", () => {
  const missing = scoreboardFixture();
  missing.manifest.rows.pop();
  missing.writeManifest();
  assert.throws(() => scoreFixture(missing), /must NOT have fewer than 60 items/);

  const duplicate = scoreboardFixture();
  duplicate.manifest.rows[1] = structuredClone(duplicate.manifest.rows[0]!);
  duplicate.writeManifest();
  assert.throws(() => scoreFixture(duplicate), /Duplicate EPIC-0441 task\/config row/);

  const wrongTask = scoreboardFixture();
  wrongTask.manifest.rows[0]!.task_id = "not_a_campaign_task";
  wrongTask.writeManifest();
  assert.throws(() => scoreFixture(wrongTask), /Unknown EPIC-0441 task/);

  const wrongConfig = scoreboardFixture();
  wrongConfig.manifest.rows[0]!.config_id = "not_a_campaign_config";
  wrongConfig.writeManifest();
  assert.throws(() => scoreFixture(wrongConfig), /Unknown EPIC-0441 config/);

  const wrongOrder = scoreboardFixture();
  wrongOrder.manifest.rows[0]!.pair_order = wrongOrder.manifest.rows[0]!.pair_order === 1 ? 2 : 1;
  wrongOrder.writeManifest();
  assert.throws(() => scoreFixture(wrongOrder), /wrong deterministic pair order/);
});

test("EPIC-0441 input rejects caller scores and invented live tiers", () => {
  const selfScore = scoreboardFixture();
  Object.assign(selfScore.manifest.rows[0]!, { score: 1, correctness: 1 });
  selfScore.writeManifest();
  assert.throws(() => scoreFixture(selfScore), /must NOT have additional properties/);

  const inventedTier = scoreboardFixture();
  (inventedTier.manifest.rows[0] as { classification: string }).classification = "live_committed_verified";
  inventedTier.writeManifest();
  assert.throws(() => scoreFixture(inventedTier), /must be equal to one of the allowed values/);
});

test("sealed novel rows and unsupported or blocked-safe rows fail closed", () => {
  const novel = scoreboardFixture();
  novel.manifest.rows.find((row) => row.task_id === "n28_novel_holdout")!.classification = "source_only";
  novel.writeManifest();
  assert.throws(() => scoreFixture(novel), /must remain sealed_not_yet_run/);

  const blocked = scoreboardFixture();
  const row = blocked.manifest.rows.find((entry) => entry.task_id === "g25_export_publish")!;
  row.classification = "blocked_safe";
  row.reason = "No publication capability was granted; staging was not attempted.";
  blocked.writeManifest();
  const scored = scoreFixture(blocked);
  assert.equal(scored.results.find((entry) => entry.task_id === row.task_id && entry.config_id === row.config_id)!.classification, "blocked_safe");
  assert.equal(scored.scoreboard.broad_live_acceptance_claimable, false);

  row.reason = null;
  blocked.writeManifest();
  assert.throws(() => scoreFixture(blocked), /requires an honest reason/);
});

test("mixed source/mock tiers are calibration counts and never inflate paired live acceptance", () => {
  const fixture = scoreboardFixture();
  const dynamic = fixture.manifest.rows.find((row) => row.task_id === "r01_schedule_value_edit" && row.representation === "dynamic_program")!;
  dynamic.classification = "mocked";
  dynamic.reason = "Mock runner calibration only.";
  fixture.writeManifest();
  const scored = scoreFixture(fixture);
  assert.equal(scored.scoreboard.mixed_tier_pair_count, 1);
  assert.equal(scored.scoreboard.source_mock_calibration.find((row) => row.representation === "dynamic_program")!.mocked_count, 1);
  assert.equal(scored.scoreboard.authenticated_live_pair_count, 0);
  assert.equal(scored.scoreboard.broad_live_acceptance_claimable, false);
});

test("reviewer packet bytes are hash-bound without entering scorer outputs", () => {
  const fixture = scoreboardFixture();
  fs.appendFileSync(fixture.reviewerPacketPath, "tamper");
  assert.throws(() => scoreFixture(fixture), /Reviewer packet hash does not match/);
});

test("receipt rows reuse the EPIC-0439 verifier and remain unverified for campaign scoring", () => {
  const fixture = scoreboardFixture();
  const worker = {
    schema: "dynamic-revit-worker-output/v0",
    sourceHash: `sha256:${"1".repeat(64)}`,
    programHash: `sha256:${"2".repeat(64)}`,
    sdkHash: `sha256:${"3".repeat(64)}`,
    graph: { inputHash: `sha256:${"4".repeat(64)}`, graphHash: `sha256:${"5".repeat(64)}` }
  };
  const admission = {
    operationGraphHash: worker.graph.graphHash,
    documentFingerprint: `sha256:${"6".repeat(64)}`,
    documentSessionId: "session-1"
  };
  const previewReceipt = JSON.stringify({
    schema: "dynamic-revit-preview-receipt/v0", ok: true, preview_id: "preview-1",
    source_hash: worker.sourceHash, program_hash: worker.programHash, sdk_hash: worker.sdkHash,
    input_hash: worker.graph.inputHash, graph_hash: worker.graph.graphHash,
    document_fingerprint: admission.documentFingerprint, document_session_id: admission.documentSessionId,
    projected_changed_element_ids: [], rollback_truth: true
  });
  const evidence = {
    schema: "dynamic-revit-phase2-live-evidence/v0", ok: true,
    startedUtc: "2026-08-09T10:00:00.000Z", completedUtc: "2026-08-09T10:00:01.000Z",
    workerOutput: worker, admission, previewReceipt, failure: null
  };
  const evidencePath = path.join(fixture.root, "receipt.json");
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const row = fixture.manifest.rows.find((entry) => entry.task_id === "r01_schedule_value_edit")!;
  row.classification = "receipt";
  row.reason = null;
  row.evidence_file = "receipt.json";
  row.evidence_sha256 = hash(fs.readFileSync(evidencePath));
  fixture.writeManifest();
  const scored = scoreFixture(fixture);
  const result = scored.results.find((entry) => entry.task_id === row.task_id && entry.config_id === row.config_id)!;
  assert.equal(result.classification, "live_preview_unverified");
  assert.equal(result.scored, false);
  assert.equal(result.authenticated_campaign_binding, false);
  assert.equal(scored.scoreboard.broad_live_acceptance_claimable, false);
});
