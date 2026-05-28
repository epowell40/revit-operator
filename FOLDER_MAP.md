# Folder Map (Simple)

If you're scanning this repo quickly:

- `prompts/` = global behavior rules for the agent.
- `skills/` = reusable skill content the agent can use.
  - start at `skills/INDEX.md`
- `docs/epics/` = project notes/history (not runtime skills).
- `docs/archive/` = legacy specs/notes retained for reference.
- `operator-desktop/` = external Operator sidecar spike (desktop app outside Revit).
- `scripts/` = runnable helper scripts.
- `scripts/legacy/root-scripts/` = old one-off harvest/analysis scripts kept for reference, not day-to-day entrypoints.
- `local-work/` = local scratch/output (gitignored).

If you're asking "where did move/rotate/select/screenshot primitives go?":
- See `docs/PRIMITIVES_VS_SKILLS.md` (they are tool primitives, not markdown skills).

Rule of thumb:
- "Should the agent learn/use this every time?" -> `prompts/` or `skills/`
- "Is this planning/history of a feature?" -> `docs/epics/`
- "Is this just local generated output?" -> `local-work/`
- Keep the repo root lean: entrypoint docs/scripts only; generated datasets/eval artifacts belong under `local-work/`.
