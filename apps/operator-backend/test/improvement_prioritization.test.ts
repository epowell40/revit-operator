import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("clusterImprovementSignals groups related signals and computes weighted score", async () => {
  const mod = await import("../src/improvement/prioritization.js");
  const clusters = mod.clusterImprovementSignals([
    {
      fingerprint: "fp-1",
      source: "feedback",
      subsystem: "backend/redline",
      issue_keys: ["RepeatedToolLoop"],
      tools: ["revit_find_elements"],
      occurrence_count: 3,
      severity: 0.9,
      confidence: 0.8,
      last_seen_at: new Date().toISOString()
    },
    {
      fingerprint: "fp-2",
      source: "nightly_triage",
      subsystem: "backend/redline",
      issue_keys: ["RepeatedToolLoop"],
      tools: ["revit_find_elements"],
      occurrence_count: 2,
      severity: 0.7,
      confidence: 0.6,
      last_seen_at: new Date().toISOString()
    }
  ]);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]?.occurrence_count, 5);
  assert.equal(clusters[0]?.fingerprint_keys.length, 2);
  assert.equal((clusters[0]?.weighted_impact_score ?? 0) > 0, true);
});

test("buildIssueCampaigns emits campaigns for repeated clusters", async () => {
  const mod = await import("../src/improvement/prioritization.js");
  const campaigns = mod.buildIssueCampaigns([
    {
      fingerprint: "fp-1",
      source: "feedback",
      subsystem: "mep/resize",
      issue_keys: ["ResizeTimeout"],
      tools: ["/revit/resize-duct-run"],
      occurrence_count: 1,
      severity: 0.8,
      confidence: 0.7
    },
    {
      fingerprint: "fp-2",
      source: "github_issue",
      subsystem: "mep/resize",
      issue_keys: ["ResizeTimeout"],
      tools: ["/revit/resize-duct-run"],
      occurrence_count: 1,
      severity: 0.9,
      confidence: 0.8
    }
  ]);

  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0]?.campaign_key, "campaign/mep/resize");
  assert.equal(campaigns[0]?.job_count, 2);
});

test("mineSkillCandidates writes markdown candidates to local staging", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-skill-miner-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_DEV_MODE = "1";

  const store = await import("../src/improvement/job_store.js");
  const worker = await import("../src/improvement/job_worker.js");
  const miner = await import("../src/improvement/skill_candidate_miner.js");
  store.__closeForTests();

  worker.enqueueFeedbackImprovementJob({
    session_id: "s1",
    chat_id: "c1",
    rating: "failed",
    note: "Loop observed in redline mutation",
    created_at: "2026-03-12T10:00:00.000Z",
    dev_handoff: {
      latest_user_request: "Change selected receptacles to GFCI",
      issue_digest: [{ key: "RepeatedToolLoop", count: 3, tools: ["revit_find_elements"], sample: "loop" }],
      recommendations: ["Add loop breaker"],
      signals: ["planner repeated same call"]
    } as any
  });

  const candidates = miner.mineSkillCandidates({ min_occurrence_count: 1, min_impact_score: 0, limit: 3 });
  assert.equal(candidates.length >= 1, true);
  const firstPath = candidates[0]!.file_path;
  const content = fs.readFileSync(firstPath, "utf8");
  assert.match(content, /## Failure modes/);
  assert.match(content, /## When not to use/);
  assert.match(content, /tool_contract_version: v1/);
});
