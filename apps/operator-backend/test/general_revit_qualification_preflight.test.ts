import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  assertGeneralRevitQualificationRuntime,
  assertGeneralRevitQualificationWriteGrant,
  generalRevitQualificationWriteGrantRequirement
} from "../src/benchmark/general_revit_qualification_preflight.js";
import { assignmentKernelRuntimeAttestationV2 } from "@revitoperator/assignment-kernel-v2-contracts";

function backendHealth(enabled: boolean): Record<string, unknown> {
  return {
    ok: true,
    backend: {
      status: "ok",
      assignment_kernel_runtime: assignmentKernelRuntimeAttestationV2(enabled)
    }
  };
}

test("V2 qualification admits only the exact shared live-runtime attestation", () => {
  assert.deepEqual(assertGeneralRevitQualificationRuntime({
    required_assignment_kernel_v2: true,
    backend_health: backendHealth(true)
  }), assignmentKernelRuntimeAttestationV2(true));
  assert.throws(() => assertGeneralRevitQualificationRuntime({
    required_assignment_kernel_v2: true,
    backend_health: backendHealth(false)
  }), /runtime preflight failed before fixture, Assignment, provider, or Revit work.*disabled/i);
});

test("missing, malformed, or internally contradictory runtime claims fail before live work", () => {
  const enabled = assignmentKernelRuntimeAttestationV2(true);
  for (const value of [
    {},
    { ok: false, backend: { status: "ok", assignment_kernel_runtime: enabled } },
    { ok: true, backend: { status: "unavailable", assignment_kernel_runtime: enabled } },
    { ok: true, backend: { status: "ok" } },
    { ok: true, backend: { status: "ok", assignment_kernel_runtime: { ...enabled, progress_owner: "legacy_agent_loop_v1" } } }
  ]) {
    assert.throws(() => assertGeneralRevitQualificationRuntime({
      required_assignment_kernel_v2: true,
      backend_health: value
    }), /runtime preflight failed before fixture, Assignment, provider, or Revit work/i);
  }
});

test("historical non-V2 qualification remains isolated from the new runtime requirement", () => {
  assert.equal(assertGeneralRevitQualificationRuntime({
    required_assignment_kernel_v2: false,
    backend_health: {}
  }), null);
});

test("read-only qualification does not require a write grant", () => {
  const requirement = generalRevitQualificationWriteGrantRequirement([
    { case_id: "q01_air_device_inventory", expected_effect: "read" }
  ], false);

  assert.deepEqual(requirement, { required: false, case_ids: [] });
  assert.doesNotThrow(() => assertGeneralRevitQualificationWriteGrant({
    cases: [{ case_id: "q01_air_device_inventory", expected_effect: "read" }],
    apply_requested: false,
    grant: { active: false, write_ready: false }
  }));
});

test("preview qualification fails before work when the write grant is inactive", () => {
  const cases = [{ case_id: "r01_text_note_edit", expected_effect: "preview" }];

  assert.deepEqual(generalRevitQualificationWriteGrantRequirement(cases, false), {
    required: true,
    case_ids: ["r01_text_note_edit"]
  });
  assert.throws(() => assertGeneralRevitQualificationWriteGrant({
    cases,
    apply_requested: false,
    grant: { active: false, write_ready: false, error: "Write grant expired." }
  }), /write grant preflight failed.*r01_text_note_edit.*before fixture, Assignment, provider, or Revit work/i);
});

test("explicit apply mode requires a write grant even for a read-shaped source case", () => {
  assert.throws(() => assertGeneralRevitQualificationWriteGrant({
    cases: [{ case_id: "transformed_direct_variant", expected_effect: "read" }],
    apply_requested: true,
    grant: { active: false, write_ready: false }
  }), /write grant preflight failed/i);
});

test("active and write-ready grant admits preview qualification", () => {
  assert.doesNotThrow(() => assertGeneralRevitQualificationWriteGrant({
    cases: [{ case_id: "r01_text_note_edit", expected_effect: "preview" }],
    apply_requested: false,
    grant: { active: true, write_ready: true, mode: "session" }
  }));
});

test("partial or malformed grant state fails closed", () => {
  const cases = [{ case_id: "r01_text_note_edit", expected_effect: "preview" }];
  for (const grant of [{ active: true }, { write_ready: true }, {}, null]) {
    assert.throws(() => assertGeneralRevitQualificationWriteGrant({
      cases,
      apply_requested: false,
      grant
    }), /write grant preflight failed/i);
  }
});

test("the live capability runner invokes the shared preflight before fixture readiness", () => {
  const source = fs.readFileSync("src/tools/general_revit_capability_acceptance.ts", "utf8");
  const runtimePreflight = source.indexOf("assertGeneralRevitQualificationRuntime({");
  const preflight = source.indexOf("assertGeneralRevitQualificationWriteGrant({");
  const fixtureReadiness = source.indexOf("let fixturePreflight: JsonRecord = {};");
  assert.ok(runtimePreflight >= 0, "runner must invoke shared runtime preflight");
  assert.ok(preflight >= 0, "runner must invoke shared write-grant preflight");
  assert.ok(fixtureReadiness > runtimePreflight, "runtime preflight must precede fixture and live task work");
  assert.ok(fixtureReadiness > preflight, "write-grant preflight must precede fixture and live task work");
});
