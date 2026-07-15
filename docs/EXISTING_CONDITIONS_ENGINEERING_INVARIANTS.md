# Existing-conditions engineering invariants

Revit Operator benchmarks must distinguish reconstructing documented existing conditions from correcting a standards defect and producing a new layout. A Snowdon source model is useful evidence, but it is not itself a universal engineering standard.

## Task classes

### Exact reconstruction

The agent receives bounded visible evidence and a redacted model. Hidden truth may score geometry, family/type, size, elevation, system, topology, host, circuit, and drawing legibility. Exact coordinates can be appropriate because the task is to reproduce documented existing conditions.

### Standards/compliance repair

The evaluator scores the adopted engineering rule and accepts every solution that satisfies it. It must not require the original Snowdon element ID, family name, coordinate, or circuit when another native solution is valid.

Examples include:

- prove GFCI protection for an applicable receptacle near a sink;
- repair a dwelling wall-space coverage gap;
- move receptacle load onto circuits without exceeding the calculated capacity;
- add a missing plumbing service or remove a prohibited one.

### Generative layout

The evaluator accepts a class of solutions and scores engineering invariants, system topology, constructability, drawing legibility, and scope safety. The hidden reference design can be a comparison point, but not the sole answer.

## Required standards context

Every compliance or generative case must declare:

- jurisdiction and authority having jurisdiction;
- adopted code family and edition;
- effective date and occupancy/use classification;
- local amendments, including an explicit empty list, ordinance/revision, affected sections, source URL, and SHA-256;
- project/client criteria, revision, source URL, and SHA-256;
- primary-source authority, title, edition, section/subsection/table, source URL, and SHA-256 for every rule;
- conflict precedence and an immutable hash for the complete standards profile.

The evaluator has no implicit “latest code” mode. A rule without this context fails closed. Numerical thresholds live in the fixture's standards profile; they are not universal constants in the evaluator.

## Electrical invariants

### GFCI protection

Score verified protection, not a family/type label. An integral GFCI device, upstream feed-through device, GFCI branch breaker, or documented equivalent can pass only when evaluator-owned native path evidence identifies the subject receptacle, protection device, and protected circuit. Applicability, measurement method, voltage/rating limits, and exceptions come from the adopted profile. Invalid or missing measurements fail closed.

### Dwelling receptacle coverage

Score continuous qualifying wall-space coverage. The evaluator projects eligible outlets onto each uninterrupted segment and verifies that the union of their allowed coverage intervals spans the segment. Many coordinate layouts can therefore pass. Door/opening interruptions, minimum qualifying width, floor-outlet eligibility, and maximum point distance are profile inputs.

Native discovery must also prove that each existing device belongs to the target Room or Space. Direct Revit spatial association takes precedence so a valid wall-hosted device on the boundary is retained; insertion-point containment is only a fallback when no direct association exists. A nearby device assigned to an adjacent space must not count merely because it projects onto the same shared wall. Evaluator capture should retain the excluded near-boundary IDs as a scope receipt and independently cross-check target-room inventory.

### Circuit loading

Score native circuit membership and calculated volt-amperes. General-use receptacle load is represented per yoke or strap, so simplex, duplex, and quad face configurations do not become guessed VA values. The evaluator calculates:

`required VA = noncontinuous VA + continuous VA × adopted multiplier`

and compares it with the profile-selected single- or three-phase circuit-capacity calculation. Native circuit membership, yoke/strap count, OCPD basis, conductor basis, and conductor/OCPD compatibility must all be verified. This avoids a blanket “all circuits are limited to 80 percent” rule. A 100-percent-rated exception requires immutable equipment evidence and native verification; a caller-provided boolean is insufficient.

The evidence also binds a complete evaluator-owned scoped receptacle inventory. Every scoped device must appear on exactly one evaluated circuit, circuit IDs must be unique, and the same native element cannot be counted twice within or across circuits. Load scope and capacity calculation are explicit profile fields (`non_dwelling_general_use`, `dwelling_profile`, or `project_specific`; single-phase or three-phase line-to-line), so a non-dwelling 180-VA/yoke exercise cannot silently score a dwelling case. Yoke/strap count and continuous/noncontinuous classification are derived from immutable evaluator family/type profiles; they are not mislabeled as native Revit facts. Other circuit loads require native evaluator readback. Different compliant circuit groupings are intentionally accepted.

