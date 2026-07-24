import test from "node:test";
import assert from "node:assert/strict";
import { buildRedlineActionUnits } from "../src/redline/redline_action_units.js";
import type { RedlineAnalyzeResponse } from "../src/redline/redline_analyzer.js";

function analysis(overrides: Pick<RedlineAnalyzeResponse, "mark_regions" | "annotation_groups">): RedlineAnalyzeResponse {
  return {
    ok: true,
    file_path: "redlines/mixed.pdf",
    full_path: "C:/workspace/redlines/mixed.pdf",
    kind: "pdf",
    bytes: 100,
    likely_sheet: true,
    primary_sheet_number: "M101",
    sheet_candidates: [],
    orientation_hints: [],
    suggested_revit_calls: [],
    ...overrides
  };
}

test("action units keep unrelated schedule and model edits separate", () => {
  const units = buildRedlineActionUnits(analysis({
    mark_regions: [
      { index: 1, source: "pdf_annotation", x: 10, y: 10, w: 20, h: 10, area: 200, annotation_page: 1, annotation_index: 11, annotation_contents: "Change AHU-1 supply air from 10,000 to 20,000 in the schedule" },
      { index: 2, source: "pdf_annotation", x: 500, y: 500, w: 20, h: 10, area: 200, annotation_page: 1, annotation_index: 12, annotation_contents: "Delete this duct" }
    ],
    annotation_groups: []
  }));

  assert.equal(units.length, 2);
  assert.deepEqual(units.map((unit) => unit.classification.operation_class), ["text_edit", "delete"]);
  assert.deepEqual(units.map((unit) => unit.classification.target_class), ["schedule", "duct"]);
  assert.ok(units.every((unit) => unit.mutability === "revit_write"));
});

test("explicitly related strikeout and replacement remain one action unit", () => {
  const units = buildRedlineActionUnits(analysis({
    mark_regions: [
      { index: 1, source: "pdf_annotation", x: 10, y: 10, w: 20, h: 10, area: 200, annotation_page: 1, annotation_index: 21, annotation_contents: "Change schedule value", annotation_related_indices: [22], related_group: 7 },
      { index: 2, source: "pdf_annotation", x: 35, y: 10, w: 20, h: 10, area: 200, annotation_page: 1, annotation_index: 22, annotation_contents: "from 10,000 CFM to 20,000 CFM", annotation_related_indices: [21], related_group: 7 }
    ],
    annotation_groups: [{ group_index: 1, region_indices: [1, 2], reason: "related PDF annotations" }]
  }));

  assert.equal(units.length, 1);
  assert.equal(units[0]?.grouping_basis, "explicit_relation");
  assert.equal(units[0]?.classification.operation_class, "text_edit");
  assert.equal(units[0]?.manual_review_reason, undefined);
});

test("proximity alone does not hide multiple operation intents", () => {
  const units = buildRedlineActionUnits(analysis({
    mark_regions: [
      { index: 1, source: "pdf_annotation", x: 10, y: 10, w: 20, h: 10, area: 200, annotation_page: 1, annotation_index: 31, annotation_contents: "Delete this duct", related_group: 1 },
      { index: 2, source: "pdf_annotation", x: 35, y: 10, w: 20, h: 10, area: 200, annotation_page: 1, annotation_index: 32, annotation_contents: "Move the equipment tag", related_group: 1 }
    ],
    annotation_groups: [{ group_index: 1, region_indices: [1, 2], reason: "nearby_annotation_marks" }]
  }));

  assert.equal(units.length, 1);
  assert.equal(units[0]?.grouping_basis, "proximity");
  assert.deepEqual(units[0]?.candidate_operations.sort(), ["delete", "move"]);
  assert.equal(units[0]?.manual_review_reason, "multiple_operation_intents_in_proximity_group");
});
