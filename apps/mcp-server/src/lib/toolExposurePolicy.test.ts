import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  evaluateToolExposure,
  filterRegistryEntriesForSearch,
  getToolExposureRuntimeDecision,
  isKnownToolExposureRoute,
  loadToolExposurePolicy,
  ToolExposurePolicyError
} from "./toolExposurePolicy.js";

const sourcePolicyPath = process.env.OPERATOR_TEST_TOOL_EXPOSURE_POLICY_PATH
  ? path.resolve(process.env.OPERATOR_TEST_TOOL_EXPOSURE_POLICY_PATH)
  : path.resolve(process.cwd(), "../operator-backend/config/tool_exposure_policy.v1.json");

function certifiedEnv(policyPath = sourcePolicyPath): NodeJS.ProcessEnv {
  return {
    REVIT_OPERATOR_MODE: "hosted",
    OPERATOR_TOOL_EXPOSURE_POLICY_PATH: policyPath
  };
}

test("runtime modes default hosted/production/development closed and expose only an explicit development laboratory escape", () => {
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "hosted" }).mode, "certified");
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "production", OPERATOR_TOOL_EXPOSURE_MODE: "laboratory" }).mode, "certified");
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "development" }).mode, "certified");
  const developmentLab = getToolExposureRuntimeDecision({
    REVIT_OPERATOR_MODE: "development",
    OPERATOR_TOOL_EXPOSURE_MODE: "laboratory"
  });
  assert.equal(developmentLab.mode, "laboratory");
  assert.equal(developmentLab.explicitLaboratory, true);
  assert.match(developmentLab.reason, /explicit development laboratory escape/i);
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "local" }).mode, "laboratory");
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "self_hosted", OPERATOR_TOOL_EXPOSURE_MODE: "certified" }).mode, "certified");
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "future" }).mode, "certified");
});

test("current policy validates all record hashes and denies all 96 exact channel decisions", () => {
  const { policy, policyPath } = loadToolExposurePolicy(certifiedEnv());
  assert.equal(policyPath, sourcePolicyPath);
  assert.equal(policy.records.length * 4, 96);
  const decisions = policy.records.flatMap(record => Object.values(record.channels));
  assert.equal(decisions.length, 96);
  assert.equal(decisions.every(decision => decision.exposed === false), true);
});

test("exact body-aware policy decisions distinguish known uncertified, request mismatch, effect mismatch, and workflow-only raw access", () => {
  const env = certifiedEnv();
  const schedules = evaluateToolExposure({
    method: "POST",
    path: "/revit/schedules",
    body: { action: "list", max: 10, query: "" },
    channel: "typed_mcp",
    env
  });
  assert.equal(schedules.knownRoute, true);
  assert.equal(schedules.allowed, false);
  assert.match(schedules.reasonCodes.join(","), /CERT_EVIDENCE_GAP/);

  const bodyMismatch = evaluateToolExposure({
    method: "POST",
    path: "/revit/schedules",
    body: { action: "list", max: 11, query: "" },
    channel: "typed_mcp",
    env
  });
  assert.deepEqual(bodyMismatch.reasonCodes, ["CERT_REQUEST_HASH_MISMATCH"]);

  const effectMismatch = evaluateToolExposure({
    method: "POST",
    path: "/revit/update-schedule-cell",
    body: { apply: false, dryRun: true, rowKey: "$fixture.row_key", targetField: "$fixture.target_field", value: "$fixture.value" },
    channel: "deterministic_workflow",
    env
  });
  assert.deepEqual(effectMismatch.reasonCodes, ["CERT_EFFECT_HASH_MISMATCH"]);

  const workflowOnlyRaw = evaluateToolExposure({
    method: "POST",
    path: "/revit/update-schedule-cell",
    body: { apply: false, dryRun: true, rowKey: "$fixture.row_key", targetField: "$fixture.target_field", value: "$fixture.value" },
    channel: "generic_call",
    workflow: "schedule_cell_update_runtime",
    env
  });
  assert.equal(workflowOnlyRaw.visibility, "workflow_only");
  assert.deepEqual(workflowOnlyRaw.reasonCodes, ["CERT_WORKFLOW_ONLY"]);
});

test("certified route lookup is exact and search filtering exposes no currently uncertified route", () => {
  const env = certifiedEnv();
  assert.equal(isKnownToolExposureRoute("POST", "/revit/schedules", env), true);
  assert.equal(isKnownToolExposureRoute("POST", "/revit/schedules/", env), false);
  assert.equal(isKnownToolExposureRoute("POST", "/revit/not-certified", env), false);
  assert.deepEqual(filterRegistryEntriesForSearch([
    { method: "POST", path: "/revit/schedules" },
    { method: "POST", path: "/revit/update-schedule-cell" }
  ], env), []);
});

test("missing, malformed, and hash-mismatched certified policies fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tool-exposure-policy-"));
  for (const [name, contents, code] of [
    ["missing.json", null, "TOOL_EXPOSURE_POLICY_UNAVAILABLE"],
    ["malformed.json", "{", "TOOL_EXPOSURE_POLICY_INVALID"],
    ["mismatched.json", fs.readFileSync(sourcePolicyPath, "utf8").replace(/sha256:[0-9a-f]{64}/, `sha256:${"0".repeat(64)}`), "TOOL_EXPOSURE_POLICY_INVALID"]
  ] as const) {
    const policyPath = path.join(root, name);
    if (contents !== null) fs.writeFileSync(policyPath, contents, "utf8");
    assert.throws(
      () => loadToolExposurePolicy(certifiedEnv(policyPath)),
      (error: unknown) => error instanceof ToolExposurePolicyError && error.code === code
    );
  }
});

test("laboratory decision is explicit and does not require an arbitrary policy file", () => {
  const decision = evaluateToolExposure({
    method: "POST",
    path: "/revit/unknown-laboratory-route",
    body: { apply: true },
    channel: "generic_call",
    env: {
      REVIT_OPERATOR_MODE: "development",
      OPERATOR_TOOL_EXPOSURE_MODE: "laboratory",
      OPERATOR_TOOL_EXPOSURE_POLICY_PATH: "Z:\\missing\\policy.json"
    }
  });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.reasonCodes, ["LABORATORY_MODE_ACTIVE"]);
});
