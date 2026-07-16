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
- Required background-link manifest with every link loaded, plus a live Revit capture and exported test PDF proving that walls, doors, rooms, grids, and other required context actually plot. An unresolved or visually absent required background invalidates the package and any visual score.
- Allowed categories and maximum created-element count.
- Explicitly forbidden evaluator artifacts, including source/ground-truth model, ground-truth snapshot, deletion manifest, and withheld package.
- Candidate snapshot, focused capture, post-change PDF, and run-receipt output paths.

## Monotonic workflow

1. **Inspect** the bounded model region, PDF, mapping, surrounding elements, connectors, hosts, rooms/spaces, and project precedent. Verify every required Revit link is loaded before interpreting or scoring the view, then inspect one exported test PDF to prove the background plots. Do not search evaluator-only paths.
2. **Plan** exact proposed elements with category, role, family/type or pathway type, geometry/elevation, system, physical connections, host, room/space, and factual electrical-system intent where applicable. Record confidence and assumptions.
3. **Clarify** only when unresolved ambiguity would materially change geometry, size/elevation, family/type, system, host, or circuit. Consolidate material ambiguities into one focused question. Do not ask about harmless uncertainty that can be recorded as an assumption.
4. **Score benchmark geometry before workflow emission** when evaluator-owned original-model truth exists. Recompute from the exact compilation and bounded truth inside the promotion process; never accept caller-supplied score JSON. An unscored real-user workflow requires explicit user direction and receives no benchmark credit.
5. **Dry-run** every write. The planned keys, categories, bounds, maximum count, and expected anchors must match the approved plan exactly.
6. **Apply** only the dry-run plan under the normal write grant. Stop on dependent deletion, broadened scope, fallback family/system/type, or unexpected element changes.
7. **Verify native state** using exact created IDs and surrounding anchors:
   - duct/pipe: endpoints, size, elevation, type, system, fittings, physical connector topology, and open connectors;
   - air/plumbing devices: location, orientation, family/type, level, room/space, host, parameters, and physical connection when expected;
   - electrical devices: location, orientation, family/type, room, host, and real Revit ElectricalSystem membership. Panel/circuit labels alone are not circuit proof.
8. **Verify visually** with a focused Revit capture and a post-change PDF. Check omissions, duplicate/false-positive work, collisions, legibility, and important-information obstruction.
9. **Repair** only an evidenced defect. Dry-run each repair and repeat native plus visual verification. Stop after the package repair budget.
10. **Complete or block** with exact element IDs, hashes, assumptions, metrics, and unresolved facts. Never claim engineered electrical/plumbing/HVAC adequacy from geometric reconstruction alone.

## Discipline execution routes

- For bounded repeated plan symbols, use `npm run existing-conditions -- detect-repeated-mep-symbols --input <hash-bound-template-search.json> --out <candidate-receipt.json>`. Give each template a tight `pixel_bounds` around complete model-symbol geometry, an explicit `anchor_point`, and an optional larger `context_bounds` used only to disambiguate repeated linework. Tag text or a type-mark polygon such as a repeated `U2` label is annotation, not fixture geometry, even when it consistently matches and names the intended family type. The detector verifies source bytes/dimensions, enforces search/work/match caps, returns individual source-only candidates with `native_write_allowed:false`, and never treats adjacent text as family/type, host, circuit, or connectivity authority. A successful repeated-template result is not arbitrary symbol recognition.
- Use MEP region coverage schema V2 before compilation whenever point symbols or annotations are present. A resolved point observation requires one complete, clear `single_model_symbol` with a role matching the proposed observation. `multi_symbol_cluster` and non-circuit `annotation_cluster` evidence stays unresolved; lighting fixtures and lighting controls are distinct roles; a clipped point symbol stays unresolved; and circuit annotation must anchor to one resolved individual electrical device, electrical equipment item, or light fixture that is an explicit member of the circuit observation.
- Agent-selected plumbing routes/fixtures and electrical devices can begin in registered plan-image pixels with `npm run existing-conditions -- compile-registered-mep-observations --input <registered-pixels.json> --out <compilation.json> --package-out <observations.json>`. The adapter verifies the agent-visible render's hash, dimensions, registration, frame, coordinate bounds, discipline, evidence roles, and per-material evidence receipts before converting pixels into the existing structured MEP package. It never treats plotted panel/circuit labels as native circuit membership.
- For benchmark/native-truth development, emit the workflow only through `npm run existing-conditions -- promote-registered-mep-observations --input <registered-pixels.json> --truth <evaluator-ground-truth.json> --out <promotion.json> --score-out <score.json> --workflow-out <dry-run.json>`. The command recomputes a sealed score from the exact compilation and evaluator-owned bounded plan-visible keys, then binds workflow emission to that compilation fingerprint. A score-shaped JSON file cannot authorize promotion. `compile-registered-mep-observations --workflow-out ... --allow-unscored-user-workflow` and `compile-mep-draft --workflow-out ... --allow-unscored-user-workflow` are reserved for explicit real-user direction, remain unscored, and cannot receive benchmark acceptance.
- Structured plumbing/electrical observations can also be compiled directly with `npm run existing-conditions -- compile-mep-draft --input <observations.json> --out <plan.json>`. The package must include the native `level_name` and its absolute `level_elevation_ft`; each observation's `elevation_ft` is an offset above that level. The compiler hash-binds and verifies a 2D source-to-model similarity registration, emits controller source observations and plan elements, blocks material ambiguity, and produces an atomic native dependency graph. Emitting its unscored workflow requires the explicit user-direction flag above.
- Submit the generated dry-run body to `/revit/existing-conditions-mep-draft-workflow`. The request carries the compiler input fingerprint, and each plumbing service join names the observed start or end of its route instead of expanding to every segment/fitting. The native workflow executes every dependent placement, route, endpoint join, and factual circuit assignment inside one Revit transaction group and rolls the whole group back for dry-run or on any failed operation. Rolled-back IDs are reported only as transient diagnostics, never as committed `createdElementIds`. Repeated-template detection can propose bounded individual symbol candidates, but novel symbol interpretation and promotion remain agent/vision tasks guarded by representation-aware coverage.

- Duct and pipe pathways: prefer `/revit/mep-route-workflow`; use explicit system/type/size/elevation and `connectToExisting` plus `requireExistingEndpointConnections` when both stable anchors are known.
- Air terminals and unhosted equipment: use `/revit/place-families` or a bounded workflow wrapper with source-model family/type precedent, then inspect connectors and system assignment.
- Wall/face-hosted plumbing or electrical devices: use `/revit/place-family-instance-on-host` with a real exemplar, exact host category, room-side context, and source-supported orientation. Do not force orientation matching when Revit cannot rotate the exemplar onto the resolved host; preserve the safe host placement and record the orientation limitation instead.
- Electrical circuits: use `/revit/assign-electrical-circuit` with `sourceElementId` only when source precedent proves one exact power system. Treat panel/circuit parameter fallback as labels, not membership.
- Evidence: use `/revit/export-visible-elements`, `/revit/get-connectors`, `/revit/export-view-region`, and `/revit/export-pdf` on the exact scope.

## Stop conditions

- Visible-evidence hash differs from the package.
- The active model is not the exact redacted model.
- Any required architectural or discipline background link is unresolved, unloaded, or absent from the live view or exported test PDF.
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
