# Contributing

Thank you for helping improve Revit Operator.

Public contributions should target local, self-hosted, and generic Revit automation functionality. Do not include secrets, customer data, production deployment details, billing/licensing code, or hosted-only business logic.

## Current Contribution Policy

Revit Operator is in an early public-core migration phase. We welcome:

- Bug reports.
- Documentation suggestions.
- Repro steps for local/self-host issues.
- Discussion about public APIs, setup, and skill workflows.

For now, BIMTools is not accepting substantial external code contributions until the public/private boundary and contributor licensing process are finalized.

This keeps the AGPL public core and future commercial licensing path clear while the project structure settles.

Before opening a PR:

- Run relevant tests/builds.
- Run `scripts/check-secrets.sh`.
- Confirm any config changes are represented only as safe examples.

Small documentation fixes may be accepted at BIMTools' discretion. Larger patches may be deferred until a Contributor License Agreement or other contribution policy is in place.
