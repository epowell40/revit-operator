# Redline Routing Readiness

Use this checklist before changing native redline receptacle placement routing.

## Backend Replay Gate

Run from `operator-backend`:

```powershell
npm run build
npm run benchmark -- redline-routing-readiness
npm test -- --test-name-pattern "redline routing readiness|filename-neutral clipboard"
```

Expected:

- `ok: true`
- `filename_neutral_clipboard_ocr_room_adjacent_circuit` passes.
- `screenshot_mark_requires_view_alignment_for_coordinates` passes.
- `pathless_analyze_mark_side_room_wall_targeting` passes.
- `pathless_analyze_adjacent_circuit_create_similar` passes.
- `pathless_analyze_adjacent_circuit_create_similar_matrix` passes.
- `pathless_analyze_adjacent_circuit_preview_applies` passes.
- `pathless_analyze_adjacent_circuit_post_apply_verification` passes.
- `visible_inventory_panel_circuit_room_inference` passes.
- `adjacent_circuit_visible_inventory_room_inference` passes.
- `adjacent_device_evidence_beats_noisy_summary_without_explicit_circuit` passes.
- `alternate_visible_inventory_schema_room_inference` passes.
- `compacted_adjacent_inventory_room_inference` passes.
- `prioritized_compacted_inventory_room_inference` passes.
- `compacted_inventory_summary_room_inference` passes.
- `visible_space_element_room_inference` passes.
- `bbox_only_space_containment_room_inference` passes.
- `same_adjacent_circuit_room_side_matrix` passes.
- `sheet_placed_view_same_adjacent_circuit_matrix` passes.
- `visible_space_element_create_similar_preview` passes.
- `visible_unit_label_no_pick_adjacent_circuit_full_preview` passes.
- `generic_unit_label_no_pick_unlabeled_device_full_preview` passes.
- `split_unit_label_no_pick_active_sheet_full_preview` passes.
- `generic_unit_label_no_pick_unlabeled_device_completion` passes.
- `generic_unit_label_no_pick_room_contents_failure_recovery` passes.
- `visible_unit_label_no_pick_adjacent_circuit_full_preview_matrix` passes.
- `visible_unit_label_no_pick_generic_source_completion` passes.
- `room_wall_exemplar_fallback_after_room_contents_failure` passes.
- `ranked_adjacent_side_preserved_to_placement` passes.
- `same_circuit_ranked_source_no_echo_completion` passes.
- The filename-neutral case emits `/revit/computer-use-guard` followed by `/revit/create-similar-from-instance`.
- The create-similar body includes:
  - `roomNumber: "405"`
  - `roomSide: "left"`
  - `exemplarElementId: 1002`
  - `matchElectricalCircuitFromSource: true`
  - `requireElectricalCircuitMatch: true`
  - a host-local chainage placement.

This gate proves the backend can route a natural-language clipboard redline without relying on a room/circuit-bearing filename.

It specifically covers two high-risk generalization cases:

