import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  assertGeneralRevitQualificationWriteGrant,
  generalRevitQualificationWriteGrantRequirement
} from "../src/benchmark/general_revit_qualification_preflight.js";

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
  const preflight = source.indexOf("assertGeneralRevitQualificationWriteGrant({");
  const fixtureReadiness = source.indexOf("let fixturePreflight: JsonRecord = {};");
  assert.ok(preflight >= 0, "runner must invoke shared write-grant preflight");
  assert.ok(fixtureReadiness > preflight, "write-grant preflight must precede fixture and live task work");
});
