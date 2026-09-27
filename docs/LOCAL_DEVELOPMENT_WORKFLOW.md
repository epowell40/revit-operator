# Local-first development workflow

The public Revit Operator core uses a local-first development loop.

1. Keep one coherent feature or repair batch on one branch.
2. Preserve useful checkpoints with local Git commits.
3. Build, test, restart, and exercise the local Revit workflow as many times as
   needed without pushing every experiment.
4. Do not create a PR per candidate or use GitHub Actions as the inner test
   loop.
5. After the complete batch passes applicable local deterministic and Revit UI
   validation, make one consolidated push and open or update one PR.
6. Required PR CI validates the release candidate. A second full CI run on the
   merge push to `main` is intentionally not part of the workflow.

The normal local endpoint is `http://127.0.0.1:7007`. Keep local services bound
to loopback unless a self-hosting task explicitly requires another reviewed
network configuration.

Architecture qualification must start the backend with
`OPERATOR_ASSIGNMENT_KERNEL_V2=1`. Shared-token mode remains a single local
trust boundary; the backend binds those Assignments to the stable,
credential-free principal identifier `local:shared-token`. Hosted JWT sessions
continue to bind to a versioned, tenant-qualified digest of the authenticated
principal. Omitting the V2 flag is only appropriate when intentionally
replaying the historical V1 lifecycle.

## Native-UI developer beta profile

An explicitly selected local profile lets new document-bound V2 tasks use the
bounded Codex backend executor from the ordinary composer without adding each
session to an experiment allowlist. Configure the backend process only:

```dotenv
OPERATOR_LOCAL_EXECUTOR_PROFILE=codex_v2_advisory_v1
REVIT_OPERATOR_MODE=development
OPERATOR_TOOL_EXPOSURE_PROFILE=laboratory
OPERATOR_BRAIN=codex
OPERATOR_ASSIGNMENT_KERNEL_V2=1
OPERATOR_AUTH_MODE=shared_token
OPERATOR_API_BASE_URL=http://127.0.0.1:7007
OPERATOR_HOSTED_ENABLED=false
```

Use the existing authenticated local shared token; do not commit it. Keep
services on loopback and do not pass these backend profile values into the
Revit process. Selection requires the existing ready development/laboratory
profile. The default `local` mode alone does not enable it; hosted principals,
remote origins and hosted mode/flags cannot select it. Outside this explicit
profile, existing routing and experiment allowlists remain unchanged.

The authenticated backend advertises `local_executor` for executor selection.
It is not a CLI/provider readiness check or native write authorization. Use
the supported pinned Codex CLI and the existing deterministic and actual Revit
UI qualification steps before claiming the profile qualified.

New assignments keep their policy, document binding and bounded cumulative
budgets in the existing journal. Disabling the profile later does not rewrite
saved assignments. Pause, steering and checkpoint follow-up use that same task;
explicit Pause stays paused until Resume. Completion checkpoints remain
unverified claims. Native admission, transaction settlement and unknown-effect
reconciliation remain enforced. The profile is opt-in and changes no defaults.

Public-core validation commonly includes:

```powershell
npm --prefix apps/operator-backend run build
npm --prefix apps/operator-backend test
npm --prefix apps/mcp-server run build
./scripts/run_release_frontier_gate.ps1
./scripts/check_backend_module_size.ps1
./scripts/deploy/check_revit_version_compatibility.ps1
```

Run the smallest relevant tests after each edit and the complete applicable
local gate before the consolidated push. Changes that affect the add-in,
Sidecar, operations, or user-visible behavior also require a real local Revit UI
test against an authorized disposable fixture.

## Disposable local experiments

Explicitly opt into this lane for a concrete, time-bounded hypothesis on an
authorized disposable sample. It does not qualify a release. Keep one Revit
mutation owner, a fixed task, the original failed trace and an independent
inspection of the resulting model. Measure delivered work and intervention.

For each changed experiment, build only the affected components and run their
focused failing-before/neighboring tests plus:

```powershell
./scripts/run_local_experiment_smoke.ps1 -DisposableExperiment `
  -BackendTest existing_conditions_registered_route_connector_snap.test.ts `
  -RevitYear 2024
```

