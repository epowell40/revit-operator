# Revit Operator

This repository contains the open-source core of Revit Operator. BIMTools also maintains a hosted/commercial deployment with managed infrastructure, authentication, updates, and proprietary skills. The open-source core is designed to run locally or in a self-hosted environment.

## Local Mode

Supported release targets are Revit 2023, 2024, and 2025 with Node.js 20+ for machines running the backend or MCP server.

Use local mode for development and self-host testing:

```text
REVIT_OPERATOR_MODE=local
OPERATOR_API_BASE_URL=http://127.0.0.1:7007
OPERATOR_HOSTED_ENABLED=false
```

Copy `.env.example` to a local `.env` file and fill only local values. Do not commit real `.env` files.

See [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) for the current local setup notes and [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for self-hosting guidance.

To use the Revit bridge from Codex, Claude Code, or another MCP-compatible agent without the Operator pane, see [docs/EXTERNAL_AGENT_HARNESS.md](docs/EXTERNAL_AGENT_HARNESS.md). The public helper generates host configuration, diagnoses the live bridge, and can issue deliberately bounded pane-free write grants.

## Validation

From the repository root, run the backend build and test suite with:

```powershell
npm --prefix apps/operator-backend run build
npm --prefix apps/operator-backend test
./scripts/check_backend_module_size.ps1
```

On a Windows development machine with Revit installed, compile against all installed supported API versions with:

```powershell
./scripts/deploy/check_revit_version_compatibility.ps1
```

Use `-SkipMissing` when intentionally validating a workstation that does not have every supported Revit version installed.

The module-size check applies a 1,200-line default to new TypeScript modules and fixed, documented non-growth ceilings to legacy exceptions.

## Repository Status

This repository now carries the first source migration from the private development repo: the local backend, Revit add-in bridge, MCP bridge, prompts, sample skills, and native redline/spatial placement tooling. Private hosted deployment, admin, customer, billing, and production auth pieces remain in `revit-operator-private`.

See [docs/PUBLIC_PRIVATE_BOUNDARY.md](docs/PUBLIC_PRIVATE_BOUNDARY.md) for the working split.

## License

The public core is licensed under the GNU Affero General Public License v3.0 or later.

BIMTools may offer separate commercial licenses for proprietary embedding, redistribution, hosted/commercial services, or closed-source integrations that do not want AGPL obligations.

## Custom Skills

Public sample skills belong under `skills/`. Machine-local private skills should live outside the repo, for example under `%LOCALAPPDATA%\RevitOperator\Skills\`.

## Hosted BIMTools Mode

Hosted/commercial deployment code, production config, billing/license gates, customer data, private skills, and deployment automation belong in `revit-operator-private`, not this repo.

## Contributions

During the migration phase, BIMTools welcomes bug reports, documentation suggestions, and issue discussion. Substantial external code contributions are paused until the contributor licensing process is finalized. See [CONTRIBUTING.md](CONTRIBUTING.md).
