import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSIGNMENT_SNAPSHOT_V2_SCHEMA } from "@revitoperator/assignment-kernel-v2-contracts";
import { GeneralRevitExportIsolation } from "../src/benchmark/general_revit_export_isolation.js";
import { finishGeneralRevitCampaignCase, generalRevitCampaignCompletion, retainedGeneralRevitCampaignStop } from "../src/benchmark/general_revit_campaign_completion.js";
import { markdownReport } from "../src/benchmark/general_revit_capability_report.js";
import { createProviderUsageLedgerV1 } from "@revitoperator/assignment-kernel-v2-contracts/provider-turn-usage";
import { assertGeneralRevitCaseMeasurement, finishGeneralRevitCampaignExports, initializeGeneralRevitCampaignExports } from "../src/benchmark/general_revit_campaign_completion.js";

function trace(unknown: string[]) {
  return { case_id: "b03_create_view", context_supplied: { session_id: "session" },
    tool_results: { durable_assignment_kernel_v2: { assignments: [{ snapshot: {
      schema: ASSIGNMENT_SNAPSHOT_V2_SCHEMA, quiescent: true, terminal: true,
      current_binding: { session_id: "session" }, in_flight_operation_ids: [],
      in_flight_provider_call_ids: [], unresolved_unknown_operation_ids: unknown
    } }] } }, model_call_receipts: [{ call_id: "retained-provider-call", tokens: { input_tokens: 364881 } }] };
}

test("stopped committed-view case retains evidence, reports missing cases, and cannot advance export isolation", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-campaign-stop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), retained = path.join(root, "retained");
  const prints = path.join(workspace, "artifacts", "prints");
  fs.mkdirSync(prints, { recursive: true });
  fs.writeFileSync(path.join(prints, "original.pdf"), "original");
  const isolation = new GeneralRevitExportIsolation(workspace, retained);
  isolation.begin("b03_create_view");
  fs.writeFileSync(path.join(prints, "evidence.pdf"), "unverified");
  const recorded = trace(["committed-view-receipt-unrecognized"]);
  const stop = finishGeneralRevitCampaignCase(recorded, isolation);
  const completion = generalRevitCampaignCompletion(["b03_create_view", "b04_duplicate_view"], [recorded], stop);
  assert.equal(completion.complete, false);
  assert.deepEqual(completion.unrecorded_case_ids, ["b04_duplicate_view"]);
  assert.match(stop!.reason, /requires_exact_settled/);
  assert.equal(recorded.model_call_receipts[0]!.tokens.input_tokens, 364881);
  assert.throws(() => isolation.begin("b04_duplicate_view"), /identity_invalid/);
  assert.throws(() => isolation.restore(), /requires_recovery/);
  assert.equal(fs.readFileSync(path.join(prints, "evidence.pdf"), "utf8"), "unverified");
  assert.equal(fs.readFileSync(path.join(retained, "originals", "prints", "original.pdf"), "utf8"), "original");
  const markdown = markdownReport({ campaign_completion: completion, task_traces: [recorded] });
  assert.match(markdown, /Incomplete campaign/);
  assert.match(markdown, /not a campaign grade/);
  assert.match(markdown, /b04_duplicate_view/);
});

test("even the last selected case with an unknown effect stays incomplete; settled exact cases can finish", () => {
  const unresolved = trace(["op"]);
  const stop = finishGeneralRevitCampaignCase(unresolved, null);
  assert.equal(generalRevitCampaignCompletion([unresolved.case_id], [unresolved], stop).complete, false);
  const settled = trace([]);
  assert.equal(finishGeneralRevitCampaignCase(settled, null), null);
  assert.equal(generalRevitCampaignCompletion([settled.case_id], [settled], null).complete, true);
  assert.equal(generalRevitCampaignCompletion([settled.case_id], [], null).complete, false);
  assert.equal(generalRevitCampaignCompletion([settled.case_id], [settled, settled], null).complete, false);
  assert.equal(generalRevitCampaignCompletion([], [], null).complete, false);
});

test("historical stopped checkpoints cannot acquire completion through evidence-only rescoring", () => {
  const recorded = { ...trace(["op"]), export_isolation_error: "benchmark_case_requires_exact_settled_assignment_without_unknown_effects:b03_create_view" };
  const checkpoint = { task_traces: [recorded], suite_context: {} };
  const stop = retainedGeneralRevitCampaignStop(checkpoint);
  assert.equal(stop!.case_id, recorded.case_id);
  assert.equal(generalRevitCampaignCompletion([recorded.case_id], [recorded], stop).complete, false);
  assert.deepEqual(retainedGeneralRevitCampaignStop({ ...checkpoint, suite_context: { campaign_stop: stop } }), stop);
  assert.equal(retainedGeneralRevitCampaignStop(null), null);
});

