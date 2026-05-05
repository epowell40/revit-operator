# Local Setup

This repository is in the public-core migration phase. The local/self-host source packages are not fully migrated yet, so these instructions describe the intended public setup and the configuration conventions that are already stable.

## Configuration

Copy `.env.example` to `.env` on your machine and keep `.env` uncommitted.

Recommended local defaults:

```text
REVIT_OPERATOR_MODE=local
OPERATOR_API_BASE_URL=http://127.0.0.1:7007
OPERATOR_HOSTED_ENABLED=false
```

Optional local paths:

```text
OPERATOR_WORKSPACE_ROOT=%LOCALAPPDATA%\RevitOperator\Workspace
OPERATOR_LOCAL_SKILLS_DIR=%LOCALAPPDATA%\RevitOperator\Skills
```

## Expected Components

The public core is intended to include:

- Revit add-in shell.
- Local backend/server.
- Operator UI.
- Skill runtime.
- Public sample skills.
- Generic Revit API tool/action framework.

As each component is migrated, this file will gain the exact build and run commands for that package.

## Current Status

The public repo currently contains the open-core structure, license, configuration examples, security rules, and setup documentation. Production hosted functionality remains in BIMTools' private/commercial repo.

Do not commit real `.env` files.
