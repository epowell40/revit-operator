import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { benchmarkDataRoot, readJsonFile } from "./files.js";
import { verifyEpic0439LiveEvidenceFile } from "./epic0439_evidence.js";
import { type Epic0441Campaign, type Epic0441CampaignTask, validateEpic0441Campaign } from "./epic0441_campaign.js";

export type Epic0441InputClassification =
  | "receipt"
  | "source_only"
  | "mocked"
  | "unsupported"
  | "blocked_safe"
  | "failed"
  | "sealed_not_yet_run";

export type Epic0441ResultClassification = Exclude<Epic0441InputClassification, "receipt"> |
  "live_preview_unverified" | "live_applied_unverified" | "failed_receipt_unverified";

export type Epic0441EvidenceRow = {
  task_id: string;
  config_id: string;
  representation: "typed_capability_chain" | "dynamic_program";
  pair_order: 1 | 2;
  ordering_key: string;
  classification: Epic0441InputClassification;
  reason: string | null;
  evidence_file?: string;
  evidence_sha256?: string;
};

export type Epic0441EvidenceManifest = {
  schema_version: "epic0441_evidence_manifest/v1";
  suite_id: string;
  campaign_seed: string;
  ordering_algorithm: "sha256-balanced-pairs/v1";
  reviewer_packet_sha256: string;
  rows: Epic0441EvidenceRow[];
};

export type Epic0441Result = {
  schema_version: "epic0441_result/v1";
  suite_id: string;
  task_id: string;
  config_id: string;
  representation: "typed_capability_chain" | "dynamic_program";
  pair_order: 1 | 2;
  ordering_key: string;
  classification: Epic0441ResultClassification;
  reason: string | null;
  scored: false;
  authenticated_campaign_binding: false;
  reviewer_packet_sha256?: string;
  evidence_receipt?: {
    evidence_file_sha256: string;
    canonical_binding_sha256: string;
    receipt_schema: "dynamic-revit-live-evidence/v1" | "dynamic-revit-phase2-live-evidence/v0";
  };
};

export type Epic0441Scoreboard = {
  schema_version: "epic0441_scoreboard/v1";
  suite_id: string;
  campaign_seed: string;
  ordering_algorithm: "sha256-balanced-pairs/v1";
  typed_first_task_count: 15;
  dynamic_first_task_count: 15;
  reviewer_packet_sha256: string;
  results_sha256: string;
  task_count: 30;
  row_count: 60;
  complete_pair_count: 30;
  sealed_not_yet_run_count: number;
  mixed_tier_pair_count: number;
  authenticated_live_pair_count: 0;
  broad_live_acceptance_claimable: false;
  tier_counts: Record<string, number>;
  source_mock_calibration: Array<{
    config_id: string;
    representation: "typed_capability_chain" | "dynamic_program";
    source_only_count: number;
    mocked_count: number;
  }>;
};

const contractRoot = path.join(benchmarkDataRoot(), "contracts");
const hashPattern = /^sha256:[a-f0-9]{64}$/;

