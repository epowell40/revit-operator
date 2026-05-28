# Revit Operator

This repository contains the open-source core of Revit Operator. BIMTools also maintains a hosted/commercial deployment with managed infrastructure, authentication, updates, and proprietary skills. The open-source core is designed to run locally or in a self-hosted environment.

## Local Mode

Use local mode for development and self-host testing:

```text
REVIT_OPERATOR_MODE=local
OPERATOR_API_BASE_URL=http://127.0.0.1:7007
OPERATOR_HOSTED_ENABLED=false
```

Copy `.env.example` to a local `.env` file and fill only local values. Do not commit real `.env` files.

See [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) for the current local setup notes and [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for self-hosting guidance.

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
