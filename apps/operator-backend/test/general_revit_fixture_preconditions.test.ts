import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backendRoot } from "../src/benchmark/files.js";
import { loadGeneralRevitCapabilityCorpus } from "../src/benchmark/general_revit_capability_acceptance.js";
import { generalRevitFixtureForCase, loadGeneralRevitSampleFixtures } from "../src/benchmark/general_revit_sample_fixtures.js";
import { sha256File } from "../src/benchmark/protocol_v2_hash.js";
import { assertGeneralRevitFixtureBytes, summarizeGeneralRevitFixturePreconditionCoverage } from "../src/benchmark/general_revit_fixture_preconditions.js";

test("realistic Electrical cases start in the live-qualified power plan instead of the HVAC-only L4 name", () => {
  const corpus = loadGeneralRevitCapabilityCorpus(path.join(backendRoot(), "benchmark/general-agent/revit-capability-acceptance.v2.json"));
  const fixtures = loadGeneralRevitSampleFixtures(corpus.cases);
  const electrical = corpus.cases.filter(entry => generalRevitFixtureForCase(fixtures, entry.case_id) === "snowdon_electrical");
  assert.equal(electrical.length, 9);
  for (const entry of electrical) {
    assert.deepEqual(entry.fixture_precondition?.active_view, { name: "L4 - Power", view_type: "FloorPlan" }, entry.case_id);
    assert.equal(entry.fixture_precondition?.clear_selection, true, entry.case_id);
  }
});

test("per-case fixture verification detects an explicitly saved mutation and a missing frozen digest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-fixture-bytes-"));
  const fixture = path.join(root, "sample.rvt");
  fs.writeFileSync(fixture, "pristine fixture test bytes");
  const digest = sha256File(fixture);
  assert.doesNotThrow(() => assertGeneralRevitFixtureBytes(root, "sample.rvt", digest));
  assert.doesNotThrow(() => assertGeneralRevitFixtureBytes("unused", fixture, digest));
  assert.throws(() => assertGeneralRevitFixtureBytes(root, "sample.rvt", ""), /Fixture bytes changed/);
  fs.writeFileSync(fixture, "an earlier task explicitly saved an edit");
  assert.throws(() => assertGeneralRevitFixtureBytes(root, "sample.rvt", digest), /Fixture bytes changed/);
});

test("fixture precondition coverage requires a successful exact receipt for every selected precondition", () => {
  const coverage = summarizeGeneralRevitFixturePreconditionCoverage([
    { case_id: "q01_read", fixture_precondition: null },
    { case_id: "b04_active_view", fixture_precondition: { active_view: { name: "L4" } } },
    { case_id: "c03_selection", fixture_precondition: { selection: { category: "Ducts" } } }
  ], [
    { ok: true, schema: "revit-operator.general-revit-case-precondition/v1", case_id: "b04_active_view" },
    { ok: false, schema: "revit-operator.general-revit-case-precondition/v1", case_id: "c03_selection" },
    { ok: true, schema: "wrong", case_id: "c03_selection" }
  ]);

  assert.deepEqual(coverage, {
    schema: "revit-operator.general-revit-fixture-precondition-coverage.v1",
    expected_case_count: 2,
    prepared_case_count: 1,
    expected_case_ids: ["b04_active_view", "c03_selection"],
    prepared_case_ids: ["b04_active_view"],
    missing_case_ids: ["c03_selection"],
    complete: false
  });
});

test("fixture precondition coverage is complete when no selected case requires setup", () => {
  const coverage = summarizeGeneralRevitFixturePreconditionCoverage([{ case_id: "q01_read" }], []);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.expected_case_count, 0);
});
