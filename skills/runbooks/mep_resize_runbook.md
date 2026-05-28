# Skill: MEP Resize Runbook

Use this runbook for duct resize requests where fittings must update too.
Primary routing references:
- `skills/workflows/mep_resize_scope.md` (pathway-wide policy/routing)
- `skills/workflows/duct_resize_connected_run.md` (duct-specific connected-run heuristic)

## Goal
Keep duct resize execution deterministic and avoid false "success" when fittings/terminals remain unresolved.

## Use when
- Duct resize intent needs scoped discovery plus fitting/terminal convergence.

## Do not use when
- The user asks only for manual single-element edits.

## Required inputs
- Scope hint (`roomNumber` or equivalent).
- Target size and optional source size.
- Optional system classification.

## Execution steps
1. Run `revit_ducts_by_spatial_scope` to discover scoped ducts/fittings/terminals.
2. Run `revit_resize_ductwork_by_scope` with fitting/terminal handling enabled.
3. Require post-condition inspection from tool result (`postCondition.ok`).
4. If requested, capture post-change visual evidence.

## Success criteria
- Duct changes are applied as requested.
- Fitting/terminal convergence status is explicit.
- Any unresolved ids/reasons are reported.

## Failure handling
- If write grant is not ready, check `revit_write_grant_status` before retrying.
- Do not claim success when ducts changed but fittings remain mismatched.
- Report fallback path used, convergence status, and exact unresolved ids.

## Examples
- "Resize supply ductwork in office unit 301 from 8\" to 10\" and verify."
- "For room 0201, make return ducts 12\" and report unresolved fittings."