function sha256(value: string | Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

export function epic0441ReviewerPacketSha256(value: Buffer): string {
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new Error("Private reviewer packet must be valid UTF-8."); }
  if (decoded.startsWith("\uFEFF")) throw new Error("Private reviewer packet must not contain a UTF-8 BOM.");
  return sha256(Buffer.from(decoded.replace(/\r\n?/g, "\n"), "utf8"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function validateSchema<T>(value: unknown, schemaName: string): asserts value is T {
  const schema = readJsonFile<Record<string, unknown>>(path.join(contractRoot, schemaName));
  const validate = new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(schema);
  if (!validate(value)) {
    const detail = validate.errors?.map((entry) => `${entry.instancePath || "/"} ${entry.message}`).join("; ");
    throw new Error(`Invalid ${schemaName}: ${detail}`);
  }
}

export function epic0441Ordering(campaign: Epic0441Campaign, campaignSeed: string): Map<string, {
  ordering_key: string;
  first_representation: "typed_capability_chain" | "dynamic_program";
}> {
  if (!campaignSeed.trim()) throw new Error("EPIC-0441 campaign seed is required.");
  const ranked = campaign.tasks.map((task) => ({
    task_id: task.task_id,
    ordering_key: sha256(`${campaign.suite_id}\n${campaignSeed}\n${task.task_id}`)
  })).sort((left, right) => left.ordering_key.localeCompare(right.ordering_key));
  const typedFirst = new Set(ranked.slice(0, Math.ceil(ranked.length / 2)).map((entry) => entry.task_id));
  return new Map(ranked.map((entry) => [entry.task_id, {
    ordering_key: entry.ordering_key,
    first_representation: typedFirst.has(entry.task_id) ? "typed_capability_chain" : "dynamic_program"
  }]));
}

export function createEpic0441EvidenceManifestSkeleton(args: {
  campaign: Epic0441Campaign;
  campaignSeed: string;
  reviewerPacketSha256: string;
}): Epic0441EvidenceManifest {
  validateEpic0441Campaign(args.campaign);
  if (args.campaign.tasks.length !== 30 || args.campaign.execution_configs.length !== 2 || !hashPattern.test(args.reviewerPacketSha256)) {
    throw new Error("EPIC-0441 evidence skeleton requires the frozen campaign and a canonical reviewer-packet hash.");
  }
  const ordering = epic0441Ordering(args.campaign, args.campaignSeed);
  return {
    schema_version: "epic0441_evidence_manifest/v1",
    suite_id: args.campaign.suite_id,
    campaign_seed: args.campaignSeed,
    ordering_algorithm: "sha256-balanced-pairs/v1",
    reviewer_packet_sha256: args.reviewerPacketSha256,
    rows: args.campaign.tasks.flatMap((task) => args.campaign.execution_configs.map((config) => {
      const taskOrdering = ordering.get(task.task_id)!;
      const sealed = task.wave === "novel_post_freeze";
      return {
        task_id: task.task_id,
        config_id: config.config_id,
        representation: config.representation,
        pair_order: (config.representation === taskOrdering.first_representation ? 1 : 2) as 1 | 2,
        ordering_key: taskOrdering.ordering_key,
        classification: sealed ? "sealed_not_yet_run" as const : "source_only" as const,
        reason: sealed
          ? "Independent post-freeze task remains sealed from this source-calibration manifest."
          : "No scorer-authenticated task/config receipt is attached; source-level campaign calibration only."
      };
    }))
  };
}

function requireReason(row: Epic0441EvidenceRow): void {
  if (row.classification !== "receipt" && (typeof row.reason !== "string" || !row.reason.trim())) {
    throw new Error(`${row.task_id}/${row.config_id} classification '${row.classification}' requires an honest reason.`);
  }
}

function validateRowClassification(row: Epic0441EvidenceRow, task: Epic0441CampaignTask): void {
  requireReason(row);
  if (task.wave === "novel_post_freeze") {
    if (row.classification !== "sealed_not_yet_run") {
      throw new Error(`Novel task '${task.task_id}' must remain sealed_not_yet_run in this v1 scorer.`);
    }
  } else if (row.classification === "sealed_not_yet_run") {
    throw new Error(`Only novel post-freeze tasks may be sealed_not_yet_run.`);
  }
}

export function readEpic0441EvidenceManifest(filePath: string): Epic0441EvidenceManifest {
  const value = readJsonFile<unknown>(filePath);
  validateSchema<Epic0441EvidenceManifest>(value, "epic0441_evidence_manifest.v1.schema.json");
  return value;
}

export function scoreEpic0441Campaign(options: {
  campaign: Epic0441Campaign;
  evidenceManifestPath: string;
  evidenceRoot: string;
  reviewerPacketPath: string;
}): { results: Epic0441Result[]; scoreboard: Epic0441Scoreboard } {
  validateEpic0441Campaign(options.campaign);
  if (options.campaign.tasks.length !== 30 || options.campaign.execution_configs.length !== 2) {
    throw new Error("EPIC-0441 v1 scoring requires exactly 30 tasks and two configurations.");
  }
  if (new Set(options.campaign.execution_configs.map((config) => config.config_id)).size !== 2) {
    throw new Error("EPIC-0441 v1 scoring requires two unique configuration ids.");
  }
  const evidenceManifest = readEpic0441EvidenceManifest(options.evidenceManifestPath);
  if (evidenceManifest.suite_id !== options.campaign.suite_id) throw new Error("Evidence manifest suite does not match campaign.");
  const reviewerPacketBytes = fs.readFileSync(options.reviewerPacketPath);
  if (reviewerPacketBytes.length === 0) throw new Error("Private reviewer packet must not be empty.");
  const reviewerPacketSha256 = epic0441ReviewerPacketSha256(reviewerPacketBytes);
  if (evidenceManifest.reviewer_packet_sha256 !== reviewerPacketSha256) {
    throw new Error("Reviewer packet hash does not match the private packet bytes.");
  }
  const ordering = epic0441Ordering(options.campaign, evidenceManifest.campaign_seed);
  const tasks = new Map(options.campaign.tasks.map((task) => [task.task_id, task]));
  const configs = new Map(options.campaign.execution_configs.map((config) => [config.config_id, config]));
  const seen = new Set<string>();
  const results: Epic0441Result[] = [];
  for (const row of evidenceManifest.rows) {
    const task = tasks.get(row.task_id);
    if (!task) throw new Error(`Unknown EPIC-0441 task '${row.task_id}'.`);
    const config = configs.get(row.config_id);
    if (!config) throw new Error(`Unknown EPIC-0441 config '${row.config_id}'.`);
    if (row.representation !== config.representation) throw new Error(`${row.task_id}/${row.config_id} has the wrong representation.`);
    const pairKey = `${row.task_id}\0${row.config_id}`;
    if (seen.has(pairKey)) throw new Error(`Duplicate EPIC-0441 task/config row '${row.task_id}/${row.config_id}'.`);
    seen.add(pairKey);
    const expectedOrdering = ordering.get(row.task_id)!;
    if (row.ordering_key !== expectedOrdering.ordering_key) throw new Error(`${row.task_id} has the wrong deterministic ordering key.`);
    const expectedOrder = row.representation === expectedOrdering.first_representation ? 1 : 2;
    if (row.pair_order !== expectedOrder) throw new Error(`${row.task_id}/${row.config_id} has the wrong deterministic pair order.`);
    validateRowClassification(row, task);
    let classification: Epic0441ResultClassification = row.classification === "receipt" ? "failed" : row.classification;
    let reason = row.reason;
    let evidenceReceipt: Epic0441Result["evidence_receipt"];
    if (row.classification === "receipt") {
      const verified = verifyEpic0439LiveEvidenceFile({
        evidenceRoot: options.evidenceRoot,
        evidenceFile: row.evidence_file!,
        expectedSha256: row.evidence_sha256!
      });
      if (task.action_policy === "dry_run_only" && verified.schema === "dynamic-revit-live-evidence/v1") {
        throw new Error(`Dry-run-only task '${task.task_id}' cannot ingest an apply receipt.`);
      }
      classification = verified.completed
        ? verified.schema === "dynamic-revit-live-evidence/v1" ? "live_applied_unverified" : "live_preview_unverified"
        : "failed_receipt_unverified";
      reason = verified.completed
        ? "Runtime receipt chain completed, but it does not authenticate this EPIC-0441 task/config assignment."
        : "Runtime receipt chain was ingested but did not establish a completed execution."
      evidenceReceipt = {
        evidence_file_sha256: verified.evidenceFileSha256,
        canonical_binding_sha256: verified.bindingHash,
        receipt_schema: verified.schema
      };
    }
    results.push({
      schema_version: "epic0441_result/v1",
      suite_id: options.campaign.suite_id,
      task_id: row.task_id,
      config_id: row.config_id,
      representation: row.representation,
      pair_order: row.pair_order,
      ordering_key: row.ordering_key,
      classification,
      reason,
      scored: false,
      authenticated_campaign_binding: false,
      ...(classification === "sealed_not_yet_run" ? { reviewer_packet_sha256: reviewerPacketSha256 } : {}),
      ...(evidenceReceipt ? { evidence_receipt: evidenceReceipt } : {})
    });
  }
  for (const task of options.campaign.tasks) {
    for (const config of options.campaign.execution_configs) {
      if (!seen.has(`${task.task_id}\0${config.config_id}`)) {
        throw new Error(`Missing EPIC-0441 task/config row '${task.task_id}/${config.config_id}'.`);
      }
    }
  }
  const taskIndex = new Map(options.campaign.tasks.map((task, index) => [task.task_id, index]));
  results.sort((left, right) => taskIndex.get(left.task_id)! - taskIndex.get(right.task_id)! || left.pair_order - right.pair_order);
  for (const result of results) validateSchema<Epic0441Result>(result, "epic0441_result.v1.schema.json");
  const tierCounts: Record<string, number> = {};
  for (const result of results) tierCounts[result.classification] = (tierCounts[result.classification] ?? 0) + 1;
  const mixedTierPairCount = options.campaign.tasks.filter((task) => {
    const pair = results.filter((result) => result.task_id === task.task_id);
    return pair[0]!.classification !== pair[1]!.classification;
  }).length;
  const scoreboard: Epic0441Scoreboard = {
    schema_version: "epic0441_scoreboard/v1",
    suite_id: options.campaign.suite_id,
    campaign_seed: evidenceManifest.campaign_seed,
    ordering_algorithm: "sha256-balanced-pairs/v1",
    typed_first_task_count: 15,
    dynamic_first_task_count: 15,
    reviewer_packet_sha256: reviewerPacketSha256,
    results_sha256: sha256(canonicalJson(results)),
    task_count: 30,
    row_count: 60,
    complete_pair_count: 30,
    sealed_not_yet_run_count: tierCounts.sealed_not_yet_run ?? 0,
    mixed_tier_pair_count: mixedTierPairCount,
    authenticated_live_pair_count: 0,
    broad_live_acceptance_claimable: false,
    tier_counts: tierCounts,
    source_mock_calibration: options.campaign.execution_configs.map((config) => ({
      config_id: config.config_id,
      representation: config.representation,
      source_only_count: results.filter((result) => result.config_id === config.config_id && result.classification === "source_only").length,
      mocked_count: results.filter((result) => result.config_id === config.config_id && result.classification === "mocked").length
    }))
  };
  validateSchema<Epic0441Scoreboard>(scoreboard, "epic0441_scoreboard.v1.schema.json");
  if (!hashPattern.test(scoreboard.reviewer_packet_sha256) || !hashPattern.test(scoreboard.results_sha256)) {
    throw new Error("Scoreboard hash binding is malformed.");
  }
  return { results, scoreboard };
}