For panel-scoped live acceptance, `/revit/audit-electrical-circuit-loading` discovers the complete `OST_ElectricalFixtures` inventory inside Revit, resolves an exact panel name to one native panel element, and returns family/type identity plus exact power-system membership for every selected device. The evaluator configuration contains the panel name and engineering profiles, but no subject element IDs, circuit IDs, or accepted coordinates. Pure receptacle circuits are evaluated; non-receptacle circuits are explicitly counted as excluded, and a circuit mixing profiled receptacles with unclassified loads fails closed instead of treating omitted load as zero.

The shipped 180-VA-per-yoke holdout is explicitly a non-dwelling general-use receptacle-loading exercise. Dwelling-unit general receptacles are not silently evaluated with that same method; their load calculation must come from the declared dwelling profile. GFCI and dwelling wall-space cases remain separate checks even when they happen to appear in one model.

## Plumbing invariants

Fixture profiles declare required and prohibited services. The evaluator checks native system reachability rather than demanding a separate direct connector for every conceptual service.

- An occupancy- and use-specific lavatory profile can require cold water, hot or tempered water, sanitary drainage, and a vented drainage path.
- A sourced project profile for a conventional water-closet subtype can require cold water, sanitary drainage, and a vented drainage path and can prohibit an unintended hot-water connection. Bidet/personal-hygiene and other combination products require separate profiles; “all toilets prohibit every hot-water path” is not a universal engine rule.
- Vented drainage can pass through verified downstream network topology; the vent does not need to connect directly to the fixture family. A sink may transition to a vent downstream of its trap, a bottom-outlet water closet may reach a vent downstream of its floor connection, and common-, wet-, or other project-approved vent arrangements must be judged by factual native reachability rather than one prescribed route shape.
- Each service needs one unique fixture-bound native path. Duplicate service summaries, paths that do not begin at the target fixture for a claimed direct connection, ambiguous subtype profiles, and a “vent” claim that merely repeats the sanitary path without a distinct downstream vent continuation fail closed. Exact path element IDs and route geometry are not acceptance targets; alternate native connector/network routes can pass.
- Flush-tank, flushometer-tank, and flushometer-valve connection-size criteria are separate sourced subtype rules. Manufacturer and project criteria can narrow them. The engine intentionally ships no guessed universal fixture connection sizes.

## Architectural opening invariants

Opening evidence and host evidence are separate. A deleted window can leave a continuous wall in the redacted model while its source-only plan graphics retain parallel glazing/frame strokes, sill lines, and jambs. In that case the source symbol must bind to a paired-face wall measured from the hash-bound redacted capture; the symbol's own parallel strokes may not become their own wall host.

- Source-symbol binding requires at least two separated longitudinal strokes within a bounded wall band plus transverse jamb/frame closure evidence near both ends. A single long annotation, unclosed paired annotation, two strokes away from the wall, or an undersized mark does not produce an opening hypothesis. The longitudinal strokes need not bracket the wall centerline because many legitimate plan symbols are offset toward one wall face.
- Split glazing strokes may merge across one bounded center-mullion interruption. The inferred full span may extend only to connected source-only jamb/frame ink and only within the measured wall-band limit; ordinary wall piers must not be bridged.
- Classification remains a separate crop-bound decision. A window still requires visible glazing/sill cues, while a door requires its declared leaf/swing/jamb cues. Neither image stage selects a native Revit element or family type.
- A bounded source crop cannot prove the full native length of a wall that continues beyond the crop. Host scoring clips evaluator-owned native wall geometry to the declared model-space scope before computing endpoint/overlap coverage, while still requiring the correct native host relationship and plan-visible opening location. When evaluator truth exposes opening width, the measured plan width is a hard matching gate and contributes to opening geometry; absent width remains explicitly unscored rather than guessed.
- A development fixture that exposes a detector failure remains a regression after the fix. It cannot be relabeled as the independent post-fix holdout.

## Leakage controls

