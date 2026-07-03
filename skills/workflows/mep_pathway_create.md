# Skill: Create MEP Pathway Routes

## Goal
Create deterministic duct or pipe route geometry from explicit model points or mapped redline/view-frame points, including conservative size/elevation fallbacks and connector verification.

## Use when
- The user asks to draw, create, route, or sketch ductwork or piping.
- The user asks to edit explicit duct/pipe curve ids for size or simple elevation changes.
- A redline, screenshot, active-view mark, or explicit start/end location describes one or more pathway segments.
- The task is a single segment, a continuous multi-segment route, or an initial branch feasibility check.

## Do not use when
- The user asks only to resize existing ductwork or pipework; use the MEP resize workflows.
- The request needs a full engineered layout with branch sizing, equipment selection, or code/load calculation before any segment can be drawn.
- No view/model anchor exists for a graphical request; first resolve a sheet/view/frame anchor.

## Required inputs
- Pathway kind: duct or pipe.
- Ordered route points, either as model XYZ feet or frame-linked points from `export-view-frame`.
- Level, room, system type, pathway type, and size when known.
- Whether this is preview/dry-run or apply.

## Execution steps
1. For redlines or screenshots, resolve sheet/view context, then run `export-view-frame` with mapping and convert the marked line endpoints to frame pixels.
2. Prefer `/revit/mep-route-workflow` for route creation. It executes resolve context, dry-run, optional apply, and focused post-change visual capture in that fixed order.
3. Use `apply:false` first when the request is still uncertain; use `apply:true` with `visualVerify:true` once the dry-run is bounded.
4. A single line is just two ordered points; a path with bends is an ordered point list.
5. Inspect planned points, selected level/system/type, chosen size, chosen elevation, segment count, total length, connection attempts, visualVerification, and warnings.
6. If size is missing, prefer `sizePolicy:"use_default_with_warning"` for bounded drafts. The tool uses 8x8 duct or 1 inch pipe and reports the assumption. Use `explicit_required` only when applying without a placeholder would be unsafe.
6a. For multi-section duct or pipe runs with size changes, pass `segmentSizes` with one size per segment. Dry-run reports `jointPlan`; adjacent segments with different normalized sizes should show `expectedFitting:"transition"`.
7. If elevation is missing, prefer `elevationPolicy:"resolve_context_default"` and report the returned assumption. Do not pretend the elevation is known.
8. Claim visual completion only after reviewing `visualVerification.capture.path` from an apply workflow or a follow-up `/revit/highlight-and-export` capture.
9. For editing explicit existing duct/pipe curve ids, use `/revit/edit-mep-route-elements` with `dryRun:true` first. Supported first cases are size edits and simple level straight elevation moves. Elevation moves on connected elements are blocked by default; only set `allowConnectedElevationMove:true` when the affected connected run has been deliberately planned. For changing size part way down one straight duct/pipe, use `/revit/reroute-mep-route-segment` size-transition mode with `transitionChainageFt` or `transitionNormalized` plus explicit upstream/downstream sizes; apply must create a transition fitting and pass connector/network verification. For offsetting a middle section of one straight duct/pipe, use `/revit/reroute-mep-route-segment` offset mode; use `offsetMode:"dogleg45"` when the redline expects diagonal 45-degree offset legs instead of perpendicular legs. Connected endpoints are blocked by default; only add `preserveConnectedEndpoints:true` after dry-run returns a concrete `endpointReconnectionPlan`, then require endpoint reconnection attempts, connector/network audit, and focused capture evidence on apply.
10. For branch/tee/tap requests, run `/revit/connect-mep-branch` with `dryRun:true` first. Apply is available when the branch starts at an existing open main connector, for projected non-connector split-tee cases on straight duct/pipe mains, for straight duct tap/takeoff when Revit creates the expected takeoff, and for pipe tap/takeoff only when dry-run reports an explicit tap/takeoff routing preference.

## Success criteria
- Dry-run and apply return the intended pathway kind, size, level, ordered points, segment count, and created element ids.
- Applied route workflows return `visualVerification.status:"CaptureReadyForAIReview"` and a capture path that was inspected.
- The final response names any defaults used for size, elevation, system, type, or level.
- Connector verification is reported honestly; open endpoints or failed internal connections are not called fully connected.
- Verification evidence exists before claiming a graphical redline task is complete.

## Failure handling
- If type/system matching falls back to a default, report that and ask for confirmation before applying in production models.
- If frame mapping is missing or ambiguous, export a fresh view frame or request one explicit point pick rather than guessing.
- If size cannot be applied, stop after dry-run and report the missing parameter/type issue unless the user explicitly approves a placeholder.
- If connectors remain open after apply, report `CreatedWithOpenConnectors` and use connector/network tools for the next correction step.
- If a requested route edit is really a reroute-by-offset or part-way size transition, do not fake it with a generic move or whole-element resize. Report that first-class reroute must split, reconnect with required fittings, and audit the connected network.
- If a branch requires a pipe tap-specific fitting away from an existing open connector and dry-run does not report explicit tap/takeoff routing support, report the guarded block and use split tee or a pipe type with an explicit tap/takeoff preference.

## Examples
- "Draw a 10x12 supply duct from this redline mark to that diffuser."
- "Create a 2 inch domestic cold water pipe along this marked line in the active view."
- "Route this duct through the three redline points and use a placeholder size if I did not mark it."
- "Dry-run whether this branch can tap into the main duct here."