The runner builds the owning composition's backend and runs existing mandatory
authorization/document-binding, effect/transaction, unknown-retry and
pause/cancel tests, plus selected native safety classes for the specified Revit
runtime. `-BackendTest` takes additional relevant filenames; `-NativeTestClass`
adds affected native classes. Test changed MCP/Desktop or other components
separately. `-ListTests` lists the selection without running it. The runner
does not launch, install, deploy, contact a model, or check a live fixture.

Before live work, retain source revisions and the working-tree patch/untracked
source, actual runtime/model settings, installed payload hashes and process
paths, and source PDF/fixture hashes in the existing local run directory. A
dirty tree is allowed for an experiment; its SHA alone is insufficient.
Runtime-required trust/policy checks remain enforced; never bypass stale
certification or label experimental output qualified.

Verify the exact disposable host via native health. Linked-model experiments
must include one loaded exact-sibling Architectural RVT, verified by canonical
path and source identity after reopening, not just its display name. Retain
that readback. Preserve hidden grading data outside drafting inputs. Inspect
actual geometry and connections, and reconcile unknown effects before retry.
Pause/cancel must let an already running native transaction settle. Release
persistent computer-capture ownership between inspection and timed work.

Both complete historical frontiers belong at a coherent batch checkpoint,
before claiming that slice is regression-clean, rather than before every
disposable geometry experiment. Preserve failures immediately and add reusable
regressions plus neighboring boundary coverage by that checkpoint. The lane
does not permit customer/production models, hosted testing or publication;
keep loopback services and native authorization, exact-document checks,
transaction truth and durable operation records intact.

## Batch and release qualification

Raw test count does not prove cross-process coherence. Before a qualification candidate,
the machine-readable `scripts/release_frontier.v1.json` selects historical
failure families across backend, MCP, and native boundaries; every family must
name at least two tests that actually execute in this public composition. Add a
new generic replay and neighboring boundary coverage whenever live testing
finds a new failure family. Run the frontier at the coherent batch checkpoint, the complete private
integration gate once from stable source, and the real Revit UI last.

The live capability runner also verifies every candidate-envelope identity it
can reproduce before contacting Sidecar or opening a fixture. A new run must
bind the clean owning Git revision, the private public-core pin when applicable,
the exact certification/exposure policy bytes, canonical corpus and selected
case hashes, original manifest bytes, evaluator and fixture-adapter versions,
requested model settings, and selected `.rvt` bytes. Do not hand-copy hashes
from an older candidate. Runtime-only claims such as the installed process and
Revit version remain subject to checks at their authoritative runtime boundary.
Historical rescore-only runs keep their retained envelope and do not acquire
the identity of the current checkout.

Hosted authentication, private deployment, EC2, production packaging, and
commercial integration are owned by `revit-operator-private`. Do not add those
details or secrets to this repository.

## Durable task regression coverage

Normal chat admission must be exercised with V2 enabled, without constructing
benchmark-specific Goals. Automatic admission creates one outcome criterion;
explicit multi-criterion Goals require distinct semantic fact contracts.

Session discovery derives V2 identity and outcome from durable Goal journals.
Independent index files are compatibility artifacts and may be absent or stale
after a crash. Recovery tests must start a fresh process and include a task
outside the general history page.

The progress budget's `max_wall_clock_ms` measures cumulative active execution
time, using the union of durable provider and operation intervals. Completed
work retains its cost across restart; idle time does not consume allowance.
Unsettled admitted work continues to count, and provider, token, operation, and
no-progress limits remain cumulative. This does not grant automatic unlimited
budget renewal or authorize replay of an operation with unknown effects.

## Revit ribbon and the local desktop launcher

When running a local Desktop checkout alongside an installed package, register
the matching `launch_operator_desktop.ps1` with
`scripts/register_local_desktop_launcher.ps1 -LauncherPath <absolute-path>`.
This sets the existing per-user `OPERATOR_DESKTOP_LAUNCHER_PATH` override that
Revit checks before the installed release shim. Registration validates the
file before replacing the setting and does not launch or stop any process.
The integration checkpoint script registers its successfully started default
port 3907 launcher automatically. Custom-port sessions do not replace that
default ribbon target.

Use a new Revit process for deterministic first-click qualification: an
already-open Revit session can use its cached path once before refreshing it.
When deliberately returning to an installed package, clear the user override
and restart Revit so normal installed-launcher discovery resumes. Do not relax
Sidecar ownership checks to resolve a local-versus-installed path mismatch.
