# Skill: Reconstruct Existing Conditions From As-Builts

## Goal

Reconstruct a bounded portion of missing existing-condition work from plotted PDF evidence and a redacted Revit model while preserving evidence isolation, model scope, factual system relationships, and professional drawing quality.

## Supported disciplines

- HVAC ductwork and air terminals.
- Hydronic HVAC piping.
- Plumbing piping and fixtures.
- Electrical devices and factual circuit membership.
- Mixed-discipline scopes only when each discipline has explicit allowed categories and independent verification.

## Required package

- Exact redacted working-model path and SHA-256.
- Source PDF path/page and SHA-256.
- Exact view or sheet plus normalized image region and model-space bounds.
- Allowed categories and maximum created-element count.
- Explicitly forbidden evaluator artifacts, including source/ground-truth model, ground-truth snapshot, deletion manifest, and withheld package.
- Candidate snapshot, focused capture, post-change PDF, and run-receipt output paths.

## Monotonic workflow

1. **Inspect** the bounded model region, PDF, mapping, surrounding elements, connectors, hosts, rooms/spaces, and project precedent. Do not search evaluator-only paths.
2. **Plan** exact proposed elements with category, role, family/type or pathway type, geometry/elevation, system, physical connections, host, room/space, and factual electrical-system intent where applicable. Record confidence and assumptions.
3. **Clarify** only when unresolved ambiguity would materially change geometry, size/elevation, family/type, system, host, or circuit. Consolidate material ambiguities into one focused question. Do not ask about harmless uncertainty that can be recorded as an assumption.
4. **Dry-run** every write. The planned keys, categories, bounds, maximum count, and expected anchors must match the approved plan exactly.
5. **Apply** only the dry-run plan under the normal write grant. Stop on dependent deletion, broadened scope, fallback family/system/type, or unexpected element changes.
6. **Verify native state** using exact created IDs and surrounding anchors:
   - duct/pipe: endpoints, size, elevation, type, system, fittings, physical connector topology, and open connectors;
   - air/plumbing devices: location, orientation, family/type, level, room/space, host, parameters, and physical connection when expected;
   - electrical devices: location, orientation, family/type, room, host, and real Revit ElectricalSystem membership. Panel/circuit labels alone are not circuit proof.
7. **Verify visually** with a focused Revit capture and a post-change PDF. Check omissions, duplicate/false-positive work, collisions, legibility, and important-information obstruction.
8. **Repair** only an evidenced defect. Dry-run each repair and repeat native plus visual verification. Stop after the package repair budget.
9. **Complete or block** with exact element IDs, hashes, assumptions, metrics, and unresolved facts. Never claim engineered electrical/plumbing/HVAC adequacy from geometric reconstruction alone.

## Discipline execution routes

- Duct and pipe pathways: prefer `/revit/mep-route-workflow`; use explicit system/type/size/elevation and `connectToExisting` plus `requireExistingEndpointConnections` when both stable anchors are known.
- Air terminals and unhosted equipment: use `/revit/place-families` or a bounded workflow wrapper with source-model family/type precedent, then inspect connectors and system assignment.
- Wall/face-hosted plumbing or electrical devices: use `/revit/place-family-instance-on-host` with a real exemplar, exact host, orientation matching, and room-side context.
- Electrical circuits: use `/revit/assign-electrical-circuit` with `sourceElementId` only when source precedent proves one exact power system. Treat panel/circuit parameter fallback as labels, not membership.
- Evidence: use `/revit/export-visible-elements`, `/revit/get-connectors`, `/revit/export-view-region`, and `/revit/export-pdf` on the exact scope.

## Stop conditions

- Visible-evidence hash differs from the package.
- The active model is not the exact redacted model.
- Required PDF mapping, model bounds, family/type, system, elevation, host, or circuit is materially ambiguous.
- Dry-run changes categories, elements, or bounds outside the package.
- Native readback is missing or a requested physical/circuit relationship cannot be proven.
- The repair budget is exhausted.

## Success criteria

- No evaluator-only artifact was accessed and no out-of-scope element changed.
- Every expected element is matched ID-independently by native geometry and discipline attributes.
- Applicable physical, host, spatial, system, and electrical-circuit relationships match the withheld truth.
- Focused capture and post-change PDF were inspected and accepted.
- The final candidate and run receipt contain exact hashes, IDs, assumptions, warnings, and failure classifications.
