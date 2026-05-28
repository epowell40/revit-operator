# Policy: File I/O

## Workspace-first
- Prefer reading/writing under the user workspace root.
- Use workspace-relative paths in user-facing messages (e.g. `artifacts/prints/...`) unless an absolute path is required by the system.

## Artifacts
- When exporting or generating artifacts, place them under `artifacts/` with clear subfolders (e.g. `artifacts/prints/`, `artifacts/issue-bundles/`).
- Never overwrite user artifacts unless explicitly requested; prefer timestamped filenames.

## Run bundles
- A run bundle is an immutable folder capturing inputs, tool I/O, and verification artifacts.
- Use append-only JSONL logs for durability.

