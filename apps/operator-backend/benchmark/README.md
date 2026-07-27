# Operator Benchmark Harness

This harness lives under `operator-backend` and compares Operator routing setups with latency and verified workflow success as primary metrics.

## Scope
- Config-driven task definitions in JSON
- Config-driven model/routing matrix
- `single_loop` and `split_planner_executor` modes
- Structured per-run and per-step artifacts
- Local normalized cost calculation
- Summary report generation
- Manual grading CSV export
- A default phased experiment plan
- Deterministic Revit workflow tasks for demo-readiness benchmarks

## Current Assumption
The shipped demo-readiness tasks use the `revit_workflow` adapter. By default they include mock bridge fixtures so the harness is runnable in CI and during local backend development. Mock runs are smoke tests only: `demo-readiness` requires live Revit workflow evidence and will fail mock-only batches with `no live Revit runs`. For a live Revit run, set `OPERATOR_BENCHMARK_USE_MOCKS=0` and provide model-specific request values through `OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON`. The CLI reads the active bridge URL from `REVIT_BRIDGE_URL`, `OPERATOR_REVIT_BRIDGE_URL`, `%LOCALAPPDATA%\RevitOperator\bridge_url.txt`, then finally `http://localhost:5000`; prefer leaving the env vars unset when using add-in fallback ports.

The sheet-export workflow performs an additional backend-side PDF inspection when exported files are readable from the benchmark process: combined PDFs must have the expected page count, per-sheet PDFs must be one page, and extractable text is checked for selected sheet identifiers where practical.

The takeoff workflow writes both `artifacts/takeoff_summary.csv` and `artifacts/takeoff_summary.md`; the user-facing workflow message includes a compact markdown table preview plus the CSV path.

The parameter-edit workflow writes `artifacts/parameter_change_summary.md` with target element ids, old values, requested values, and committed readback values before deciding whether verification passed.

The redline receptacle workflow writes `artifacts/redline_receptacles_summary.json` and `artifacts/redline_receptacles_summary.md` with requested placements, created element ids, before/after visible counts, audit payload, and mark/panel/circuit metadata when provided. For repeated live reliability runs, set `cleanupCreatedElements: true` in the live request override; after capture/audit evidence is recorded, the workflow will dry-run deletion, delete created test elements, and require deleted-id evidence so later repeats are not biased by previous test devices.

The MEP redline route workflow runs `/revit/mep-route-workflow` from a bounded ordered-point request and writes `artifacts/redline_mep_route_summary.json` plus `artifacts/redline_visual_gate.json`. It is stricter than a dry-run smoke test: success requires `AppliedVisualVerificationReady`, created duct/pipe element or fitting ids, planned points within tolerance, a focused post-change capture, and a passing redline visual gate. `demo_redline_mep_route` covers duct pickup and `demo_redline_mep_pipe_route` covers pipe pickup. For repeated live reliability runs, set `cleanupCreatedElements: true`; cleanup runs after the write and visual evidence are recorded, first proving the created route ids in a delete dry-run and then proving them again in the applied delete response.

The documentation primitives workflow runs bounded schedule creation, schedule configuration, sheet creation, drafting-view creation, view-template creation, view placement, detail-curve annotation, view/template visibility, text note, and tag operations. It writes `artifacts/documentation_primitives_summary.json` plus a markdown table and requires dry-run evidence where supported before mutating calls. Schedule configuration must prove the applied result targeted the schedule created in the same run, and visibility changes must prove the applied result targeted the created view or template. Live runs must provide at least one taggable element id for tag verification. For repeated live reliability runs, set `cleanupCreatedElements: true`; cleanup runs after all evidence is recorded, first proving created documentation ids in a delete dry-run and then proving them again in the applied delete response.

The model edit primitives workflow creates a disposable family instance, verifies move dry-run/apply evidence, verifies delete dry-run/apply evidence so repeated runs do not accumulate model clutter, then verifies `/revit/link-revit` dry-run/apply evidence and deletes the linked instance plus link type after capturing link ids. Live requests must provide a disposable RVT source path under the workspace or `OPERATOR_ALLOWED_EXTERNAL_ROOTS`; CAD linking does not satisfy the RVT-link requirement.

Live bridge calls also arm a bounded Revit-owned warning dialog dismiss guard. This is for modal recovery only, such as duplicate-schedule or warning dialogs that block the Revit API call. Dismissals are counted in each workflow result as `computer_use_actions` so benchmark evidence shows when computer-use recovery was needed.

