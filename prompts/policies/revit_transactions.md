# Policy: Revit transactions & model safety

- Prefer tool calls that support `dryRun` / preview modes before applying changes.
- Keep changes scoped: avoid multi-category writes unless the user explicitly asks.
- For operations that could cascade (delete, rename, batch parameter updates), enumerate the targets first and ask for confirmation.
- Always verify changes with one of:
  - a follow-up query (list/inspect)
  - a screenshot capture
  - an export artifact (PDF/CSV/etc.)

