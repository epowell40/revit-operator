import fs from "node:fs";
import path from "node:path";
import { benchmarkDataRoot, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";

export const EPIC0439_REQUIRED_DOMAINS = [
  "parameter_simple",
  "parameter_bulk",
  "sheet_view",
  "schedule",
  "geometry",
  "hosted_placement",
  "mep_routing_connectivity",
  "existing_conditions",
  "annotation",
  "linked_model",
  "family_content",
  "export_publish",
  "company_rule",
  "project_rule",
  "user_rule",
  "novel"
] as const;

export type Epic0439Domain = (typeof EPIC0439_REQUIRED_DOMAINS)[number];
export type Epic0439Representation = "typed_capability_chain" | "dynamic_program";
export type Epic0439EvidenceTier = "source_only" | "mocked" | "live_revit_unverified" | "live_revit";
export type Epic0439RecoveryOutcome = "not_needed" | "recovered" | "failed" | "outcome_uncertain";

export type Epic0439ExecutionConfig = {
  config_id: string;
  representation: Epic0439Representation;
  description: string;
  requires_preview: boolean;
  requires_verification: boolean;
};

export type Epic0439Task = {
  task_id: string;
  domain: Epic0439Domain;
  title: string;
  description: string;
  typed_feasibility: "feasible" | "partial" | "no_dedicated_workflow";
  dynamic_feasibility: "feasible" | "partial";
  operation_family: string;
  sdk_domains: string[];
  external_effect_class: "transactional_model" | "staged_publish";
  implementation_wording: string[];
  holdout_wording: string[];
  rule_pool: string[];
  selection_query: string;
  success_assertions: string[];
};

export type Epic0439UsefulnessManifest = {
  schema_version: "epic0439_usefulness/v1";
  suite_id: string;
  purpose: string;
  truth_policy: {
    permitted_evidence_tiers: Epic0439EvidenceTier[];
    live_claim_requires_receipt: boolean;
    source_and_mock_are_not_live_acceptance: boolean;
  };
  randomization: {
    algorithm: "xorshift32";
    target_id_range: [number, number];
    labels: string[];
    parameter_values: string[];
    displacement_mm_range: [number, number];
    element_count_range: [number, number];
    view_contexts: string[];
  };
  target_selection_contract: {
    dynamic_strategy: "live_evidence_query";
    fixture_ids_may_appear_in_generated_source: false;
    operated_ids_must_be_observed: true;
  };
  execution_configs: Epic0439ExecutionConfig[];
  tasks: Epic0439Task[];
};

export type Epic0439Case = {
  schema_version: "epic0439_case/v1";
  suite_id: string;
  case_id: string;
  task_id: string;
  domain: Epic0439Domain;
  variant_index: number;
  seed: string;
  wording_partition: "implementation" | "holdout" | "reviewer_holdout";
  user_prompt: string;
  randomized_inputs: {
    label: string;
    parameter_value: string;
    displacement_mm: number;
    element_count: number;
    view_context: string;
    rule: string;
  };
  fixture_evidence: {
    evidence_kind: "synthetic_observation_fixture";
    candidates: Array<{ element_id: string; label: string; view_context: string; matches: boolean }>;
  };
  evaluator_ground_truth: {
    expected_target_ids: string[];
    selection_query: string;
    success_assertions: string[];
  };
  target_selection: {
    required_strategy: "live_evidence_query";
    prompt_contains_target_ids: false;
    generated_source_may_contain_fixture_ids: false;
  };
  execution_config_ids: [string, string];
};

export type Epic0439DynamicSelectionEvidence = {
  strategy: "live_evidence_query" | "literal_fixture_ids" | "other";
  generated_source: string;
  observed_element_ids: string[];
  operated_element_ids: string[];
};

export type Epic0439Metrics = {
  completion: boolean;
  correctness: number;
  changed_element_precision: number;
  model_turns: number;
  tool_rpc_calls: number;
  generated_code_bytes: number;
  execution_time_ms: number;
  estimated_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  preview_repairs: number;
  verification_quality: number;
  special_purpose_product_code_bytes: number;
  recovery_attempts: number;
  recovery_outcome: Epic0439RecoveryOutcome;
};

export type Epic0439LiveReceipt = {
  receipt_id: string;
  revit_version: string;
  document_session_id: string;
  admission_hash: string;
  preview_receipt_hash: string;
  apply_receipt_hash: string;
  verification_receipt_hash: string;
};

export type Epic0439ScorerEvidenceReceipt = {
  schema_version: "epic0439_scorer_evidence_receipt/v1";
  evidence_file_sha256: string;
  canonical_binding_sha256: string;
  receipt_schema: "dynamic-revit-live-evidence/v1" | "dynamic-revit-phase2-live-evidence/v0";
  authenticated_campaign_binding: false;
};

export type Epic0439Result = {
  schema_version: "epic0439_result/v1";
  case_id: string;
  task_id: string;
  config_id: string;
  representation: Epic0439Representation;
  evidence_tier: Epic0439EvidenceTier;
  metrics: Epic0439Metrics;
  failure: null | {
    phase: "generation" | "compile" | "admission" | "preview" | "apply" | "verification" | "cleanup";
    classification: string;
    summary: string;
  };
  notes: string[];
  live_revit_receipt?: Epic0439LiveReceipt;
  scorer_evidence_receipt?: Epic0439ScorerEvidenceReceipt;
};

type Aggregate = {
  config_id: string;
  representation: Epic0439Representation;
  evidence_tier: Epic0439EvidenceTier;
  sample_size: number;
  completion_rate: number;
  average_correctness: number;
  average_changed_element_precision: number;
  average_model_turns: number;
  average_tool_rpc_calls: number;
  average_generated_code_bytes: number;
  average_execution_time_ms: number;
  average_estimated_cost_usd: number;
  average_total_tokens: number;
  average_preview_repairs: number;
  average_verification_quality: number;
  average_special_purpose_product_code_bytes: number;
  average_recovery_attempts: number;
  recovery_rate: number;
};

export type Epic0439UsefulnessReport = {
  schema_version: "epic0439_report/v1";
  generated_at: string;
  suite_id: string;
  result_count: number;
  live_revit_result_count: number;
  source_only_result_count: number;
  mocked_result_count: number;
  unverified_live_result_count: number;
  live_acceptance_claimable: boolean;
  evidence_warning: string | null;
  aggregates: Aggregate[];
  paired_deltas: Array<{
    case_id: string;
    evidence_tier: Epic0439EvidenceTier;
    completion_dynamic_minus_typed: number;
    correctness_dynamic_minus_typed: number;
    precision_dynamic_minus_typed: number;
    tool_calls_dynamic_minus_typed: number;
    time_ms_dynamic_minus_typed: number;
    tokens_dynamic_minus_typed: number;
    product_code_bytes_dynamic_minus_typed: number;
  }>;
};

function manifestPath(): string {
  return path.join(benchmarkDataRoot(), "epic0439", "usefulness_matrix.v1.json");
}

export function loadEpic0439UsefulnessManifest(): Epic0439UsefulnessManifest {
  const manifest = readJsonFile<Epic0439UsefulnessManifest>(manifestPath());
  validateEpic0439UsefulnessManifest(manifest);
  return manifest;
}

export function validateEpic0439UsefulnessManifest(manifest: Epic0439UsefulnessManifest): void {
  if (manifest.schema_version !== "epic0439_usefulness/v1") throw new Error("Unsupported EPIC-0439 usefulness manifest.");
  if (manifest.randomization.algorithm !== "xorshift32") throw new Error("EPIC-0439 randomization algorithm must be xorshift32.");
  if (manifest.tasks.length !== EPIC0439_REQUIRED_DOMAINS.length) {
    throw new Error(`EPIC-0439 usefulness suite requires exactly ${EPIC0439_REQUIRED_DOMAINS.length} tasks.`);
  }
  const knownEvidenceTiers: Epic0439EvidenceTier[] = ["source_only", "mocked", "live_revit_unverified", "live_revit"];
  if (
    manifest.truth_policy.permitted_evidence_tiers.length !== knownEvidenceTiers.length ||
    knownEvidenceTiers.some((tier) => !manifest.truth_policy.permitted_evidence_tiers.includes(tier)) ||
    manifest.truth_policy.permitted_evidence_tiers.some((tier) => !knownEvidenceTiers.includes(tier))
  ) {
    throw new Error("EPIC-0439 truth policy must enumerate the supported evidence tiers exactly.");
  }
  const taskIds = new Set<string>();
  const domains = new Set<Epic0439Domain>();
  for (const task of manifest.tasks) {
    if (!task.task_id.trim() || taskIds.has(task.task_id)) throw new Error(`Duplicate or empty task id '${task.task_id}'.`);
    taskIds.add(task.task_id);
    domains.add(task.domain);
    if (task.implementation_wording.length === 0 || task.holdout_wording.length === 0) {
      throw new Error(`Task '${task.task_id}' needs both implementation and holdout wording.`);
    }
    const implementationWording = new Set(task.implementation_wording.map((entry) => entry.trim().toLowerCase()));
    if (task.holdout_wording.some((entry) => implementationWording.has(entry.trim().toLowerCase()))) {
      throw new Error(`Task '${task.task_id}' repeats implementation wording in its holdout pool.`);
    }
    if (task.rule_pool.length < 2) throw new Error(`Task '${task.task_id}' needs at least two randomized rules.`);
    if (!task.selection_query.trim()) throw new Error(`Task '${task.task_id}' is missing a live-evidence selection query.`);
  }
  for (const domain of EPIC0439_REQUIRED_DOMAINS) {
    if (!domains.has(domain)) throw new Error(`EPIC-0439 usefulness suite is missing domain '${domain}'.`);
  }
  for (const [field, values] of [
    ["labels", manifest.randomization.labels],
    ["parameter_values", manifest.randomization.parameter_values],
    ["view_contexts", manifest.randomization.view_contexts]
  ] as const) {
    if (values.length < 2) throw new Error(`EPIC-0439 randomization pool '${field}' needs at least two values.`);
  }
  for (const [field, range] of [
    ["target_id_range", manifest.randomization.target_id_range],
    ["displacement_mm_range", manifest.randomization.displacement_mm_range],
    ["element_count_range", manifest.randomization.element_count_range]
  ] as const) {
    if (!Number.isInteger(range[0]) || !Number.isInteger(range[1]) || range[0] < 0 || range[1] <= range[0]) {
      throw new Error(`EPIC-0439 randomization range '${field}' is invalid.`);
    }
  }
  const representations = new Set(manifest.execution_configs.map((config) => config.representation));
  if (!representations.has("typed_capability_chain") || !representations.has("dynamic_program")) {
    throw new Error("EPIC-0439 usefulness suite requires paired typed and dynamic configurations.");
  }
  if (
    manifest.target_selection_contract.dynamic_strategy !== "live_evidence_query" ||
    manifest.target_selection_contract.fixture_ids_may_appear_in_generated_source !== false ||
    manifest.target_selection_contract.operated_ids_must_be_observed !== true
  ) {
    throw new Error("EPIC-0439 dynamic target selection must be grounded in observed live evidence.");
  }
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 0x9e3779b9;
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function pick<T>(values: T[], random: () => number): T {
  if (values.length === 0) throw new Error("Cannot randomize from an empty pool.");
  return values[Math.floor(random() * values.length)]!;
}

function integerInRange(range: [number, number], random: () => number): number {
  const [minimum, maximum] = range;
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function render(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((output, [key, value]) => output.replaceAll(`{{${key}}}`, String(value)), template);
}

function fixtureId(random: () => number, range: [number, number], used: Set<string>): string {
  for (;;) {
    const candidate = String(integerInRange(range, random));
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export function materializeEpic0439Cases(
  manifest: Epic0439UsefulnessManifest,
  options: {
    seed: string;
    variants_per_task?: number;
    wording_partition?: "implementation" | "holdout" | "reviewer_holdout";
    reviewer_wording?: Record<string, string[]>;
  }
): Epic0439Case[] {
  validateEpic0439UsefulnessManifest(manifest);
  const variants = Math.max(1, Math.floor(options.variants_per_task ?? 1));
  const partition = options.wording_partition ?? "implementation";
  const typed = manifest.execution_configs.find((entry) => entry.representation === "typed_capability_chain")!;
  const dynamic = manifest.execution_configs.find((entry) => entry.representation === "dynamic_program")!;
  const cases: Epic0439Case[] = [];
  for (const task of manifest.tasks) {
    for (let variant = 0; variant < variants; variant += 1) {
      const random = xorshift32(hashSeed(`${manifest.suite_id}:${options.seed}:${task.task_id}:${variant}:${partition}`));
      const label = pick(manifest.randomization.labels, random);
      const parameterValue = pick(manifest.randomization.parameter_values, random);
      const displacement = integerInRange(manifest.randomization.displacement_mm_range, random);
      const count = integerInRange(manifest.randomization.element_count_range, random);
      const viewContext = pick(manifest.randomization.view_contexts, random);
      const rule = pick(task.rule_pool, random);
      const wordingPool =
        partition === "implementation"
          ? task.implementation_wording
          : partition === "reviewer_holdout"
            ? options.reviewer_wording?.[task.task_id] ?? task.holdout_wording
            : task.holdout_wording;
      if (!Array.isArray(wordingPool) || wordingPool.length === 0 || wordingPool.some((entry) => !String(entry).trim())) {
        throw new Error(`Reviewer wording for '${task.task_id}' must be a non-empty string array.`);
      }
      const template = pick(wordingPool, random);
      const values = { label, parameter_value: parameterValue, displacement_mm: displacement, count, view_context: viewContext, rule };
      const prompt = render(template, values);
      const selectionQuery = render(task.selection_query, values);
      const used = new Set<string>();
      const targetId = fixtureId(random, manifest.randomization.target_id_range, used);
      const distractorA = fixtureId(random, manifest.randomization.target_id_range, used);
      const distractorB = fixtureId(random, manifest.randomization.target_id_range, used);
      if ([targetId, distractorA, distractorB].some((id) => prompt.includes(id))) {
        throw new Error(`Task '${task.task_id}' leaked a fixture target id into its prompt.`);
      }
      cases.push({
        schema_version: "epic0439_case/v1",
        suite_id: manifest.suite_id,
        case_id: `${task.task_id}--${partition}--${variant}--${hashSeed(`${options.seed}:${task.task_id}:${variant}`).toString(16)}`,
        task_id: task.task_id,
        domain: task.domain,
        variant_index: variant,
        seed: options.seed,
        wording_partition: partition,
        user_prompt: prompt,
        randomized_inputs: {
          label,
          parameter_value: parameterValue,
          displacement_mm: displacement,
          element_count: count,
          view_context: viewContext,
          rule
        },
        fixture_evidence: {
          evidence_kind: "synthetic_observation_fixture",
          candidates: [
            { element_id: distractorA, label: `${label}-reference`, view_context: viewContext, matches: false },
            { element_id: targetId, label, view_context: viewContext, matches: true },
            { element_id: distractorB, label, view_context: `${viewContext}-other`, matches: false }
          ]
        },
        evaluator_ground_truth: {
          expected_target_ids: [targetId],
          selection_query: selectionQuery,
          success_assertions: task.success_assertions.map((entry) => render(entry, values))
        },
        target_selection: {
          required_strategy: "live_evidence_query",
          prompt_contains_target_ids: false,
          generated_source_may_contain_fixture_ids: false
        },
        execution_config_ids: [typed.config_id, dynamic.config_id]
      });
    }
  }
  return cases;
}

export function validateEpic0439DynamicSelection(
  benchmarkCase: Epic0439Case,
  evidence: Epic0439DynamicSelectionEvidence
): void {
  if (evidence.strategy !== "live_evidence_query") throw new Error("Dynamic target selection must use live_evidence_query.");
  const fixtureIds = benchmarkCase.fixture_evidence.candidates.map((candidate) => candidate.element_id);
  const leaked = fixtureIds.find((id) => evidence.generated_source.includes(id));
  if (leaked) throw new Error(`Generated source contains fixture element id '${leaked}'.`);
  const observed = new Set(evidence.observed_element_ids);
  const unobserved = evidence.operated_element_ids.find((id) => !observed.has(id));
  if (unobserved) throw new Error(`Operated element '${unobserved}' was not present in live evidence.`);
}

function bounded(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field} must be between 0 and 1.`);
}

export function validateEpic0439Result(result: Epic0439Result, manifest: Epic0439UsefulnessManifest): void {
  if (result.schema_version !== "epic0439_result/v1") throw new Error("Unsupported EPIC-0439 result schema.");
  if (!manifest.truth_policy.permitted_evidence_tiers.includes(result.evidence_tier)) {
    throw new Error(`Unsupported EPIC-0439 evidence tier '${String(result.evidence_tier)}'.`);
  }
  const config = manifest.execution_configs.find((entry) => entry.config_id === result.config_id);
  if (!config) throw new Error(`Unknown EPIC-0439 config '${result.config_id}'.`);
  if (!manifest.tasks.some((entry) => entry.task_id === result.task_id)) throw new Error(`Unknown EPIC-0439 task '${result.task_id}'.`);
  if (config.representation !== result.representation) throw new Error(`Result representation does not match config '${result.config_id}'.`);
  bounded(result.metrics.correctness, "correctness");
  bounded(result.metrics.changed_element_precision, "changed_element_precision");
  bounded(result.metrics.verification_quality, "verification_quality");
  for (const [field, value] of Object.entries(result.metrics)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw new Error(`${field} must be a non-negative finite number.`);
  }
  for (const field of ["model_turns", "tool_rpc_calls", "generated_code_bytes", "input_tokens", "output_tokens", "preview_repairs", "special_purpose_product_code_bytes", "recovery_attempts"] as const) {
    if (!Number.isInteger(result.metrics[field])) throw new Error(`${field} must be an integer.`);
  }
  if (result.representation === "typed_capability_chain" && result.metrics.generated_code_bytes !== 0) {
    throw new Error("Typed capability results must report zero generated code bytes.");
  }
  if (result.representation === "dynamic_program" && result.metrics.completion && result.metrics.generated_code_bytes === 0) {
    throw new Error("A completed dynamic program result must report generated code bytes.");
  }
  if (result.metrics.completion && result.failure) throw new Error("A completed result cannot carry a terminal failure.");
  if (!result.metrics.completion && !result.failure) throw new Error("An incomplete result must describe its terminal failure.");
  if (result.evidence_tier === "live_revit") {
    throw new Error("live_revit results cannot be accepted from caller-authored result JSON; use authenticated scorer evidence.");
  }
  if (result.live_revit_receipt) {
    throw new Error(`${result.evidence_tier} results must not carry a live Revit receipt.`);
  }
  if (result.evidence_tier === "live_revit_unverified") {
    const receipt = result.scorer_evidence_receipt;
    if (!receipt || receipt.schema_version !== "epic0439_scorer_evidence_receipt/v1") {
      throw new Error("A live_revit_unverified result requires a scorer evidence receipt.");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(receipt.evidence_file_sha256) || !/^sha256:[a-f0-9]{64}$/.test(receipt.canonical_binding_sha256)) {
      throw new Error("Scorer evidence receipt hashes must be canonical sha256 values.");
    }
    if (receipt.authenticated_campaign_binding !== false) {
      throw new Error("Unverified live evidence must not claim an authenticated campaign binding.");
    }
    if (result.metrics.correctness !== 0 || result.metrics.changed_element_precision !== 0 || result.metrics.verification_quality !== 0) {
      throw new Error("Unverified live evidence cannot claim correctness, precision, or verification credit.");
    }
  } else if (result.scorer_evidence_receipt) {
    throw new Error(`${result.evidence_tier} results must not carry a scorer evidence receipt.`);
  }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildEpic0439UsefulnessReport(
  manifest: Epic0439UsefulnessManifest,
  results: Epic0439Result[]
): Epic0439UsefulnessReport {
  for (const result of results) validateEpic0439Result(result, manifest);
  const groups = new Map<string, Epic0439Result[]>();
  for (const result of results) {
    const key = `${result.config_id}\u0000${result.evidence_tier}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  const aggregates = [...groups.values()].map((group): Aggregate => {
    const first = group[0]!;
    return {
      config_id: first.config_id,
      representation: first.representation,
      evidence_tier: first.evidence_tier,
      sample_size: group.length,
      completion_rate: mean(group.map((entry) => Number(entry.metrics.completion))),
      average_correctness: mean(group.map((entry) => entry.metrics.correctness)),
      average_changed_element_precision: mean(group.map((entry) => entry.metrics.changed_element_precision)),
      average_model_turns: mean(group.map((entry) => entry.metrics.model_turns)),
      average_tool_rpc_calls: mean(group.map((entry) => entry.metrics.tool_rpc_calls)),
      average_generated_code_bytes: mean(group.map((entry) => entry.metrics.generated_code_bytes)),
      average_execution_time_ms: mean(group.map((entry) => entry.metrics.execution_time_ms)),
      average_estimated_cost_usd: mean(group.map((entry) => entry.metrics.estimated_cost_usd)),
      average_total_tokens: mean(group.map((entry) => entry.metrics.input_tokens + entry.metrics.output_tokens)),
      average_preview_repairs: mean(group.map((entry) => entry.metrics.preview_repairs)),
      average_verification_quality: mean(group.map((entry) => entry.metrics.verification_quality)),
      average_special_purpose_product_code_bytes: mean(group.map((entry) => entry.metrics.special_purpose_product_code_bytes)),
      average_recovery_attempts: mean(group.map((entry) => entry.metrics.recovery_attempts)),
      recovery_rate: mean(group.map((entry) => Number(entry.metrics.recovery_outcome === "recovered")))
    };
  }).sort((a, b) => `${a.evidence_tier}:${a.config_id}`.localeCompare(`${b.evidence_tier}:${b.config_id}`));

  const byCase = new Map<string, Epic0439Result[]>();
  for (const result of results) {
    const key = `${result.case_id}\u0000${result.evidence_tier}`;
    byCase.set(key, [...(byCase.get(key) ?? []), result]);
  }
  const pairedDeltas: Epic0439UsefulnessReport["paired_deltas"] = [];
  for (const group of byCase.values()) {
    const typed = group.find((entry) => entry.representation === "typed_capability_chain");
    const dynamic = group.find((entry) => entry.representation === "dynamic_program");
    if (!typed || !dynamic) continue;
    pairedDeltas.push({
      case_id: typed.case_id,
      evidence_tier: typed.evidence_tier,
      completion_dynamic_minus_typed: Number(dynamic.metrics.completion) - Number(typed.metrics.completion),
      correctness_dynamic_minus_typed: dynamic.metrics.correctness - typed.metrics.correctness,
      precision_dynamic_minus_typed: dynamic.metrics.changed_element_precision - typed.metrics.changed_element_precision,
      tool_calls_dynamic_minus_typed: dynamic.metrics.tool_rpc_calls - typed.metrics.tool_rpc_calls,
      time_ms_dynamic_minus_typed: dynamic.metrics.execution_time_ms - typed.metrics.execution_time_ms,
      tokens_dynamic_minus_typed:
        dynamic.metrics.input_tokens + dynamic.metrics.output_tokens - typed.metrics.input_tokens - typed.metrics.output_tokens,
      product_code_bytes_dynamic_minus_typed:
        dynamic.metrics.special_purpose_product_code_bytes - typed.metrics.special_purpose_product_code_bytes
    });
  }
  const liveCount = results.filter((entry) => entry.evidence_tier === "live_revit").length;
  const sourceCount = results.filter((entry) => entry.evidence_tier === "source_only").length;
  const mockCount = results.filter((entry) => entry.evidence_tier === "mocked").length;
  const unverifiedLiveCount = results.filter((entry) => entry.evidence_tier === "live_revit_unverified").length;
  const liveResults = results.filter((entry) => entry.evidence_tier === "live_revit");
  const completeLivePairs = manifest.tasks.every((task) => {
    const taskResults = liveResults.filter((entry) => entry.task_id === task.task_id);
    return manifest.execution_configs.every((config) =>
      taskResults.some((entry) =>
        entry.config_id === config.config_id &&
        entry.metrics.completion &&
        entry.metrics.correctness === 1 &&
        entry.metrics.changed_element_precision === 1 &&
        entry.metrics.verification_quality === 1
      )
    );
  });
  return {
    schema_version: "epic0439_report/v1",
    generated_at: new Date().toISOString(),
    suite_id: manifest.suite_id,
    result_count: results.length,
    live_revit_result_count: liveCount,
    source_only_result_count: sourceCount,
    mocked_result_count: mockCount,
    unverified_live_result_count: unverifiedLiveCount,
    live_acceptance_claimable: completeLivePairs && sourceCount === 0 && mockCount === 0 && unverifiedLiveCount === 0,
    evidence_warning:
      liveCount === 0
        ? unverifiedLiveCount > 0
          ? "Live Revit receipts were structurally verified, but no authenticated campaign binding was present. They do not count as live acceptance."
          : "No live Revit outcomes are present. Source-only and mocked results are development evidence, not live acceptance."
        : sourceCount > 0 || mockCount > 0 || unverifiedLiveCount > 0
          ? "Mixed evidence tiers are reported separately; source-only, mocked, and unverified live outcomes do not count as live Revit acceptance."
          : null,
    aggregates,
    paired_deltas: pairedDeltas.sort((a, b) => a.case_id.localeCompare(b.case_id))
  };
}

export function readEpic0439Results(filePath: string): Epic0439Result[] {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error("EPIC-0439 results input must be a JSON array.");
  return value as Epic0439Result[];
}

export function writeEpic0439ReportArtifacts(
  outputDir: string,
  manifest: Epic0439UsefulnessManifest,
  results: Epic0439Result[]
): Epic0439UsefulnessReport {
  const report = buildEpic0439UsefulnessReport(manifest, results);
  writeJsonFile(path.join(outputDir, "epic0439_usefulness_report.json"), report);
  const lines = [
    "# EPIC-0439 Usefulness Report",
    "",
    `- Suite: ${report.suite_id}`,
    `- Results: ${report.result_count}`,
    `- Live Revit: ${report.live_revit_result_count}`,
    `- Mocked: ${report.mocked_result_count}`,
    `- Live Revit (unverified campaign binding): ${report.unverified_live_result_count}`,
    `- Source-only: ${report.source_only_result_count}`,
    `- Live acceptance claimable: ${report.live_acceptance_claimable ? "yes" : "no"}`,
    ...(report.evidence_warning ? [`- Warning: ${report.evidence_warning}`] : []),
    "",
    "## Aggregates",
    "",
    "| Evidence | Configuration | Representation | N | Completion | Correctness | Precision | Calls | Code bytes | Time ms | Tokens | Preview repairs | Verification | Product code bytes | Recovery attempts |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.aggregates.map((entry) =>
      `| ${entry.evidence_tier} | ${entry.config_id} | ${entry.representation} | ${entry.sample_size} | ${entry.completion_rate.toFixed(3)} | ${entry.average_correctness.toFixed(3)} | ${entry.average_changed_element_precision.toFixed(3)} | ${entry.average_tool_rpc_calls.toFixed(1)} | ${entry.average_generated_code_bytes.toFixed(1)} | ${entry.average_execution_time_ms.toFixed(1)} | ${entry.average_total_tokens.toFixed(1)} | ${entry.average_preview_repairs.toFixed(2)} | ${entry.average_verification_quality.toFixed(3)} | ${entry.average_special_purpose_product_code_bytes.toFixed(1)} | ${entry.average_recovery_attempts.toFixed(2)} |`
    ),
    "",
    "Paired deltas are available in the JSON report. Negative calls, time, tokens, or product-code bytes favor Dynamic Runtime; positive correctness and precision favor Dynamic Runtime.",
    ""
  ];
  writeTextFile(path.join(outputDir, "epic0439_usefulness_report.md"), `${lines.join("\n")}\n`);
  return report;
}
