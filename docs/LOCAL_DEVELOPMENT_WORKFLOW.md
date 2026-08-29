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

Public-core validation commonly includes:

```powershell
npm --prefix apps/operator-backend run build
npm --prefix apps/operator-backend test
npm --prefix apps/mcp-server run build
./scripts/check_backend_module_size.ps1
./scripts/deploy/check_revit_version_compatibility.ps1
```

Run the smallest relevant tests after each edit and the complete applicable
local gate before the consolidated push. Changes that affect the add-in,
Sidecar, operations, or user-visible behavior also require a real local Revit UI
test against an authorized disposable fixture.

Hosted authentication, private deployment, EC2, production packaging, and
commercial integration are owned by `revit-operator-private`. Do not add those
details or secrets to this repository.
