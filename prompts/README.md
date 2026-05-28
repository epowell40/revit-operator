# Prompts (repo-shipped)

This folder is the **committed** prompt stack for Revit Operator.

It is intended to be:
- **Stable**: reviewed, versioned, and shared across users.
- **Non-secret**: never store API keys, client data, or personal info here.

## Intended assembly order
1) `system.md` (hard rules; do not weaken)
2) `soul.md` (persona + default workflow)
3) `policies/*.md` (domain-specific rules, pulled as needed)
   - `policies/web_research.md` is optional; it depends on whether a web-research tool is enabled and what policy (whitelist vs unrestricted) the host chooses.
4) User-local overrides (NOT committed): workspace `config/prompt_overrides.md`
5) Retrieved memory (daily + long-term; user-local)
6) Recent chat window
7) Tools list + tool contracts

## Current state of the codebase
Today, the Operator backend injects a “skill library” text block that includes selected repo docs from `prompts/`,
plus manifest-selected entries from `skills/skill_library_manifest.json` (best-effort, size-limited).

Practical guidance:
- Keep `prompts/` focused on global prompt rules (system/persona/policies/templates).
- Keep all skill/runbook/asset content in `skills/` and list injected docs in `skills/skill_library_manifest.json`.
- Put private/per-user instructions in local skill paths (`OPERATOR_LOCAL_SKILLS_DIR` or `%LOCALAPPDATA%\\RevitOperator\\Skills\\`).