## Task Definitions
Task files live in `operator-backend/benchmark/tasks/*.json`.

Each task supports:
- `task_id`
- `name`
- `description`
- `environment`
- `setup_instructions`
- `success_criteria`
- `failure_criteria`
- `max_time_seconds`
- `max_steps`
- `requires_manual_grade`
- `grader_notes`
- `tags`
- `optional_ground_truth_artifact`
- `optional_cleanup_steps`
- `adapter_config`

To add a new task, copy an existing JSON file and keep the same schema. The runner discovers tasks from disk.

## Config Definitions
Config files live in:
- `operator-backend/benchmark/configs/experiment_matrix.json`
- `operator-backend/benchmark/configs/escalation.json`
- `operator-backend/benchmark/configs/pricing.json`

To add a new config, edit only `experiment_matrix.json`.

## Prompt Templates
Prompt templates live in `operator-backend/benchmark/prompts/*.md`.

Planner and executor prompts are kept separate so routing logic stays inspectable and prompt tuning does not require code changes.

## Artifact Layout
```text
artifacts/benchmark_runs/<date>/<batch_id>/
  batch.json
  runs.jsonl
  reports/
    summary.md
    summary.json
  grading/
    manual_grades.csv
  <config_id>/
    <task_id>/
      repeat-01/
        run.json
        steps.jsonl
        summary.md
        raw_model_outputs/
        screenshots/
        observations/
```

## How To Run
From `operator-backend`:

```powershell
npm run benchmark -- list-tasks
npm run benchmark -- list-configs
npm run benchmark -- preflight-revit
npm run benchmark -- redline-hardening-scorecard
npm run benchmark -- redline-hardening-scorecard --input artifacts\redline-corpus\redline_corpus_classification.json --output-dir ..\local-work\redline-hardening-eval\corpus-smoke
npm run benchmark -- discover-revit-demo --output ..\local-work\demo-live-requests.json
npm run benchmark -- run --task placeholder_open_settings_panel --config single_54_medium
npm run benchmark -- run --task placeholder_open_settings_panel --all-configs
npm run benchmark -- run --all-tasks --all-configs --repeat 1
npm run benchmark -- run --tasks demo_sheet_export,demo_takeoff_receptacles,demo_parameter_edit,demo_redline_receptacles,demo_redline_mep_route,demo_redline_mep_pipe_route,demo_documentation_primitives,demo_model_edit_primitives --config deterministic_skill_only --repeat 1
npm run benchmark -- run --tasks demo_redline_mep_route --config deterministic_skill_only --repeat 5 --batch-id mep_route_redline_live_repeat
$env:OPERATOR_BENCHMARK_USE_MOCKS="0"; npm run benchmark -- run --tasks demo_sheet_export,demo_takeoff_receptacles,demo_parameter_edit,demo_redline_receptacles,demo_redline_mep_route,demo_redline_mep_pipe_route,demo_documentation_primitives,demo_model_edit_primitives --config deterministic_skill_only --repeat 5 --batch-id demo_readiness_live
$env:OPERATOR_BENCHMARK_USE_MOCKS="0"; npm run benchmark -- run --tasks demo_redline_receptacles --config deterministic_skill_only --repeat 10 --batch-id redline_receptacle_live_repeat
$env:OPERATOR_BENCHMARK_USE_MOCKS="0"; npm run benchmark -- run --tasks demo_redline_mep_route --config deterministic_skill_only --repeat 10 --batch-id mep_route_redline_live_repeat
$env:OPERATOR_BENCHMARK_USE_MOCKS="0"; npm run benchmark -- run --tasks demo_redline_mep_pipe_route --config deterministic_skill_only --repeat 10 --batch-id mep_pipe_route_redline_live_repeat
$env:OPERATOR_BENCHMARK_USE_MOCKS="0"; npm run benchmark -- run --tasks demo_documentation_primitives --config deterministic_skill_only --repeat 10 --batch-id documentation_primitives_live_repeat
$env:OPERATOR_BENCHMARK_USE_MOCKS="0"; npm run benchmark -- run --tasks demo_model_edit_primitives --config deterministic_skill_only --repeat 10 --batch-id model_edit_primitives_live_repeat
npm run benchmark -- run --tasks demo_takeoff_lighting,demo_takeoff_mechanical_equipment --config deterministic_skill_only --repeat 1 --batch-id demo_takeoff_supplemental
npm run benchmark -- report --artifacts-dir artifacts/benchmark_runs/2026-04-12/<batch_id>
npm run benchmark -- demo-readiness --artifacts-dir artifacts/benchmark_runs/2026-04-12/<batch_id>
npm run benchmark -- grade-sheet --artifacts-dir artifacts/benchmark_runs/2026-04-12/<batch_id>
npm run benchmark -- default-plan
```

