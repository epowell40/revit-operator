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

## Repository Status

This is a prepared migration skeleton. Source code should be copied from the current private `RevitOperator` repo only after public/private review and secret scanning.

## License

The public core is licensed under the GNU Affero General Public License v3.0 or later.

BIMTools may offer separate commercial licenses for proprietary embedding, redistribution, hosted/commercial services, or closed-source integrations that do not want AGPL obligations.

## Custom Skills

Public sample skills belong under `skills/`. Machine-local private skills should live outside the repo, for example under `%LOCALAPPDATA%\RevitOperator\Skills\`.

## Hosted BIMTools Mode

Hosted/commercial deployment code, production config, billing/license gates, customer data, private skills, and deployment automation belong in `revit-operator-private`, not this repo.
