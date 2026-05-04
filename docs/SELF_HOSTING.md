# Self Hosting

Self-hosted deployments should use public-safe configuration and avoid BIMTools hosted assumptions.

Recommended mode:

```text
REVIT_OPERATOR_MODE=self_hosted
OPERATOR_HOSTED_ENABLED=false
```

Production secrets should be injected by your host environment and should never be committed.
