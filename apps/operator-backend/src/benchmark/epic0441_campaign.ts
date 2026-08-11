import path from "node:path";
import { benchmarkDataRoot, readJsonFile } from "./files.js";

export const EPIC0441_REQUIRED_REPRESENTATIONS = ["typed_capability_chain", "dynamic_program"] as const;
export const EPIC0441_REQUIRED_REDLINE_FAMILIES = [
  "text_edit", "add", "size_transition", "tag", "delete", "move", "route", "type_change", "graphics_override", "reroute_offset"
] as const;

export type Epic0441CampaignTask = {
  task_id: string;
  wave: "redline_primary" | "general" | "novel_post_freeze";
  operation_family: string;
  corpus_weight: number;
  domain: string;
  substrate: string;
  action_policy: string;
  prompt: string | null;
  fixture_adapter: string;
  success_assertions: string[];
};

export type Epic0441Campaign = {
  schema_version: "epic0441_campaign/v1";
  suite_id: string;
  purpose: string;
  corpus_basis: {
    source_documents: number;
    source_pages: number;
    total_marks: number;
    actionable_union: number;
    raw_sources_available_to_runner: false;
    operation_counts: Record<string, number>;
  };
  truth_policy: {
    result_tiers: string[];
    runner_may_see_evaluator_selectors: false;
    prompt_may_contain_element_ids: false;
    old_redline_targets_may_be_replayed: false;
    self_reported_metrics_are_authoritative: false;
    live_claim_requires_verified_evidence_bundle: true;
    existing_element_delete_is_dry_run_only: true;
  };
  fixture_contract: {
    allowed_fixture_families: string[];
    forbidden_fixture_families: string[];
    hydrate_from_live_observation: true;
    pristine_hash_required: true;
    writable_copy_required_for_apply: true;
    discard_or_restore_required: true;
  };
  execution_configs: Array<{
    config_id: string;
    representation: (typeof EPIC0441_REQUIRED_REPRESENTATIONS)[number];
    preview_required: true;
    verification_required: true;
  }>;
  tasks: Epic0441CampaignTask[];
};

const ELEMENT_ID_PATTERN = /\b(?:element\s*id\s*[:=#]?\s*)?\d{5,}\b/i;

export function loadEpic0441Campaign(): Epic0441Campaign {
  const campaign = readJsonFile<Epic0441Campaign>(path.join(benchmarkDataRoot(), "epic0441", "campaign.v1.json"));
  validateEpic0441Campaign(campaign);
  return campaign;
}

export function validateEpic0441Campaign(campaign: Epic0441Campaign): void {
  if (campaign.schema_version !== "epic0441_campaign/v1") throw new Error("Unexpected EPIC-0441 campaign schema.");
  if (campaign.tasks.length < 25 || campaign.tasks.length > 30) throw new Error("EPIC-0441 requires 25-30 frozen task slots.");
  if (campaign.corpus_basis.total_marks !== 12_544 || campaign.corpus_basis.actionable_union !== 6_990) {
    throw new Error("EPIC-0441 corpus basis does not match the retained reviewed intake.");
  }
  if (campaign.corpus_basis.raw_sources_available_to_runner !== false) throw new Error("Raw redline sources are unavailable on this runner.");
  if (campaign.truth_policy.self_reported_metrics_are_authoritative !== false) throw new Error("Self-reported metrics must never be authoritative.");
  const representations = new Set(campaign.execution_configs.map((entry) => entry.representation));
  for (const required of EPIC0441_REQUIRED_REPRESENTATIONS) {
    if (!representations.has(required)) throw new Error(`Missing paired representation ${required}.`);
  }
  const ids = new Set<string>();
  for (const task of campaign.tasks) {
    if (!/^[a-z][a-z0-9_]{4,63}$/.test(task.task_id)) throw new Error(`Invalid task id ${task.task_id}.`);
    if (ids.has(task.task_id)) throw new Error(`Duplicate task id ${task.task_id}.`);
    ids.add(task.task_id);
    if (task.fixture_adapter.trim().length < 20) throw new Error(`Task ${task.task_id} lacks a fixture adaptation contract.`);
    if (task.wave === "novel_post_freeze") {
      if (task.prompt !== null || task.success_assertions.length !== 0 || task.substrate !== "unassigned_after_freeze") {
        throw new Error(`Novel task ${task.task_id} must remain sealed until post-freeze review.`);
      }
      continue;
    }
    if (!task.prompt || task.prompt.length < 40 || task.success_assertions.length < 3) throw new Error(`Task ${task.task_id} is underspecified.`);
    if (ELEMENT_ID_PATTERN.test(task.prompt)) throw new Error(`Task ${task.task_id} leaks an element-like id in its prompt.`);
    if (task.operation_family === "delete" && task.action_policy !== "dry_run_only") throw new Error(`Existing delete task ${task.task_id} must be dry-run-only.`);
  }
  const novel = campaign.tasks.filter((task) => task.wave === "novel_post_freeze");
  if (novel.length < 3) throw new Error("At least three post-freeze novel slots are required.");
  const redline = campaign.tasks.filter((task) => task.wave === "redline_primary");
  if (redline.length < 20) throw new Error("At least twenty tasks must be redline-primary.");
  const families = new Set(redline.map((task) => task.operation_family));
  for (const required of EPIC0441_REQUIRED_REDLINE_FAMILIES) {
    if (!families.has(required)) throw new Error(`Missing redline family ${required}.`);
    if (campaign.corpus_basis.operation_counts[required] !== redline.find((task) => task.operation_family === required)?.corpus_weight) {
      throw new Error(`Task weights for ${required} do not match the retained corpus basis.`);
    }
  }
}

export function sealEpic0441NovelTasks(
  campaign: Epic0441Campaign,
  reviewerTasks: ReadonlyArray<Pick<Epic0441CampaignTask, "task_id" | "substrate" | "action_policy" | "prompt" | "fixture_adapter" | "success_assertions">>
): Epic0441Campaign {
  const replacements = new Map(reviewerTasks.map((task) => [task.task_id, task]));
  const novelIds = campaign.tasks.filter((task) => task.wave === "novel_post_freeze").map((task) => task.task_id);
  if (replacements.size !== novelIds.length || novelIds.some((id) => !replacements.has(id))) {
    throw new Error("Reviewer must supply every and only the frozen novel task slots.");
  }
  const tasks = campaign.tasks.map((task) => {
    if (task.wave !== "novel_post_freeze") return task;
    const replacement = replacements.get(task.task_id)!;
    if (!replacement.prompt || replacement.prompt.length < 40 || ELEMENT_ID_PATTERN.test(replacement.prompt)) {
      throw new Error(`Novel task ${task.task_id} prompt is invalid or leaks an element-like id.`);
    }
    if (replacement.success_assertions.length < 3 || replacement.fixture_adapter.length < 20) {
      throw new Error(`Novel task ${task.task_id} lacks evaluator truth.`);
    }
    return { ...task, ...replacement };
  });
  return { ...campaign, tasks };
}
