# Repo-Shipped Skills

This folder contains concise, versioned skill docs that are safe to ship with the open-source repo.

## Purpose
- Keep skill routing deterministic across machines/clones.
- Keep prompts compact and task-oriented.
- Separate stable shared skills from local/private preferences.

## Required structure
Every `skills/workflows/*.md` and `skills/runbooks/*.md` file should include these headings in order:
1. `Goal`
2. `Use when`
3. `Do not use when`
4. `Required inputs`
5. `Execution steps`
6. `Success criteria`
7. `Failure handling`
8. `Examples`

## Authoring rules
- One workflow per file.
- Keep language directive and specific.
- Use concrete tool names and minimal request-shape hints.
- Include at least two realistic natural-language examples.
- Keep docs concise; avoid long narrative and duplicated policy text.
- Avoid secrets, client-specific data, and machine-local assumptions.
- Prefer references to shared policy docs over copying policy content.

## Scope boundaries
- Shared defaults:
  - `prompts/` for global rules/persona/policies.
  - `skills/` for workflows/runbooks/assets.
- Private/local instructions:
  - `%LOCALAPPDATA%\\RevitOperator\\Skills\\` or `OPERATOR_LOCAL_SKILLS_DIR`.

## Validation
Run `./scripts/check_skills_format.ps1` from repo root to verify required headings.
