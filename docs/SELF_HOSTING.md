# Self Hosting

Self-hosted deployments should use public-safe configuration and avoid BIMTools hosted assumptions.

Recommended mode:

```text
REVIT_OPERATOR_MODE=self_hosted
OPERATOR_HOSTED_ENABLED=false
```

Production secrets should be injected by your host environment and should never be committed.

## Hosted Features

The BIMTools hosted deployment adds managed infrastructure, authentication, updates, proprietary skills, and commercial support. Those pieces are intentionally separate from the public core.

The public core should stay usable in local or self-hosted mode without depending on `operator.bimtools.com`, AWS-specific deployment scripts, customer data, or private billing/licensing code.
