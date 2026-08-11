# Dynamic Runtime usefulness and anti-demo benchmark

This package compares two execution representations on the same randomized Revit objective:

1. `epic0439_typed_v1` — certified typed capabilities composed as needed.
2. `epic0439_dynamic_v1` — a generated, admitted, previewed, and verified task-specific program.

The goal is to learn an execution-strategy policy. Dynamic Runtime is not expected to win every task. A simple parameter edit may favor a typed call; graph, geometry, contextual-rule, and novel tasks may favor a generated program.

## Coverage

The manifest contains 16 tasks: simple and bulk parameters, sheets/views, schedules, geometric and hosted placement, MEP routing/connectivity, existing-conditions reconstruction, annotation, linked-model reasoning, family/content, staged export, company/project/user rules, and a novel temporary egress-overlay task with no dedicated Operator workflow.

The authoritative manifest is `apps/operator-backend/benchmark/epic0439/usefulness_matrix.v1.json`. Each task has implementation wording and a separately selectable holdout wording pool. After implementation/runtime freeze, an independent reviewer can supply a JSON object mapping selected task ids to newly authored template arrays through `--reviewer-wording`; tasks absent from that file use the committed holdout pool.

## Anti-demo controls

Case generation uses deterministic `xorshift32` randomization derived from suite id, caller seed, task id, variant index, and wording partition. It randomizes:

- evaluator-only target element ids;
- labels and parameter values;
- displacement and element count;
- view context;
- company, project, user, and task rules;
- implementation versus unseen holdout wording.

Generated prompts never expose evaluator target ids. Dynamic target selection must use `live_evidence_query`; operated ids must appear in observation evidence, and fixture ids are rejected if found as literals in generated source. The synthetic candidate set is an anti-demo/source test fixture only. Live runs must replace it with current Revit observation evidence.

## Metrics

Every result records completion, correctness, changed-element precision, model turns, tool/RPC calls, generated code bytes, execution time, estimated cost, input/output tokens, preview repairs, verification quality, special-purpose product-code bytes, recovery attempts/outcome, and a structured terminal failure phase/classification when incomplete. Reports preserve evidence tiers and compute paired Dynamic-minus-Typed deltas only for the same case and tier.

Special-purpose product-code burden means permanent product implementation added solely to complete the benchmark task. Existing generic infrastructure is not charged to a run. Generated task source is measured separately as generated code bytes.

## Truth labels

The only allowed evidence tiers are:

- `source_only`: manifest, policy, compile, or static/source evaluation without execution;
- `mocked`: execution against a mock adapter or synthetic runtime;
- `live_revit`: execution against Revit with a non-empty runtime/document/admission/preview/apply/verification receipt.

Source-only and mocked results never count as live acceptance. The report emits a warning when no live evidence exists or tiers are mixed. A live acceptance flag remains false unless both representations have perfect completed live evidence for all 16 tasks and no source/mock rows are mixed into that report. This package ships no benchmark outcomes.

## Commands

From `apps/operator-backend`:

```powershell
npm run benchmark:epic0439 -- validate
npm run benchmark:epic0439 -- materialize --seed reviewer-private-01 --variants 3 --holdout --output artifacts/epic0439/holdout_cases.json
npm run benchmark:epic0439 -- materialize --seed reviewer-private-02 --reviewer-wording reviewer_prompts.json --output artifacts/epic0439/reviewer_cases.json
npm run benchmark:epic0439 -- report --results artifacts/epic0439/results.json --output-dir artifacts/epic0439/report
```

`materialize` creates cases; it does not run Revit or create results. Results must conform to `apps/operator-backend/benchmark/contracts/epic0439_usefulness_result.v1.schema.json` and the runtime validator.

## Live execution protocol

For each randomized case, run both configurations against equivalent disposable fixture state. Capture the source/program hash, selected execution representation, observation evidence, preview receipt, apply receipt, verification/readback, model and RPC counters, token/cost accounting, repair history, and cleanup outcome. Reset or clone the fixture between paired runs. Do not automatically retry apply after an uncertain outcome.

Freeze implementation before the independent reviewer selects holdout wording and seed. Keep reviewer-selected inputs out of generated program source and permanent product code.
