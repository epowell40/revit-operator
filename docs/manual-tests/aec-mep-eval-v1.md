# AEC-MEP Eval V1 Manual Acceptance

## Scope
This manual test validates the public benchmark tasks for:
- duct route pickup from vector PDF geometry
- pipe route pickup from labeled redline geometry
- callout-only duct verification
- wrong-bay / one-axis false-positive blocking
- connected duct resize verification
- branch/tee/tap feasibility

## Public Benchmark Tasks
- `aec_mep_duct_route_vector_pdf`
- `aec_mep_pipe_route_labeled_redline`
- `aec_mep_duct_callout_existing_model`
- `aec_mep_wrong_bay_false_positive`
- `aec_mep_connected_duct_resize`
- `aec_mep_branch_tee_tap_feasibility`

## Mock Replay
From `C:\Users\User\source\repos\RevitOperator\public\apps\operator-backend`:

```powershell
npm run benchmark -- run --tasks aec_mep_duct_route_vector_pdf,aec_mep_pipe_route_labeled_redline,aec_mep_duct_callout_existing_model,aec_mep_wrong_bay_false_positive,aec_mep_connected_duct_resize,aec_mep_branch_tee_tap_feasibility --config deterministic_skill_only --repeat 1 --batch-id aec_mep_eval_v1_mock
npm run benchmark -- aec-mep-readiness --artifacts-dir artifacts/benchmark_runs/<yyyy-mm-dd>/aec_mep_eval_v1_mock --allow-mock
```

## Live Revit Run
Create a local override at:

```text
C:\Users\User\source\repos\RevitOperator\public\apps\operator-backend\local-work\aec-mep-eval-live-requests.json
```

Then run:

```powershell
cd C:\Users\User\source\repos\RevitOperator\public\apps\operator-backend
$env:OPERATOR_BENCHMARK_USE_MOCKS="0"
$env:OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON="C:\Users\User\source\repos\RevitOperator\public\apps\operator-backend\local-work\aec-mep-eval-live-requests.json"
npm run benchmark -- preflight-revit
npm run benchmark -- run --tasks aec_mep_duct_route_vector_pdf,aec_mep_pipe_route_labeled_redline,aec_mep_duct_callout_existing_model,aec_mep_wrong_bay_false_positive,aec_mep_connected_duct_resize,aec_mep_branch_tee_tap_feasibility --config deterministic_skill_only --repeat 1 --batch-id aec_mep_eval_v1_live
npm run benchmark -- aec-mep-readiness --artifacts-dir artifacts/benchmark_runs/<yyyy-mm-dd>/aec_mep_eval_v1_live
```

## Acceptance
- `aec-mep-readiness` exits zero without `--allow-mock`.
- Each task has live `execution_source:"live"` evidence.
- Every verification in each `revit_workflow_result.json` passes.
- No `failure_classification` is present in the passing live gate.
- The route and resize cases include post-change capture paths when apply is enabled.
- A human/GUI Revit check is performed against the active view/captures before any "ready for user testing" claim.

If GUI computer-use or Revit access is unavailable, report the blocker and do not claim full readiness.