Latest passing live demo gate on the demo machine:

```powershell
$env:OPERATOR_BENCHMARK_USE_MOCKS="0"
$env:OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON="C:\Users\User\source\repos\RevitOperator\local-work\demo-live-requests.json"
npm run benchmark -- run --tasks demo_sheet_export,demo_takeoff_receptacles,demo_parameter_edit,demo_redline_receptacles --config deterministic_skill_only --repeat 5 --batch-id demo_readiness_live_snowdon_electrical_modal_recovery
npm run benchmark -- demo-readiness --artifacts-dir artifacts\benchmark_runs\2026-05-15\demo_readiness_live_snowdon_electrical_modal_recovery
```

That batch used the Snowdon Towers Sample Electrical model through the live Revit bridge on `http://localhost:5010` and passed the earlier four-gate readiness set with 100% success and verification. Current readiness also requires `demo_redline_mep_route`, `demo_redline_mep_pipe_route`, `demo_documentation_primitives`, and `demo_model_edit_primitives`.

Live request overrides should live under an ignored path such as `local-work/demo-live-requests.json`. Generate a first pass from the open Revit model:

```powershell
npm run benchmark -- preflight-revit
npm run benchmark -- discover-revit-demo --output ..\local-work\demo-live-requests.json
```

Corpus-derived files named `redline_corpus_live_request_template.json` are fill-in scaffolds, not runnable overrides. Copy the generated template to a local override, replace every `__FILL_*` value with verified ids, points, types, levels, and paths from the currently open model, and only then use it as `OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON`. The benchmark environment rejects override files marked `template_requires_verified_revit_ids`, `ready_to_run=false`, `placeholder_count > 0`, or containing any `__FILL_*` placeholder.

Corpus classification also writes `redline_corpus_review.md`. Use that Markdown file as the first human triage surface for real PDF batches: review operation/target/context counts, evidence/model-write/visual-gate rollups, manual-review rows, the live queue preview, and the promotion rules before filling any local live override.

### Redline Hardening Scorecard

`redline-hardening-scorecard` evaluates corpus classification output without requiring a live Revit model. It reads the existing `redline_corpus_classification.json` shape, maps each classification row to a structured action record, checks whether the recommended benchmark task exists, and writes:

- `redline_hardening_scorecard.json`
- `redline_hardening_scorecard.md`

Run the synthetic fixture smoke test:

```powershell
npm run benchmark -- redline-hardening-scorecard
```

Run against a corpus classification report:

```powershell
npm run benchmark -- redline-hardening-scorecard --input ..\local-work\redline-corpus\redline_corpus_classification.json --output-dir ..\local-work\redline-hardening-eval\my-corpus
```

The scorecard reports total evaluated, classified-with-confidence, actionable, structured-action-produced, routed-to-existing-skill-or-benchmark-task, dry-run-possible, backend-ready-without-missing-inputs, executable, needs-human-review, not-actionable, top failure clusters, and top missing skills. `dry_run_possible` means the row maps to an existing benchmark task or workflow that can be evaluated with fixtures/mocks. `backend_ready_without_missing_inputs` means the classification queue did not report missing live inputs, but the row still is not a runnable Revit override by itself. `executable` is reserved for promoted runnable overrides that explicitly report `ready_to_run:true`. This is backend eval evidence only; it is not live Revit GUI proof.

Before a corpus-derived file is used for a live run, validate it without touching Revit:

```powershell
npm run benchmark -- validate-revit-requests --input ..\local-work\demo-live-requests-from-corpus.json
```

For add-tag redlines, fill compatible tag type evidence from the open model before validating or running. This command is read-only against Revit and writes a separate hydrated override; it does not mark the row executable:

```powershell
npm run benchmark -- hydrate-redline-add-tag-types --input ..\local-work\redline-hardening-eval\add-tag-space-live-requests-20260707.json --output ..\local-work\redline-hardening-eval\add-tag-space-live-requests-hydrated-20260707.json
npm run benchmark -- validate-revit-requests --input ..\local-work\redline-hardening-eval\add-tag-space-live-requests-hydrated-20260707.json
```

