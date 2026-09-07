import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSIGNMENT_SNAPSHOT_V2_SCHEMA } from "@revitoperator/assignment-kernel-v2-contracts";
import { GeneralRevitExportIsolation } from "../src/benchmark/general_revit_export_isolation.js";
import { finishGeneralRevitCampaignCase, generalRevitCampaignCompletion, retainedGeneralRevitCampaignStop } from "../src/benchmark/general_revit_campaign_completion.js";
import { markdownReport } from "../src/benchmark/general_revit_capability_report.js";

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