Evaluation splits must hold out configured source-model families, source regions, PDF/view fingerprints, prompt-template fingerprints, mutation families, and hidden-answer fingerprints. A standards or generative evaluation case cannot be an exact replay of a deleted source pattern or reuse source-model geometry as its sole answer. Useful mutation families include:

- change protection provenance while preserving the receptacle appearance;
- create a wall-space coverage gap at a different coordinate and wall length;
- vary breaker rating, voltage, yoke count, continuous load, and native circuit membership;
- vary circuit IDs, ordering, element IDs, family/type labels, and valid device-to-circuit groupings while preserving the same engineering facts;
- omit cold or hot service, add prohibited hot service to a water closet, break sanitary reachability, or break only the downstream vent path;
- vary compliant plumbing branch order and path length, and independently test duplicate summaries, wrong fixture-bound paths, wrong system classifications, ambiguous profiles, and subtype-specific size boundaries;
- vary fixture subtype and supply-size criteria through the standards profile;
- add plausible but out-of-scope nearby work to measure false positives.

At least one evaluation family should use a different model region or independently generated geometry from every development example. Drawing quality and scope safety remain gates even when the engineering rule passes.

## Public implementation

The public evaluator primitives are in `apps/operator-backend/src/existing_conditions/engineering_invariants.ts`. Compliance/generative scoring requires evaluator-owned native before/after scope receipts and evaluator-owned access provenance; candidate self-report is not accepted as proof. The agent-package schema carries the task class, standards-profile hash, multi-solution acceptance basis, and required receipt paths. Focused tests cover task-class separation, verified GFCI paths, interval-based wall coverage, yoke/strap VA and continuous-load calculations, plumbing service topology, subtype-driven sizes, and cross-split leakage detection.

The declarative case runner is in `apps/operator-backend/src/existing_conditions/engineering_case_runner.ts`. A case definition owns rules and geometry; a separate evaluator-owned native-evidence file owns model observations. An evaluator-only key, kept outside the agent-visible package, HMAC-signs the canonical case hash, native-evidence hash, and standards-profile hash. The runner rejects missing/extra checks, type mismatches, profile-hash drift, non-native evidence, candidate-owned evidence, stale/tampered evidence, and invalid signatures before deriving check results.

Seal evaluator evidence:

`npm run existing-conditions -- seal-engineering-evidence --case <case.json> --native-evidence <evaluator-native-evidence.json> --evaluator-key-file <secret> --out <provenance.json>`

Evaluate it:

`npm run existing-conditions -- evaluate-engineering-case --case <case.json> --native-evidence <evaluator-native-evidence.json> --evaluator-provenance <provenance.json> --evaluator-key-file <secret> --out <evaluation.json>`

A valid but failing engineering case writes its detailed evaluation and exits nonzero. The signing key is an evaluator secret and must never be placed in the agent package, fixture directory, Git, or model workspace.

Independent holdout fixtures live under `apps/operator-backend/test/fixtures/existing_conditions/engineering_compliance/`. They include breaker-protected sink GFCI, multiple valid wall-space layouts, non-dwelling receptacle circuit rebalancing, and lavatory/water-closet service topology. Their standards profile is deliberately labeled benchmark-only; it must be replaced with the real project jurisdiction, AHJ adoption, amendments, and criteria before any project compliance claim.

### Live native GFCI capture

The first live compliance fixture uses a Snowdon duplicate as realistic geometry, not as a code oracle. The evaluator chooses a bounded room region without exposing target element IDs, captures plumbing/electrical room contents plus per-element native parameter readbacks, and derives horizontal clear distance to transformed sink bounding geometry. Sink candidates are limited to the receptacle scope expanded by an evaluator-declared search radius. Integral-device proof comes from the same per-element native readback that supplies voltage; a room symbol or family label alone is insufficient. The case and signed evidence bind the immutable starting task-model hash, while capture records and verifies the distinct post-change model hash. This establishes fixture lineage without requiring every valid repair to produce one exact RVT binary. The signed evidence also binds canonical hashes of the adapter configuration, room inventory, and parameter readbacks.

Capture live evidence from the expected open model:

`npm run existing-conditions -- capture-gfci-native-evidence --adapter-config <evaluator-adapter.json> --expected-model <model.rvt> --out-dir <capture-dir> --token-file <operator_token.txt> --grant-file <write_grant.json>`