const requested = { agent_model: "gpt-5.6-sol", agent_reasoning_effort: "medium" };
test("initialization failure retains its recovery reason and never opens a benchmark case", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-init-stop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const retained = path.join(root, "existing");
  fs.mkdirSync(retained);
  fs.writeFileSync(path.join(retained, "keep.txt"), "retained evidence");
  const state = initializeGeneralRevitCampaignExports(() => new GeneralRevitExportIsolation(root, retained));
  assert.equal(state.isolation, null);
  assert.ok(state.stop);
  const completion = generalRevitCampaignCompletion(["b03_create_view"], [], state.stop);
  assert.equal(completion.complete, false);
  assert.match(markdownReport({ campaign_completion: completion, task_traces: [] }), /Incomplete campaign/);
  assert.equal(fs.readFileSync(path.join(retained, "keep.txt"), "utf8"), "retained evidence");
});
function measuredTrace(noInvocation = false) {
  const receipts = noInvocation ? [] : [{ schema: "revit-operator.model-call-receipt.v1", call_id: "resp-1",
    turn_id: "turn", provider: "openai", route: "codex_agent", model: "gpt-5.6-sol", reasoning_effort: "medium",
    success: false, tokens: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 0,
      output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 120 } }];
  const ledger = createProviderUsageLedgerV1();
  ledger.begin("session", "message");
  ledger.observe("session", "message", { provider_turn_usage: {
    schema: "revit-operator.provider-turn-usage/v1", session_id: "session", message_id: "message",
    thread_id: noInvocation ? null : "thread", turn_id: noInvocation ? null : "turn",
    disposition: noInvocation ? "not_started" : "failed", raw_response_ids: noInvocation ? [] : ["resp-1"]
  } });
  return { ...trace([]), model_call_receipts: receipts, provider_usage_turns: [ledger.snapshot(receipts)] };
}

test("settled task failures are measurable, but lost receipts and model drift stop before the next case", () => {
  const valid = measuredTrace();
  assert.doesNotThrow(() => assertGeneralRevitCaseMeasurement(valid, requested));
  assert.doesNotThrow(() => assertGeneralRevitCaseMeasurement(measuredTrace(true), requested));
  const missing = { ...valid, provider_usage_turns: [] };
  let archived = false;
  const stop = finishGeneralRevitCampaignCase(missing, { finish: () => { archived = true; } } as never, requested);
  assert.match(stop!.reason, /provider_coverage_incomplete/);
  assert.equal(archived, false);
  assert.equal(generalRevitCampaignCompletion([valid.case_id, "b04_duplicate_view"], [missing], stop).complete, false);
  const drift = structuredClone(valid);
  drift.model_call_receipts[0]!.model = "gpt-5.6-luna";
  assert.throws(() => assertGeneralRevitCaseMeasurement(drift, requested), /configuration_mismatch/);
  const incompleteCost = structuredClone(valid);
  delete (incompleteCost.model_call_receipts[0]!.tokens as Record<string, unknown>).cached_input_tokens;
  assert.throws(() => assertGeneralRevitCaseMeasurement(incompleteCost, requested), /cost_incomplete/);
  assert.equal(valid.model_call_receipts[0]!.tokens.total_tokens, 120);
});

test("final export restore failure persists to a reloadable checkpoint and incomplete report", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-final-checkpoint-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkpointPath = path.join(root, "checkpoint.json");
  const context = { export_isolation: {} };
  const recorded = measuredTrace();
  const persist = () => fs.writeFileSync(checkpointPath, JSON.stringify({ suite_context: context, task_traces: [recorded] }));
  const stop = finishGeneralRevitCampaignExports({ restore: () => { throw new Error("export_isolation_originals_changed"); } }, null, context, persist);
  const restored = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  assert.deepEqual(retainedGeneralRevitCampaignStop(restored), stop);
  assert.equal(restored.suite_context.export_isolation.originals_restored, undefined);
  const completion = generalRevitCampaignCompletion([recorded.case_id], [recorded], retainedGeneralRevitCampaignStop(restored));
  assert.equal(completion.complete, false);
  assert.match(markdownReport({ campaign_completion: completion, task_traces: [recorded] }), /Incomplete campaign/);
  let restoreCalls = 0;
  finishGeneralRevitCampaignExports({ restore: () => { restoreCalls++; } }, stop, context, persist);
  assert.equal(restoreCalls, 0);
  finishGeneralRevitCampaignExports({ restore: () => { restoreCalls++; } }, null, context, persist);
  const success = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  assert.equal(success.suite_context.export_isolation.originals_restored, true);
  assert.equal(success.suite_context.campaign_stop, null);
});