Set `REVIT_BRIDGE_URL` only when you intentionally need to override the bridge URL. If the add-in had to avoid an occupied `5000` port, it writes the fallback URL to `%LOCALAPPDATA%\RevitOperator\bridge_url.txt`, and the CLI will pick that up automatically.

`preflight-revit` returns a structured `diagnosis`:
- `ok`: the bridge is ready for discovery and live benchmark runs.
- `wrong_service`: something is listening at `REVIT_BRIDGE_URL`, but it is not the Operator Revit bridge.
- `unreachable`: the URL cannot be reached.
- `auth_or_endpoint_failure`: the URL responded, but `/revit/ping` or `/revit/context` did not pass.

On Windows localhost URLs, the report also includes `local_port_owner` when available so a blocked demo setup can identify which process owns the configured port.

When `OPERATOR_BENCHMARK_USE_MOCKS=0`, `run` and `default-plan` fail fast if Revit workflow tasks are selected and `preflight-revit` is not healthy. Use `--skip-revit-preflight` only when intentionally collecting failure-mode evidence.

After a live batch, run `demo-readiness` against the batch artifact directory. It regenerates the report and exits nonzero unless all eight demo readiness gates pass. Each gate reports `live_sample_size` and `min_live_sample_size`, and the gate cannot pass unless at least 5 live Revit runs are present for that workflow.

The Revit add-in writes the active bridge URL to `%LOCALAPPDATA%\RevitOperator\bridge_url.txt` after it starts. The benchmark CLI checks `REVIT_BRIDGE_URL`, then `OPERATOR_REVIT_BRIDGE_URL`, then that file, then `http://localhost:5000`. If port `5000` is occupied, the add-in tries fallback ports `5010-5030`; customize with `OPERATOR_REVIT_BRIDGE_FALLBACK_PORTS`.

`preflight-revit` also probes the fallback URLs when no explicit healthy URL is found. Its JSON output includes `checked_bridge_urls`, so a blocked setup shows whether the add-in is absent from every expected port or just hidden behind a stale URL.

Then review the generated selectors. You can also start from `operator-backend/benchmark/configs/demo_live_requests.example.json` and replace the placeholder ids/selectors manually:

```json
{
  "tasks": {
    "demo_sheet_export": {
      "request": {
        "sheetNumberPrefix": "E1",
        "outputFolder": "C:\\Users\\User\\Desktop\\Operator Demo",
        "baseFileName": "AEC_Demo_Selected_Sheets.pdf"
      }
    },
    "demo_parameter_edit": {
      "request": {
        "elementIds": [123456],
        "parameterName": "Comments",
        "value": "DEMO VERIFIED"
      }
    }
  }
}
```

Set it before live runs:

```powershell
$env:OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON="C:\Users\User\source\repos\RevitOperator\local-work\demo-live-requests.json"
npm run benchmark -- preflight-revit
```

### MEP Route Live GUI Test Plan
Use this plan after the Revit GUI, target demo model, and Operator add-in are open. It verifies modeled duct/pipe redline pickup without letting repeated runs accumulate route elements.

1. In Revit, open the target model to the view or sheet referenced by the live request override. Confirm the redline route area is visible and no modal dialog or model-upgrade progress is blocking the canvas.
2. Run:
   ```powershell
   npm run benchmark -- preflight-revit
   ```
   Continue only when `ok` is true.
3. Generate or review `local-work/demo-live-requests.json`. The `demo_redline_mep_route` and `demo_redline_mep_pipe_route` requests must include real view ids, ordered model-space `points`, `apply: true`, `visualVerify: true`, and `cleanupCreatedElements: true`.
4. Run at least five live repeats for duct and pipe:
   ```powershell
   $env:OPERATOR_BENCHMARK_USE_MOCKS="0"
   $env:OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON="C:\Users\User\source\repos\RevitOperator\local-work\demo-live-requests.json"
   npm run benchmark -- run --tasks demo_redline_mep_route,demo_redline_mep_pipe_route --config deterministic_skill_only --repeat 5 --batch-id mep_route_live_repeat
   ```
