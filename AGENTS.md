# Public Revit Operator Core

This is the public open-source core. Do not add secrets, private deployment config, customer data, billing/licensing code, production endpoint credentials, or hosted-only business logic here.

Use this repo for local/self-host/open-source functionality:

- Revit add-in shell
- Operator UI
- Local backend
- Skill runtime
- Generic Revit API tools
- Sample skills
- Public docs and tests

Code should switch behavior by runtime mode/configuration, not by repository identity.

Default public-safe modes:

```text
REVIT_OPERATOR_MODE=local
REVIT_OPERATOR_MODE=self_hosted
REVIT_OPERATOR_MODE=development
```

If a change touches hosted auth, billing, licensing, customer data, production deployments, telemetry, file storage, or secrets, default to the private repo unless the user explicitly says to open-source it.

This public core is AGPL-3.0-or-later. Commercial licensing is handled separately by BIMTools and should not be implemented by adding proprietary restrictions to the public license.
