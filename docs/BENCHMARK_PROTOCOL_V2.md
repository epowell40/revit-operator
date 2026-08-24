# Benchmark Protocol V2

Benchmark Protocol V2 is the release-measurement layer for General Revit Agent
flights. It consumes canonical Assignment/attempt projections and retained
provider, Revit, fixture, and evaluator evidence. It does not change production
agent or Revit behavior.

## Truth surfaces

Every case preserves five distinct judgments:

1. `execution_truth`: canonical dispatch/effect/readback truth. Only native,
   target-bound, or independent authority can prove `applied`.
2. `original_runtime_verdict`: what the runtime recorded during the flight.
3. `original_evaluator_verdict`: the evaluator judgment frozen with the raw
   report.
4. `current_evaluator_verdict`: the judgment from the named current evaluator.
5. `presentation_verdict`: whether the user-facing answer agrees with the raw
   execution and semantic evidence.

Assistant wording and caller-shaped receipts cannot change execution truth. A
rescore creates a new hash-bound artifact, retains the original verdict, names
the source raw report and its SHA-256, and explains every changed verdict. The
raw report writer refuses to overwrite an existing artifact.

## Run envelope

New runs require `--protocol-v2-envelope <draft.json>`. The runner validates the
complete preflight identity before contacting the agent, then finalizes the
immutable envelope with the observed provider routes and completion timestamp.
It fails closed when any required revision, fixture hash, policy hash,
instruction hash, model/effort, authorization, run/session/generation identity,
or receipt is absent. `--legacy-protocol-v1` is restricted to retained
historical inspection/rescoring.

The preflight draft is validated by
`benchmark/contracts/benchmark_run_envelope_draft.v2.schema.json`; the finalized
immutable artifact is validated by `benchmark_run_envelope.v2.schema.json`.
The finalizer adds `observed_provider_routes`, `completed_at`, and
`envelope_sha256` exactly once from retained flight telemetry. Case hashes use
canonical, recursively key-sorted JSON. The original manifest hash uses the
exact manifest bytes.

## Stage vector and failure causes

Every case contains this ordered stage vector:

1. fixture valid
2. intent understood
3. target grounded
4. plan admissible
5. authorization/admission satisfied
6. preview correct where required
7. action dispatched
8. effect classified
9. postcondition read back
10. task semantics satisfied
11. user-facing result accurate

The first `fail` or `uncertain` stage is recorded. Primary and contributing
causes use the stable V2 taxonomy in `protocol_v2_types.ts`, including fixture,
context, grounding, planning, authorization, schema, dispatch, reconciliation,
verification, lifecycle/evidence, evaluator, presentation, infrastructure,
false-completion, and collateral-mutation categories.

## Independent lanes

- `controlled_capability`: the harness owns the exact disposable fixture,
  active view, and selection preconditions outside scored agent actions.
- `ambient_context`: the agent begins from ordinary Revit context and must
  inspect, infer safely, or ask.
- `safe_readiness`: reads and rollback-verified previews. These never count as
  delivered committed labor.
- `committed_apply`: isolated disposable fixture, real apply, independent
  readback, collateral checks, then discard.

Reports have one table per lane. `Accepted`, truthful blockers, verified no-ops,
and safe previews are reported separately and excluded from the primary
delivered-labor rate. False completion and unauthorized/collateral mutation set
`release_blocked=true`.

## Release canary

The frozen non-resumed release canary is:

`q01`, `r01`, `b04`, `r10`, `r13`, `c03`, `c12`, `c15`, `c30`, and `r16`.

The current explicit mappings are printed without changing the cases:

```powershell
cd apps/operator-backend
npm run benchmark:protocol-v2 -- canary-list
```

Run it after creating a complete envelope draft whose `run_id` is new and whose
case hashes cover those exact cases:

```powershell
.\scripts\run_general_revit_benchmark.ps1 `
  -Suite full -ReleaseCanary -Apply -Lane committed_apply `
  -ProtocolV2Envelope C:\external-eval\canary-envelope-draft.json
```

The runner owns exact fixture transitions, isolates apply cases by default,
rejects resume, requires all ten traces, and fails closed on incomplete provider
or Revit receipts. Exact rerun comparison uses a new run identity and unchanged
case hashes.

Compare two immutable runs while failing closed on corpus, case, fixture,
evaluator, lane, instruction, model, authorization, or feature-flag drift:

```powershell
npm run benchmark:protocol-v2 -- compare `
  --baseline C:\external-eval\canary-a\protocol-v2\raw-report.json `
  --candidate C:\external-eval\canary-b\protocol-v2\raw-report.json `
  --output C:\external-eval\comparisons\canary-a-vs-b.json
```

Release/source revisions and observed provider routes remain explicit comparison
dimensions rather than being mistaken for case drift.

## Immutable projection and rescoring

Project a retained V1 flight into V2 without contacting Revit:

```powershell
cd apps/operator-backend
npm run benchmark:protocol-v2 -- project `
  --envelope C:\external-eval\envelope-draft.json `
  --legacy-report C:\external-eval\flight\report.json `
  --output C:\external-eval\flight\protocol-v2\raw-report.json
```

Rescore the same raw evidence into a new file:

```powershell
npm run benchmark:protocol-v2 -- rescore `
  --source C:\external-eval\flight\protocol-v2\raw-report.json `
  --legacy-report C:\external-eval\flight\report.json `
  --evaluator-version revit-operator.general-revit-evaluator/v2.1 `
  --output C:\external-eval\flight\protocol-v2\rescore-v2.1.json
```

## External hidden holdouts

Hidden manifests and RVTs must stay outside both repository trees. The external
manifest uses `benchmark_external_holdout.v2.schema.json`, maps every case to
exactly one hash-verified fixture, and runs through the same runner, schemas,
evidence, and evaluator. Its output directory must also be external because the
retained legacy flight contains raw prompts and criteria. Ordinary console and
descriptor output contains only manifest identity, hashes, counts, and case IDs.

```powershell
.\scripts\run_general_revit_benchmark.ps1 `
  -ExternalHoldout C:\authorized-holdout\manifest.json `
  -OutputDir C:\authorized-holdout\runs `
  -ProtocolV2Envelope C:\authorized-holdout\envelope-draft.json `
  -Lane committed_apply -Apply
```

## Case-driven repair policy

A visible-case-specific evaluator or runtime repair must register and test the
original case, at least three meaningful neighboring perturbations, one
negative case, and one unrelated regression case. Validate the cohort with
`benchmark:protocol-v2 -- validate-repair-cohort --input <file>`. Production
runtime code must not reference case IDs; the existing benchmark/runtime
architecture boundary gate enforces that one-way dependency.

## Canonical read finalization

For read-only cases, current-bound canonical attempt receipts are the primary
Revit receipt class. A compiled/direct-delegate flight may legitimately have an
empty legacy outer `tool_calls` list when nested MCP calls are fully represented
by canonical receipts. Protocol V2 requires each successful canonical read to
show acknowledged dispatch, effect `none`, accepted native/readback authority,
receipt and EvidenceRef identities, terminal Assignment truth, and an
authentic hash-valid Work Packet bound to the same Assignment/run/generation.

Missing mutation receipts are not reported for a read Assignment that has those
authoritative read receipts. Conversely, a caller result, assistant answer,
unbound packet, open Assignment, missing EvidenceRef, or incomplete packet hash
still fails closed. Verified read completion is reported separately from
committed delivered labor; it does not increase the committed-labor rate.
