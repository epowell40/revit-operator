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

## EPIC-0437 live Revit evidence sessions

The agent owns routine UI handling for an agent-launched EPIC-0437 certification session. Do not hand these test-session popups back to the user:

- After independently verifying the staged add-in DLLs and manifest, choose **Always Load** for Revit's unverified-publisher prompt.
- For the exact disposable Snowdon HVAC sample, dismiss the known model-open summary reporting `0 failures, 0 errors, 67 warnings` (unenclosed spaces) with **OK**.
- For that same disposable Snowdon HVAC sample, choose **Ignore and continue opening the project** when Revit reports the six known unresolved references.
- Launch/focus the installed Operator Desktop and handle ordinary readiness/write-grant UI required by the authorized evidence run.
- Codex owns these routine Revit/Operator interactions. Ask the user to click only when Windows moves an administrator-consent prompt to the secure desktop, which computer-use cannot access.

These instructions do not authorize accepting unrelated security/privacy prompts, opening or saving the installed original sample, weakening certification checks, or suppressing unknown model failures. Always verify the disposable model's canonical path and pristine hash before the run, preserve the crash-recovery journal, and restore or close-without-save/discard the disposable copy after any committed laboratory move.
