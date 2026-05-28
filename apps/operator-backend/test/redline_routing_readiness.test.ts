import assert from "node:assert/strict";
import test from "node:test";
import { runRedlineRoutingReadiness } from "../src/benchmark/redline_routing_readiness.js";

test("redline routing readiness covers filename-neutral clipboard and circuit-room inference", async () => {
  const result = await runRedlineRoutingReadiness();
  const byName = new Map(result.cases.map((row) => [row.name, row]));
  const requiredCases = [
    "filename_neutral_clipboard_ocr_room_adjacent_circuit",
    "screenshot_mark_requires_view_alignment_for_coordinates",
    "pathless_analyze_mark_side_room_wall_targeting",
    "pathless_analyze_adjacent_circuit_create_similar",
    "pathless_analyze_adjacent_circuit_create_similar_matrix",
    "pathless_analyze_adjacent_circuit_preview_applies",
    "pathless_analyze_adjacent_circuit_post_apply_verification",
    "visible_inventory_panel_circuit_room_inference",
    "adjacent_circuit_visible_inventory_room_inference",
    "ocr_only_circuit_ignored_for_same_circuit",
    "marked_adjacent_device_beats_noisy_summary",
    "generic_visible_unit_label_beats_noisy_summary",
    "generic_visible_circuit_label_beats_noisy_summary",
    "adjacent_device_evidence_beats_noisy_summary_without_explicit_circuit",
    "alternate_visible_inventory_schema_room_inference",
    "snake_case_visible_inventory_schema_room_inference",
    "visible_room_label_room_inference",
    "visible_space_element_room_inference",
    "visible_space_containment_generic_panel_room_inference",
    "bbox_only_space_containment_room_inference",
    "same_adjacent_circuit_room_side_matrix",
    "visible_space_element_create_similar_preview",
    "compacted_adjacent_inventory_room_inference",
    "prioritized_compacted_inventory_room_inference",
    "compacted_inventory_summary_room_inference",
    "rich_inventory_adjacent_room_inference",
    "sheet_placed_view_adjacent_room_inference",
    "sheet_placed_view_same_adjacent_circuit_matrix",
    "generic_visible_circuit_label_full_preview",
    "generic_visible_circuit_label_no_pick_full_preview",
    "visible_unit_label_no_pick_adjacent_circuit_full_preview",
    "generic_unit_label_no_pick_unlabeled_device_full_preview",
    "split_unit_label_no_pick_active_sheet_full_preview",
    "generic_unit_label_no_pick_unlabeled_device_completion",
    "generic_unit_label_no_pick_room_contents_failure_recovery",
    "visible_unit_label_no_pick_adjacent_circuit_full_preview_matrix",
    "generic_visible_circuit_label_no_pick_full_preview_matrix",
    "visible_unit_label_no_pick_generic_source_completion",
    "room_wall_exemplar_fallback_after_room_contents_failure",
    "nearest_same_circuit_exemplar_selection",
    "ranked_adjacent_side_preserved_to_placement",
    "raw_image_mark_does_not_become_link_host_point_xyz",
    "same_circuit_requires_source_readback",
    "same_circuit_ranked_source_no_echo_completion",
    "same_circuit_mismatch_routes_to_assignment"
  ];

  assert.equal(result.ok, true);
  assert.equal(result.cases.every((row) => row.ok), true);
  for (const name of requiredCases) {
    assert.ok(byName.has(name), `missing required redline readiness case: ${name}`);
  }
  const matrix = byName.get("same_adjacent_circuit_room_side_matrix");
  assert.match(matrix?.actual ?? "", /403\/bottom:\/revit\/rooms:403/);
  assert.match(matrix?.actual ?? "", /405\/left:\/revit\/rooms:405/);
  assert.match(matrix?.actual ?? "", /407\/right:\/revit\/rooms:407/);
  const sheetMatrix = byName.get("sheet_placed_view_same_adjacent_circuit_matrix");
  assert.match(sheetMatrix?.actual ?? "", /403\/bottom:\/revit\/rooms:403:1363337/);
  assert.match(sheetMatrix?.actual ?? "", /405\/left:\/revit\/rooms:405:1363337/);
  assert.match(sheetMatrix?.actual ?? "", /407\/right:\/revit\/rooms:407:1363337/);
  const rankedPlacementMatrix = byName.get("ranked_adjacent_side_preserved_to_placement");
  assert.match(rankedPlacementMatrix?.actual ?? "", /403\/bottom:\/revit\/computer-use-guard, \/revit\/create-similar-from-instance:bottom/);
  assert.match(rankedPlacementMatrix?.actual ?? "", /405\/left:\/revit\/computer-use-guard, \/revit\/create-similar-from-instance:left/);
  assert.match(rankedPlacementMatrix?.actual ?? "", /407\/right:\/revit\/computer-use-guard, \/revit\/create-similar-from-instance:right/);
  const pathlessMatrix = byName.get("pathless_analyze_adjacent_circuit_create_similar_matrix");
  assert.match(pathlessMatrix?.actual ?? "", /403\/bottom:\/revit\/computer-use-observe/);
  assert.match(pathlessMatrix?.actual ?? "", /405\/left:\/revit\/computer-use-observe/);
  assert.match(pathlessMatrix?.actual ?? "", /407\/right:\/revit\/computer-use-observe/);
  const pathlessApply = byName.get("pathless_analyze_adjacent_circuit_preview_applies");
  assert.match(pathlessApply?.actual ?? "", /\/revit\/create-similar-from-instance/);
  assert.doesNotMatch(pathlessApply?.assistant_message ?? "", /no_pick_hints|did not recover usable pick locations|stopped before guessing/i);
  const pathlessVerify = byName.get("pathless_analyze_adjacent_circuit_post_apply_verification");
  assert.match(pathlessVerify?.actual ?? "", /afterApply=\/revit\/export-view-region; afterCapture=\/revit\/audit-hosted-instance-placement; afterAudit=\/revit\/get-parameters/);
  const noPickCircuitMatrix = byName.get("generic_visible_circuit_label_no_pick_full_preview_matrix");
  assert.match(noPickCircuitMatrix?.actual ?? "", /403\/bottom:\/revit\/computer-use-guard, \/revit\/create-similar-from-instance:403:bottom:(?!2(?:\.0)?(?:;|$))/);
  assert.match(noPickCircuitMatrix?.actual ?? "", /405\/left:\/revit\/computer-use-guard, \/revit\/create-similar-from-instance:405:left:(?!2(?:\.0)?(?:;|$))/);
  assert.match(noPickCircuitMatrix?.actual ?? "", /407\/right:\/revit\/computer-use-guard, \/revit\/create-similar-from-instance:407:right:(?!2(?:\.0)?(?:;|$))/);
  const noPickUnitMatrix = byName.get("visible_unit_label_no_pick_adjacent_circuit_full_preview_matrix");
  assert.match(noPickUnitMatrix?.actual ?? "", /403\/bottom\/L4PA\/7:\/revit\/computer-use-guard, \/revit\/create-similar-from-instance:403:bottom:(?!2(?:\.0)?(?:;|$))/);
  assert.match(noPickUnitMatrix?.actual ?? "", /405\/left\/P405\/1:\/revit\/computer-use-guard, \/revit\/create-similar-from-instance:405:left:(?!2(?:\.0)?(?:;|$))/);
  assert.match(noPickUnitMatrix?.actual ?? "", /407\/right\/L4PB\/22:\/revit\/computer-use-guard, \/revit\/create-similar-from-instance:407:right:(?!2(?:\.0)?(?:;|$))/);
  const genericUnitUnlabeledDevice = byName.get("generic_unit_label_no_pick_unlabeled_device_full_preview");
  assert.match(genericUnitUnlabeledDevice?.actual ?? "", /\/revit\/computer-use-guard, \/revit\/create-similar-from-instance/);
  assert.doesNotMatch(genericUnitUnlabeledDevice?.assistant_message ?? "", /no_pick_hints|did not recover usable pick locations/i);
  const splitUnitLabel = byName.get("split_unit_label_no_pick_active_sheet_full_preview");
  assert.match(splitUnitLabel?.actual ?? "", /\/revit\/computer-use-guard, \/revit\/create-similar-from-instance/);
  assert.doesNotMatch(splitUnitLabel?.assistant_message ?? "", /no_pick_hints|did not recover usable pick locations/i);
  const genericUnitUnlabeledDeviceCompletion = byName.get("generic_unit_label_no_pick_unlabeled_device_completion");
  assert.equal(genericUnitUnlabeledDeviceCompletion?.actual, "no actions");
  assert.match(genericUnitUnlabeledDeviceCompletion?.assistant_message ?? "", /1735905=L4PA\/7/);
  const genericUnitRoomContentsFallback = byName.get("generic_unit_label_no_pick_room_contents_failure_recovery");
  assert.match(genericUnitRoomContentsFallback?.actual ?? "", /\/revit\/rank-similar-devices-on-wall/);
  assert.doesNotMatch(genericUnitRoomContentsFallback?.assistant_message ?? "", /no_pick_hints|did not recover usable pick locations/i);
  const noEchoCompletion = byName.get("same_circuit_ranked_source_no_echo_completion");
  assert.equal(noEchoCompletion?.actual, "no actions");
  assert.match(noEchoCompletion?.assistant_message ?? "", /Placed and verified receptacle 1735601/);
  const unitGenericCompletion = byName.get("visible_unit_label_no_pick_generic_source_completion");
  assert.equal(unitGenericCompletion?.actual, "no actions");
  assert.match(unitGenericCompletion?.assistant_message ?? "", /1735901=L4PA\/7/);
});
