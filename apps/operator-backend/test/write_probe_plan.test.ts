import assert from "node:assert/strict";
import test from "node:test";
import { buildWriteProbePlan, planToolProbe } from "../src/tools/plan_live_revit_write_probes.js";

function tool(path: string, risk: string, properties: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { method: "POST", path, risk, title: path, request_schema: { type: "object", properties }, ...extra };
}

test("write-probe planner distinguishes dry-run planning from committed usefulness", () => {
  const row = planToolProbe(tool("/revit/set-parameter", "high", { dryRun: { type: "boolean" }, changes: { type: "array" } }));
  assert.equal(row.strategy, "dry_run_or_preview");
  assert.equal(row.autonomous_probe_allowed, true);
  assert.equal(row.commit_acceptance_required, true);
  assert.equal(row.independent_readback_required, true);
  assert.match(row.instructions.join(" "), /Dry-run or rollback success is not write usefulness/);
});

test("write-probe planner requires exact rollback evidence for native mutation graph", () => {
  const row = planToolProbe(tool("/revit/native-api-mutation-ops", "high", { transaction: { type: "object" } }));
  assert.equal(row.strategy, "rollback_transaction");
  assert.equal(row.model_requirement, "disposable_detached");
  assert.match(row.instructions.join(" "), /transaction\.mode:'rollback'/);
});

test("write-probe planner keeps external and human actions non-autonomous", () => {
  const external = planToolProbe(tool("/revit/load-family", "high", { dryRun: { type: "boolean" } }));
  const human = planToolProbe(tool("/revit/close-doc", "high", { dryRun: { type: "boolean" } }));
  assert.equal(external.strategy, "controlled_external_fixture");
  assert.equal(external.autonomous_probe_allowed, false);
  assert.equal(external.commit_acceptance_required, true);
  assert.match(external.instructions.join(" "), /controlled fixture/);
  assert.equal(human.strategy, "human_supervised");
  assert.equal(human.autonomous_probe_allowed, false);
  assert.equal(human.commit_acceptance_required, false);
  assert.doesNotMatch(human.instructions.join(" "), /disposable detached copy/);
});

test("write-probe planner does not mistake restorable policy state for a model commit", () => {
  const row = planToolProbe(tool("/revit/native-api-policy", "high", { policy: { type: "string" } }));
  assert.equal(row.strategy, "state_restore");
  assert.equal(row.commit_acceptance_required, false);
  assert.equal(row.independent_readback_required, true);
});

test("write-probe planner selects an enumerated non-writing action when no dry-run exists", () => {
  const row = planToolProbe(tool("/revit/example", "medium", { action: { type: "string", enum: ["apply", "audit", "delete"] } }));
  assert.equal(row.strategy, "safe_read_action");
  assert.equal(row.safe_action, "audit");
  assert.equal(row.autonomous_probe_allowed, true);
});

test("write-probe planner fails closed when no safe contract is advertised", () => {
  const row = planToolProbe(tool("/revit/opaque-write", "high", { elementId: { type: "integer" } }));
  assert.equal(row.strategy, "contract_only");
  assert.equal(row.autonomous_probe_allowed, false);
});

test("write-probe plan covers each registry entry exactly once", () => {
  const plan = buildWriteProbePlan({ tools: [
    { method: "GET", path: "/revit/ping", risk: "low", title: "Ping" },
    tool("/revit/tag-elements", "medium", { dryRun: { type: "boolean" } }),
    tool("/revit/print", "high", { dryRun: { type: "boolean" } })
  ] }, "fixture");
  assert.equal(plan.tools.length, 3);
  assert.equal(plan.summary.total_tools, 3);
  assert.equal(plan.summary.non_low_tools, 2);
  assert.equal(plan.summary.non_low_autonomous_probe_allowed, 1);
  assert.equal(plan.summary.commit_acceptance_required, 2);
});

test("write-probe plan rejects duplicate method/path identities", () => {
  assert.throws(() => buildWriteProbePlan({ tools: [
    tool("/revit/tag-elements", "medium"),
    tool("/revit/tag-elements", "medium")
  ] }), /duplicate tool keys/);
});
