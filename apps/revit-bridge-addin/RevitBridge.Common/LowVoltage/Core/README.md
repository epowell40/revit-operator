# Low-Voltage Core Framework

Shared deterministic pipeline for low-voltage/power style layouts.

## Flow
1. **Export** Revit data into `ModelState`.
2. **Normalize** names/types using JSON profiles (`NormalizationProfile`).
3. **Graph** rooms with `SpaceGraphBuilder`.
4. **Generate candidates** from room/wall/ceiling/equipment/fixture geometry.
5. **Run discipline rule engine** (`ILowVoltageRuleEngine`).
6. **Build preview** (`PreviewBuilder`) and **placement actions** (`PlacementAction`).
7. Optionally write debug snapshots:
   - `input_state.json`
   - `normalized_state.json`
   - `candidates.json`
   - `result.json`

## Design notes
- Core module has no Revit API dependency.
- Discipline logic plugs in via rule engines under skill-specific modules.
- Placement execution is outside core and can run in `preview-only` or `apply` mode.
- Fire alarm now uses the shared pipeline with a profile-driven rule engine, grouped corridor/open-area subjects, structured manual-review items, and richer diagnostics for missing family symbols or rejected candidates.
