import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { benchmarkDataRoot } from "../src/benchmark/files.js";
import { loadGeneralRevitCapabilityCorpus, validateGeneralRevitCapabilityCorpus } from "../src/benchmark/general_revit_capability_acceptance.js";
import { buildGeneralRevitAcceptanceReviewPacket, summarizeGeneralRevitAcceptanceReview } from "../src/benchmark/general_revit_acceptance_review.js";
import { generalRevitProtocolManifestPathV2, loadGeneralRevitProtocolInputsV2 } from "../src/benchmark/protocol_v2_general_revit.js";
import { markdownReport } from "../src/benchmark/general_revit_capability_report.js";

const manifest = path.join(benchmarkDataRoot(), "general-agent", "revit-capability-acceptance.v2.json");
const corpus = loadGeneralRevitCapabilityCorpus(manifest);
const selected = corpus.cases.slice(0, 2);
const traces = selected.map(entry => ({ case_id: entry.case_id, verification_results: { completed: true, verified: true } }));

test("realistic corpus preserves historical loading and binds the exact selected manifest", () => {
  assert.equal(loadGeneralRevitCapabilityCorpus().suite_id, "general-revit-worker-basics-and-redlines-v1");
  const inputs = loadGeneralRevitProtocolInputsV2("", manifest);
  assert.equal(inputs.corpus.suite_id, "general-revit-engineer-requests-v2");
  assert.equal(generalRevitProtocolManifestPathV2(inputs), manifest);
  assert.throws(() => loadGeneralRevitProtocolInputsV2("external.json", manifest), /not both/);
  assert.equal(corpus.cases.length, 100);
  for (const entry of corpus.cases) {
    assert.equal(entry.fixture_precondition?.clear_selection, true);
    assert.ok(entry.acceptance_review?.delivery_criteria.length);
    assert.doesNotMatch(entry.prompt, /lowest.{0,15}(element|id)|element\s+id\s+\d/i);
  }
});

test("reviewed corpus rejects missing reset state and malformed review criteria", () => {
  const missingReset = structuredClone(corpus);
  delete missingReset.cases[0]!.fixture_precondition!.clear_selection;
  assert.throws(() => validateGeneralRevitCapabilityCorpus(missingReset), /fresh selection/);
  const emptyCriteria = structuredClone(corpus);
  emptyCriteria.cases[0]!.acceptance_review!.collateral_criteria = [];
  assert.throws(() => validateGeneralRevitCapabilityCorpus(emptyCriteria), /independent review criteria/);
  const invalidReset = structuredClone(corpus);
  (invalidReset.cases[0]!.fixture_precondition as Record<string, unknown>).clear_selection = "true";
  assert.throws(() => validateGeneralRevitCapabilityCorpus(invalidReset), /selection/);
});

test("generic runtime verification cannot create an independently delivered grade", () => {
  const packet = buildGeneralRevitAcceptanceReviewPacket("run-1", selected, traces)!;
  const summary = summarizeGeneralRevitAcceptanceReview(packet, packet);
  assert.equal(summary.delivered, 0);
  assert.equal(summary.delivery_rate, null);
  assert.equal(summary.pending, 2);
  assert.match(markdownReport({ runtime_score_is_provisional: true }), /not the final task-delivery grade/);
  assert.throws(() => buildGeneralRevitAcceptanceReviewPacket("run-1", selected, [traces[0]!, traces[0]!]), /exactly one/);
});

test("review refuses changed source, removed criteria and unsupported completion", () => {
  const packet = buildGeneralRevitAcceptanceReviewPacket("run-1", selected, traces)!;
  for (const mutate of [
    (value: typeof packet) => { value.cases[0]!.raw_trace_sha256 = "f".repeat(64); },
    (value: typeof packet) => { value.cases[0]!.collateral = []; },
    (value: typeof packet) => { value.cases[0]!.outcome = "delivered"; value.cases[0]!.explanation = "Completed flag"; value.cases[0]!.evidence_refs = ["trace.json"]; },
    (value: typeof packet) => { value.cases[0]!.delivery[0]!.status = "pass"; }
  ]) {
    const changed = structuredClone(packet);
    mutate(changed);
    assert.throws(() => summarizeGeneralRevitAcceptanceReview(packet, changed));
  }
});

test("clarification and fixture blockers remain separate from delivery", () => {
  const packet = buildGeneralRevitAcceptanceReviewPacket("run-1", selected, traces)!;
  const reviewed = structuredClone(packet);
  reviewed.cases[0]!.outcome = "clarification";
  reviewed.cases[1]!.outcome = "fixture_blocked";
  for (const entry of reviewed.cases) { entry.explanation = "Native inspection and retained question reviewed."; entry.evidence_refs = ["retained.json#/question"]; }
  const summary = summarizeGeneralRevitAcceptanceReview(packet, reviewed);
  assert.equal(summary.delivery_rate, 0);
  assert.equal(summary.clarification, 1);
  assert.equal(summary.fixture_blocked, 1);
});
