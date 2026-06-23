# Skill: Create MEP Pathway Routes

## Goal
Create deterministic duct or pipe route geometry from explicit model points or mapped redline/view-frame points, including conservative size/elevation fallbacks and connector verification.

## Use when
- The user asks to draw, create, route, or sketch ductwork or piping.
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
7. If elevation is missing, prefer `elevationPolicy:"resolve_context_default"` and report the returned assumption. Do not pretend the elevation is known.
8. Claim visual completion only after reviewing `visualVerification.capture.path` from an apply workflow or a follow-up `/revit/highlight-and-export` capture.
9. For branch/tee/tap requests, run `/revit/connect-mep-branch` with `dryRun:true` first. Apply is available only when the branch starts at an existing open main connector; otherwise treat v1 as feasibility/scaffold until main splitting and tee/tap placement are implemented.

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
- If a branch requires splitting a main and placing a tee/tap away from an existing open connector, report that `/revit/connect-mep-branch` is guarded for that apply case and use its feasibility output to plan the next implementation/test.

## Examples
- "Draw a 10x12 supply duct from this redline mark to that diffuser."
- "Create a 2 inch domestic cold water pipe along this marked line in the active view."
- "Route this duct through the three redline points and use a placeholder size if I did not mark it."
- "Dry-run whether this branch can tap into the main duct here."