5. As a human tester in the Revit GUI, inspect the active view after the batch. The temporary duct/pipe/fitting elements created by the benchmark should not remain after cleanup, and the view should not be left in a modal or failed transaction state.
6. Inspect each `redline_mep_route_summary.json` and `redline_visual_gate.json`. Each run must include created model ids, focused capture path, passing visual gate, `cleanupDryRunIds`, and `cleanupDeletedIds` covering every created route/fitting id.
7. Run:
   ```powershell
   npm run benchmark -- demo-readiness --artifacts-dir artifacts\benchmark_runs\<date>\mep_route_live_repeat
   ```
   The route gates are not ready unless they have at least five live Revit runs and all model-write, visual-gate, planned-point, cleanup dry-run, and applied cleanup checks pass.

### Model Edit Primitives Live GUI Test Plan
Use this plan after the Revit GUI, demo model, and Operator add-in are open. It verifies the model-edit benchmark without letting repeat runs accumulate linked models.

1. Open Revit with the target demo model visible, confirm the Operator add-in bridge is running, and run:
   ```powershell
   npm run benchmark -- preflight-revit
   ```
   Continue only when `ok` is true.
2. Configure `demo_model_edit_primitives` in `local-work\demo-live-requests.json` with a disposable family instance request and an RVT `linkRevit.sourcePath` under the workspace or `OPERATOR_ALLOWED_EXTERNAL_ROOTS`.
3. Run the live repeat batch:
   ```powershell
   $env:OPERATOR_BENCHMARK_USE_MOCKS="0"
   $env:OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON="C:\Users\User\source\repos\RevitOperator\local-work\demo-live-requests.json"
   npm run benchmark -- run --tasks demo_model_edit_primitives --config deterministic_skill_only --repeat 5 --batch-id model_edit_primitives_live_repeat
   ```
4. As a human tester in the Revit GUI, inspect Manage Links and the active/project views after the batch. The linked RVT instance and loaded RVT link type created during each run must not remain in the model. The disposable family instance should also be gone.
5. Open one run artifact and confirm `model_edit_primitives_summary.json` includes `requestedFamilyInstanceType`, `createdFamilyInstanceLabels`, `linkInstanceId`, `linkTypeId`, `linkCleanupDeletedIds`, `linkTypeCleanupDeletedIds`, and `"revitLinkStatus": "linked_then_cleaned_up"`.
6. Run:
   ```powershell
   npm run benchmark -- demo-readiness --artifacts-dir artifacts\benchmark_runs\<date>\model_edit_primitives_live_repeat
   ```
   The gate is not ready unless it has at least five live Revit runs and all required add/type-match/move/delete/link/cleanup checks pass.

## Default Experiment Plan
`default-plan` runs the eight demo-readiness workflows across the configured GPT-5.5, mini-executor, and deterministic skill-only matrix.

The supplemental takeoff tasks `demo_takeoff_lighting` and `demo_takeoff_mechanical_equipment` are not demo readiness gates. Run them when the current model contains lighting fixtures or mechanical equipment/VAV boxes to gather broader Demo B evidence.

Use `--include-broader-phase` to add the broader mini-only comparison.

## Latency And Cost Computation
Per run, the harness records:
- total wall-clock latency
- total model latency
- total tool latency
- average latency per model call
- average latency per executor step
- time to first meaningful action
- time spent in replanning/escalation
- time lost to retries
- steps per minute
- successful tasks per hour equivalent

Per config, the report adds:
- p50/p95 latency when sample size allows
- relative speedup versus baseline
- cost-normalized success
- latency-normalized success

Cost is always computed locally from `pricing.json`, even if upstream usage APIs later expose cost directly. If token counts are missing from the API response, the harness estimates tokens from text length and marks the run as estimated.

## Manual Grading Workflow
Runs that require manual review still produce `run.json`, `steps.jsonl`, and `summary.md`.

Export the grading sheet with:

```powershell
npm run benchmark -- grade-sheet --artifacts-dir artifacts/benchmark_runs/2026-04-12/<batch_id>
```

Allowed manual grades:
- `success`
- `partial`
- `fail`
- `invalid_run`

## What The Initial Recommendation Tests
The first batch is designed to answer whether deterministic skill-only execution is sufficient for known demo inputs, and whether a GPT-5.5 planner with a lower-latency executor can resolve ambiguous setup prompts without losing verified workflow success.

The most important signals are:
- relative speedup vs baseline
- success rate delta vs baseline
- time to first meaningful action
- replanning/escalation overhead
- retry overhead
- cost per successful run