- A filename-neutral clipboard upload where the room comes from OCR text (`Live/Work Loft Unit 405`), the redline side comes from image understanding, and the circuit is inferred from the adjacent exemplar.
- A screenshot mark fallback where the backend has no viewport pick hints and therefore refuses to convert raw screenshot coordinates into same-wall target XYZ until the mark has been aligned to a native Revit view frame.
- A pathless `analyze_redline` fallback where the red mark has only image dimensions and bounding boxes, no uploaded file path or viewport pick hint, and the planner must still infer the room-relative wall side.
- A pathless same-circuit adjacent-receptacle flow that continues through create-similar preview, apply, focused capture, hosted placement audit, and source/created circuit readback instead of stopping at `no_pick_hints`.
- A pathless bottom/left/right matrix across rooms 403/405/407 so the no-pick recovery is not tied to the Unit 405 screenshot geometry.
- A visible-inventory fallback where explicit panel/circuit text (`P403/1`) is enough to query room context instead of stopping at `no_pick_hints`.
- A visible-inventory fallback where the prompt only says "same circuit as adjacent receptacle"; the room is inferred from dominant/side-matched visible adjacent devices rather than filename, OCR room text, or an explicit panel/circuit.
- An adjacent-device fallback where visible receptacle panel/circuit evidence wins over noisy broad room summaries, so a summary-heavy adjacent unit cannot redirect the room before richer room/device inventory has been tried.
- Alternate visible-inventory payload shapes (`elements`, `id`, top-level `image` / `normalizedX` points, and direct `panel` / `circuitNumber` fields) hydrate the same room inference path instead of requiring one exact JSON spelling.
- A visible room-label fallback where native view inventory includes room tags/text labels (`Unit 405`) so room context can be recovered even when device elements lack associated room/space metadata.
- A generic visible-label fallback where native inventory reports the clear `Unit 405` label as a generic annotation instead of a room/space tag, including alternate text field names such as `textValue`; this must still beat noisy neighboring-room summaries.
- Generic visible room/unit labels also act as anchors for nearby unlabeled receptacle rows, so a same-circuit prompt can still infer room and wall side when the adjacent device lacks `associatedSpatial` and its circuit label does not encode the room number.
- Split generic unit labels, such as one annotation carrying `Live/Work Loft Unit` and another nearby annotation carrying `405` via a `Text String` parameter, must work from active sheet/no-pick context and continue to guarded create-similar preview.
- The generic Unit-label + unlabeled-adjacent-device path must also complete after apply/audit using generic source circuit evidence such as `L4PA/7`, not only preview placement.
- If native `/revit/room-contents` is unavailable after generic Unit-label room inference, the flow must recover through `/revit/resolve-room-wall` and `/revit/rank-similar-devices-on-wall` with a concrete target point instead of returning `no_pick_hints`.
- A generic visible circuit-label fallback where native inventory reports `P405/1` as a generic annotation near the mark, so a "same circuit as adjacent receptacle" prompt can still recover Unit 405 without requiring the user to spell out the room or circuit.
- A visible room/space-element fallback where native inventory includes `OST_Rooms` or `OST_MEPSpaces` geometry with a clear unit number, and adjacent electrical devices can be associated to that room even when device room metadata is absent.
- A bbox-only room/space fallback where native inventory has a visible space rectangle but no center anchor, so wall-adjacent devices still inherit the intended room from containment rather than noisy summary counts.
- A compact matrix across bottom/left/right wall-side variants for rooms 403/405/407, proving the generic "same circuit as adjacent receptacle" routing does not depend on Unit 405-specific coordinates or filenames.
- The same bottom/left/right matrix also runs from active sheet context and must route each case to the placed model view, not to sheet-owned elements.
- The room/space-element fallback continues through same-room exemplar ranking and create-similar preview with `matchElectricalCircuitFromSource` instead of stopping after room recovery.
- The generic visible `P405/1` fallback also continues from active sheet context through same-room exemplar ranking and create-similar preview, proving the fix is not limited to the first room lookup action.
- The same generic visible `P405/1` fallback must also continue to a guarded create-similar preview when viewport pick hints are absent, using same-room visible device/source-circuit image anchors instead of returning `no_pick_hints` or falling back to generic chainage.
- A no-pick adjacent-circuit fallback must also continue when the prompt omits room and circuit text and the visible evidence is a generic `Unit 405` label plus an adjacent same-room receptacle; it should infer the source circuit from the adjacent device instead of requiring explicit `P405/1` prompt text.
- The no-pick visible unit-label fallback is matrixed across 403/bottom, 405/left, and 407/right, including source circuits like `L4PA/7` and `L4PB/22` that do not encode the room number.
- The no-pick visible unit-label fallback must also complete after apply/audit when create-similar omits the source echo, using ranked adjacent-source circuit evidence such as `L4PA/7` plus created-device audit/readback before reporting success.
- The no-pick visible circuit-label fallback is matrixed across 403/bottom, 405/left, and 407/right so this path is not hard-coded to Unit 405.
- A room-wall fallback where `/revit/room-contents` is unavailable but `/revit/rooms`, `/revit/resolve-room-wall`, mapped view frame, and redline hint are enough to call `/revit/rank-similar-devices-on-wall` with a concrete `targetPointXyz`.
- Compacted `/revit/export-visible-elements` results preserve sampled element `associatedSpatial`, electrical `parameters` / `parameterGroups`, `electricalCircuit`, host, orientation, and image anchor data so follow-up turns can infer the same room/circuit evidence from `itemsSampled`.
- Compaction prioritizes actionable hosted/electrical items before generic walls and annotations so room/circuit evidence is not lost just because the native visible inventory returned non-device elements first.
- A dominant compacted visible-inventory room/space summary can hydrate room intent when the sampled items are generic and lack per-item room anchors.
- Ranked adjacent-device context carries wall side and source-circuit intent into the create-similar placement preview across 403/405/407-style room/side variants, even when the screenshot/global image side conflicts with the room-relative wall side, and no-pick fallback placement uses an interior non-overlap host chainage instead of a wall endpoint or exemplar duplicate.
- Same-circuit completion still succeeds when the native create-similar apply result omits the source/exemplar id, as long as ranked adjacent-device evidence supplied the source circuit and the created device audit/readback shows a matching circuit.