Or derive evidence from already captured native responses:

`npm run existing-conditions -- collect-gfci-native-evidence --adapter-config <evaluator-adapter.json> --room-contents <room-contents.json> --parameter-readbacks <parameter-readbacks.json> --out <evaluator-native-evidence.json>`

The live acceptance pattern is baseline-delta, not hidden-answer replay: capture a known-good native baseline, introduce a deliberate defect, require the independent evaluator to fail it, repair it through the normal generic tool path, and require a fresh native capture to pass while scope, circuit association, drawing legibility, and unrelated model content remain unchanged. This V1 adapter proves integral-device protection only. Upstream feed-through and GFCI-breaker cases require separate native electrical-path adapters before they can pass live acceptance.

### Live native dwelling wall-space capture

The dwelling adapter consumes only the native wall-space discovery portion of `/revit/plan-dwelling-receptacles` plus an independent, unlinked `/revit/room-contents` inventory for the target Space. It derives receptacle chainages from target-room native points and discovered wall geometry; planner-proposed placements are explicitly ignored. The adapter requires exact set equality between planner-selected existing devices and independently projected target-room devices, rejects overlap with the near-boundary adjacent-space exclusion receipt, and rejects duplicate or missing configured wall segments. Exact target element IDs and accepted coordinates are absent from the adapter configuration and agent package.

Collect evaluator evidence from captured native responses:

`npm run existing-conditions -- collect-dwelling-wall-native-evidence --adapter-config <json> --planner-response <json> --room-contents <json> --out <evaluator-native-evidence.json>`

### Circuit-loading native adapter

The circuit adapter supports legacy room inventory and preferred native panel inventory. Panel mode is robust to hosted devices that Revit reports as `NotInRoom`: the endpoint itself scans electrical fixtures, resolves native panel identity, and proves inventory completeness before the evaluator selects profile-matched receptacle circuits. Alternate valid device-to-circuit groupings pass when membership is conserved and each circuit satisfies the adopted VA, OCPD, conductor, and continuous-load rules.

`npm run existing-conditions -- capture-circuit-loading-native-evidence --adapter-config <json> --expected-model <model.rvt> --out-dir <capture-dir> --token-file <operator_token.txt> --grant-file <write_grant.json>`

Capture directly from the expected open model:

`npm run existing-conditions -- capture-dwelling-wall-native-evidence --adapter-config <json> --expected-model <model.rvt> --out-dir <capture-dir> --token-file <operator_token.txt> --grant-file <write_grant.json>`

A valid live repair must pass the interval-union invariant. It is not required to reproduce the planner's proposal, a Snowdon source coordinate, or one frozen post-change RVT binary.

## Primary-source starting points

These are starting points, not embedded defaults. Each fixture must resolve its adopted edition and amendments.

- NFPA 70, Article 210 GFCI and dwelling receptacle provisions, and Article 220 receptacle load calculations: [NFPA 70 public access](https://link.nfpa.org/all-publications/70/2020)
- NFPA code-development record for NEC 210.52(A) wall-space coverage: [NFPA preliminary second-revision report](https://docinfofiles.nfpa.org/files/AboutTheCodes/70/70_A2025_NEC_P02_SD_PrelimSR.pdf)
- NFPA code-development record for sink-proximity GFCI criteria and exceptions: [NFPA public-input report](https://docinfofiles.nfpa.org/files/AboutTheCodes/70/70_A2025_NEC_P02_PISubmittals.pdf)
- ICC 2024 IPC Sections 602 and 604, including fixture-supply design criteria and size tables: [IPC Chapter 6](https://codes.iccsafe.org/content/IPC2024P1/chapter-6-water-supply-and-distribution)
- ICC 2024 IPC Sections 301.3 and 301.4 for drainage and water-supply connections: [IPC Chapter 3](https://codes.iccsafe.org/content/IPC2024P1/chapter-3-general-regulations)
- ICC 2024 IPC Chapter 9 for vent-system requirements: [IPC Chapter 9](https://codes.iccsafe.org/content/IPC2024P1/chapter-9-vents)
