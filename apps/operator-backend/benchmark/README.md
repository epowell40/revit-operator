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

The redline receptacle workflow writes `artifacts/redline_receptacles_summary.json` and `artifacts/redline_receptacles_summary.md` with requested placements, created element ids, before/after visible counts, audit payload, and mark/panel/circuit metadata when provided. For repeated live reliability runs, set `cleanupCreatedElements: true` in the live request override; the workflow will delete created test elements after capture/audit and record a cleanup verification so later repeats are not biased by previous test devices.

The AEC-MEP eval V1 tasks use the same `revit_workflow` adapter with `workflow: "aec_mep_eval"`. They cover duct route pickup from vector PDF geometry, pipe route pickup from labeled redline geometry, callout-only duct verification, wrong-bay/one-axis false positives, connected duct resize verification, and branch/tee/tap feasibility. Each run writes `artifacts/<scenario>_summary.json` and `artifacts/<scenario>_summary.md`, and failed runs include `failure_classification` in `revit_workflow_result.json` and the benchmark report.

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
npm run benchmark -- discover-revit-demo --output ..\local-work\demo-live-requests.json
npm run benchmark -- run --task placeholder_open_settings_panel --config single_54_medium
npm run benchmark -- run --task placeholder_open_settings_panel --all-configs
npm run benchmark -- run --all-tasks --all-configs --repeat 1
npm run benchmark -- run --tasks demo_sheet_export,demo_takeoff_receptacles,demo_parameter_edit,demo_redline_receptacles --config deterministic_skill_only --repeat 1
$env:OPERATOR_BENCHMARK_USE_MOCKS="0"; npm run benchmark -- run --tasks demo_sheet_export,demo_takeoff_receptacles,demo_parameter_edit,demo_redline_receptacles --config deterministic_skill_only --repeat 5 --batch-id demo_readiness_live
$env:OPERATOR_BENCHMARK_USE_MOCKS="0"; npm run benchmark -- run --tasks demo_redline_receptacles --config deterministic_skill_only --repeat 10 --batch-id redline_receptacle_live_repeat
npm run benchmark -- run --tasks aec_mep_duct_route_vector_pdf,aec_mep_pipe_route_labeled_redline,aec_mep_duct_callout_existing_model,aec_mep_wrong_bay_false_positive,aec_mep_connected_duct_resize,aec_mep_branch_tee_tap_feasibility --config deterministic_skill_only --repeat 1 --batch-id aec_mep_eval_v1_mock
npm run benchmark -- aec-mep-readiness --artifacts-dir artifacts/benchmark_runs/2026-04-12/<batch_id> --allow-mock
npm run benchmark -- run --tasks demo_takeoff_lighting,demo_takeoff_mechanical_equipment --config deterministic_skill_only --repeat 1 --batch-id demo_takeoff_supplemental
npm run benchmark -- report --artifacts-dir artifacts/benchmark_runs/2026-04-12/<batch_id>
npm run benchmark -- demo-readiness --artifacts-dir artifacts/benchmark_runs/2026-04-12/<batch_id>
npm run benchmark -- aec-mep-readiness --artifacts-dir artifacts/benchmark_runs/2026-04-12/<batch_id>
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

That batch used the Snowdon Towers Sample Electrical model through the live Revit bridge on `http://localhost:5010` and passed all four readiness gates with 100% success and verification.

Live request overrides should live under an ignored path such as `local-work/demo-live-requests.json`. Generate a first pass from the open Revit model:

```powershell
npm run benchmark -- preflight-revit
npm run benchmark -- discover-revit-demo --output ..\local-work\demo-live-requests.json
```

Set `REVIT_BRIDGE_URL` only when you intentionally need to override the bridge URL. If the add-in had to avoid an occupied `5000` port, it writes the fallback URL to `%LOCALAPPDATA%\RevitOperator\bridge_url.txt`, and the CLI will pick that up automatically.

`preflight-revit` returns a structured `diagnosis`:
- `ok`: the bridge is ready for discovery and live benchmark runs.
- `wrong_service`: something is listening at `REVIT_BRIDGE_URL`, but it is not the Operator Revit bridge.
- `unreachable`: the URL cannot be reached.
- `auth_or_endpoint_failure`: the URL responded, but `/revit/ping` or `/revit/context` did not pass.

On Windows localhost URLs, the report also includes `local_port_owner` when available so a blocked demo setup can identify which process owns the configured port.

When `OPERATOR_BENCHMARK_USE_MOCKS=0`, `run` and `default-plan` fail fast if Revit workflow tasks are selected and `preflight-revit` is not healthy. Use `--skip-revit-preflight` only when intentionally collecting failure-mode evidence.

After a live batch, run `demo-readiness` against the batch artifact directory. It regenerates the report and exits nonzero unless all four demo readiness gates pass. Each gate reports `live_sample_size` and `min_live_sample_size`, and the gate cannot pass unless at least 5 live Revit runs are present for that workflow.

The Revit add-in writes the active bridge URL to `%LOCALAPPDATA%\RevitOperator\bridge_url.txt` after it starts. The benchmark CLI checks `REVIT_BRIDGE_URL`, then `OPERATOR_REVIT_BRIDGE_URL`, then that file, then `http://localhost:5000`. If port `5000` is occupied, the add-in tries fallback ports `5010-5014`; customize with `OPERATOR_REVIT_BRIDGE_FALLBACK_PORTS`.

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

### AEC-MEP Eval V1 Live Gate
Live AEC-MEP overrides should live under `apps/operator-backend/local-work/` when running from this public checkout. Start from `apps/operator-backend/local-work/aec-mep-eval-live-requests.example.json`, replace ids/points with values from the open model, and keep the file uncommitted.

```powershell
cd C:\Users\User\source\repos\RevitOperator\public\apps\operator-backend
$env:OPERATOR_BENCHMARK_USE_MOCKS="0"
$env:OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON="C:\Users\User\source\repos\RevitOperator\public\apps\operator-backend\local-work\aec-mep-eval-live-requests.json"
npm run benchmark -- preflight-revit
npm run benchmark -- run --tasks aec_mep_duct_route_vector_pdf,aec_mep_pipe_route_labeled_redline,aec_mep_duct_callout_existing_model,aec_mep_wrong_bay_false_positive,aec_mep_connected_duct_resize,aec_mep_branch_tee_tap_feasibility --config deterministic_skill_only --repeat 1 --batch-id aec_mep_eval_v1_live
npm run benchmark -- aec-mep-readiness --artifacts-dir artifacts/benchmark_runs/<yyyy-mm-dd>/aec_mep_eval_v1_live
```

`aec-mep-readiness` fails unless all six tasks have passing `aec_mep_eval` workflow evidence. By default it requires live Revit workflow runs; use `--allow-mock` only for local replay smoke checks. The gate still does not replace the project rule requiring a real GUI Revit inspection before claiming the feature is ready for user testing.

## Default Experiment Plan
`default-plan` runs the four demo-readiness workflows across the configured GPT-5.5, mini-executor, and deterministic skill-only matrix.

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