It does not prove:

- The live native pane authenticated/uploaded the image correctly.
- The Revit add-in placed the family instance in a real transaction.
- Native view capture, focused capture, or dialog guardian behavior worked in Revit.
- The workflow is reliable enough to call the goal complete.

Treat a passing replay gate as backend readiness only. The broader goal remains open until live native-pane testing succeeds repeatedly.

## 2026-05-24 Hosted Goal-Mode Regression Note

A hosted native-pane goal-mode run stopped with:

> I resolved a native create-similar path, but I do not yet have a measured redline-to-view target.

The safety blocker was correct, but the run should have attempted visual alignment first. Root cause: backend tool-result normalization dropped `attachments` from `/revit/export-view-frame`, so the hosted backend received the native frame path but lost the inline image bytes needed for redline-to-view alignment. A passing post-deploy goal-mode test must show that exported frame attachments survive into the augmented tool-result history before placement routing.

## Goal Completion Gate

Use this gate before marking the native redline receptacle goal complete. It is stricter than CI because it exercises the hosted/native-pane path that previously regressed after backend replay passed.

Required setup:

- Local or self-hosted backend is running from the PR branch or merged commit under test.
- Revit is open with the Operator add-in loaded and the Snowdon sample electrical model active.
- Native Operator pane is connected to the local or self-hosted backend under test.
- Active view is an electrical/power plan or a sheet containing the relevant placed power plan.

Required live cases:

- Unit 403 bottom-wall redline: `add receptacle where indicated and circuit to P403/1`
- Unit 405 left-wall redline: `add receptacle where indicated and circuit to same circuit as adjacent receptacle`
- At least one active-sheet variant where the redline is pasted/uploaded from the native pane and the filename is a neutral clipboard filename.
- At least one adjacent-room/noisy-view variant where room 407 or another neighboring unit is visible in the same screenshot.

Pass criteria for each case:

- The planner does not return `no_pick_hints`.
- The planner does not require explicit user coordinates, element ids, room number, or circuit text when those are visually/model-inferable.
- It uses native room/view/device queries before any write.
- It chooses a same-room adjacent receptacle exemplar.
- It preserves or explicitly copies the adjacent/source circuit for same-circuit prompts.
- It previews or dry-runs the hosted placement before apply.
- It applies exactly the intended new receptacle unless the prompt asks for multiple devices.
- It performs focused capture plus hosted placement audit after apply.
- It reads source and created device circuit evidence before reporting same-circuit completion.
- Final response includes created element id, room, wall/host evidence, coordinates or host-local chainage, and observed circuit.
- Created test elements are deleted or the model is closed without saving after the run.

Reliability threshold:

- Run at least 10 total live native-pane repeats across the cases above.
- At least 9/10 must satisfy all pass criteria.
- No successful run should require more than one user nudge after the initial prompt.
- UI speech/progress should stay concise: normally one acknowledgement plus one completion/blocker message. Extra progress messages are acceptable only at major phase transitions such as preview, apply, verification, or recovery from a Revit modal.
- Tool-call volume should be bounded. A valid successful run should not hit the native-pane tool-call cap; if a run exceeds 25 tool calls, inspect whether it repeated discovery after room/wall/exemplar context was already available.

Evidence to save with the final audit:

- Session id and run bundle path.
- The uploaded redline image path.
- Final Operator response.
- Tool-call summary showing room inference, wall/exemplar ranking, create-similar preview/apply, focused capture, hosted audit, and circuit readback.
- Created element id(s), cleanup status, and whether any dialog guardian/computer-use guard fired.

You can generate a first-pass run-bundle audit from the repo:

```powershell
cd operator-backend
npm run benchmark -- redline-session-audit --session-dir "C:\path\to\Workspace\runs\sessions\<session_id>"
```

The audit is intentionally stricter than "the assistant sounded confident." It fails runs that stop at `no_pick_hints`, exceed the tool-call/message budget, skip native room/wall/exemplar discovery, skip create-similar preview/apply, skip hosted placement audit, or report same-circuit completion without circuit evidence.

## CI Gate

PR CI runs the same command in the backend job after `npm run test`.

Expected:

- `Backend Build/Test/Checks` passes.
- A failure in `redline-routing-readiness` should block merge.

## Live Native-Pane Retest

The replay gate does not replace live Revit proof. For live validation:

- Open the Snowdon sample electrical model in Revit.
- Open the native Operator pane against the local or self-hosted backend under test.
- Use an active power plan/sheet with a visible unit and adjacent receptacle.
- Upload or paste a clipboard redline image whose filename does not include the room number.
- Ask: `add receptacle where indicated and circuit to same circuit as adjacent receptacle`

Expected:

- Operator uses active view/sheet capture and model queries.
- It infers room, wall side, adjacent exemplar, host wall, and source circuit.
- It previews and applies one hosted receptacle at the marked wall.
- It verifies with focused capture plus hosted placement audit.
- It does not stop with `no_pick_hints`.
- It does not ask for manual coordinates unless the room/mark/exemplar cannot be recovered.
- The final report includes created element id, room number, host wall, model coordinates, and circuit source/membership.

Run at least 10 repeats across Unit 403/405-style redlines before claiming the broader reliability goal is complete.

When using the deterministic live benchmark for repeat proof, set these fields in `local-work/demo-live-requests.json` for `demo_redline_receptacles`:

- `cleanupCreatedElements: true`
- `requireAuditItems: true`
- `roomNumber` or per-placement `roomNumber` for the intended unit.
- `matchElectricalCircuitFromSource: true` for same-circuit adjacent-exemplar tests.
- `expectedCircuitLabel` when the expected panel/circuit is known; otherwise the benchmark will require source and created circuit labels to match when `matchElectricalCircuitFromSource` is true.

Then run:

```powershell
$env:OPERATOR_BENCHMARK_USE_MOCKS="0"
$env:OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON="C:\Users\User\source\repos\RevitOperator\local-work\demo-live-requests.json"
npm run benchmark -- run --tasks demo_redline_receptacles --config deterministic_skill_only --repeat 10 --batch-id redline_receptacle_live_repeat
```

The workflow should record these checks for each repeat:

- `cleanup_completed_when_requested`
- `audit_contains_created_ids`
- `audit_host_evidence_ok`
- `created_room_matches_expected`
- `created_circuit_matches_expected` when `expectedCircuitLabel` is supplied
- `created_circuit_matches_source_when_requested` when `matchElectricalCircuitFromSource` is true

The benchmark report's `demo_redline_receptacles` readiness gate requires live runs to include these strong room, host, cleanup, and circuit checks. A live run that only reports generic success or image export evidence is not readiness evidence.

Created test receptacles should be deleted after each run so they do not bias the next repeat.

When a live run fails, capture the final Operator response, failed tool names, and whether the failure happened before routing, during placement preview, during apply, during audit, or during circuit verification. That distinction matters more than the final natural-language blocker text.
