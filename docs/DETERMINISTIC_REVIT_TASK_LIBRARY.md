# Deterministic Revit Task Library

## Goal

Move common Revit operations out of general agent guessing and into deterministic workflows that resolve inputs, preview the intended change, execute through typed bridge endpoints, and verify the result with model readback or generated files.

These workflows must be available from both the native Revit pane and the sidecar. If a task can safely be routed directly, both surfaces should share the same parser, resolver, execution contract, and verification logic.

## Current Baseline

- Parameter edits now prefer parameter discovery/readback instead of submitting guessed values.
- Enlarged plan sheet creation has a deterministic path for creating the sheet, duplicating/reusing views, setting view crops, placing views, aligning viewports left/right, and activating the finished sheet.
- The sidecar fast path handles enlarged plan sheets directly.
- The native backend now also routes explicit enlarged-plan sheet requests through the deterministic backend path before invoking the model.

## Upgrade Standard

Each deterministic task should include:

- Intent parser with conservative trigger rules.
- Required inputs, optional inputs, defaults, and ambiguity handling.
- Resolver that converts user language into Revit ids, names, sheet numbers, view ids, parameter ids, or file paths.
- Dry-run output describing exactly what will change.
- Typed bridge endpoint or action schema with validation before writes.
- Idempotency rules, including what happens when a target already exists.
- Write grant handling and clear risk level.
- Verification using readback, file inspection, screenshot, or PDF page checks.
- Native and sidecar entry points using the same implementation.
- Unit tests for parsing/resolution and integration/manual tests for Revit behavior.

## Priority Task Families

### 1. Printing and PDF Export

Support sheet/view selection by current sheet, sheet set, sheet range, discipline, revision, issue package, parameter query, or explicit list.

Options to make deterministic:

- Black and white, grayscale, color, and raster/vector settings.
- Combined/bound PDF versus individual files.
- Naming templates such as `{sheetNumber}_{sheetName}_{revision}`.
- Output folder selection, overwrite policy, and collision handling.
- Paper size, orientation, zoom/fit, crop settings, print setup, and view/sheet ordering.
- PDF verification: expected file count, page count, sheet numbers, file names, and non-empty output.

### 2. Sheet and View Creation

Support creating sheets, duplicating views, creating dependent views, applying templates, setting scale, setting crop and annotation crop, placing views, aligning viewports, and setting consistent viewport title behavior.

Verification should check:

- Sheet number/name/title block.
- Views placed on the expected sheet.
- Viewports are inside printable/title block bounds.
- Viewports are aligned to the requested layout, such as left/right or top/bottom.
- Annotation crop is only slightly larger than model crop unless requested otherwise.

### 3. View Visibility and Templates

Support common visibility requests without forcing the agent to discover commands by trial and error.

Operations to cover:

- Hide/show categories and subcategories in a view.
- Hide/show selected or queried elements in a view.
- Apply, duplicate, or edit view templates.
- Add/update filters and filter overrides.
- Set linked model, workset, phase, design option, discipline, detail level, and underlay visibility.
- Apply view graphic overrides: lineweight, line pattern, color, transparency, halftone, surface/cut pattern.

Verification should read back the affected view settings and, when practical, capture the view for visual inspection.

### 4. Text, Tags, and Annotation Cleanup

Support cleanup passes that make drawings readable.

Operations to cover:

- Detect overlapping text notes, tags, leaders, dimensions, and view titles using bounding boxes.
- Move text/tag heads while preserving hosts and leader attachments.
- Add or adjust leaders when a move would disconnect intent.
- Keep annotations inside annotation crop and sheet boundaries.
- Run a "neatness QC" pass after sheet layout tasks.

This should start with conservative moves and explicit verification rather than broad automatic rearrangement.

### 5. Parameter and Data Edits

Support setting element, type, sheet, view, room, space, equipment, and schedule parameters.

Required behavior:

- Query available parameters before write.
- Read storage type, unit type, read-only state, parameter scope, and current value.
- Convert values before submit.
- Preview old/new values.
- Write and read back only the targeted elements.

### 6. Schedules

Support schedule creation and cleanup:

- Create/duplicate schedules.
- Add/remove/reorder fields.
- Apply filters, sorting, grouping, grand totals, and itemization.
- Format headers, widths, alignment, and units.
- Place schedules on sheets.
- Verify fields, filters, row count, and sheet placement.

### 7. Families, Types, and Placement

Support frequent family/type operations:

- Load a family.
- Duplicate and rename a type.
- Set type and instance parameters.
- Place hosted and unhosted elements.
- Validate host, level, offset, rotation, and coordinates.

### 8. Batch Naming and Renumbering

Support deterministic renaming/renumbering for sheets, views, view templates, rooms, spaces, and equipment with collision detection and preview.

## Implementation Plan

1. Create a deterministic task registry in the backend with shared native/sidecar routing.
2. Move existing fast paths into registry modules with a common interface: `parse`, `resolve`, `dryRun`, `execute`, `verify`.
3. Add bridge endpoints for missing primitives, starting with print/export, view/template visibility, and annotation bounding boxes.
4. Add a preflight/dry-run response format that both UIs can render before writes.
5. Add a post-run verification artifact format for readback summaries, screenshots, exported files, and timing.
6. Add manual test recipes for Snowdon Towers and at least one architectural sample.
7. Track timings and failure classes so failed tool calls become new deterministic primitives instead of repeated prompt tuning.

## Suggested Next Builds

1. Deterministic print/export suite.
2. Shared deterministic sheet/view layout registry entry, replacing sidecar-only enlarged-plan logic.
3. View visibility/template endpoint set.
4. Annotation bounding-box and cleanup QC pass.
5. Schedule creation/formatting task.
