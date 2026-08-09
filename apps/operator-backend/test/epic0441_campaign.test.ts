import test from "node:test";
import assert from "node:assert/strict";
import {
  EPIC0441_REQUIRED_REDLINE_FAMILIES,
  loadEpic0441Campaign,
  sealEpic0441NovelTasks,
  validateEpic0441Campaign,
  type Epic0441Campaign
} from "../src/benchmark/epic0441_campaign.js";

const campaign = loadEpic0441Campaign();

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
