# Policy: Privacy & data handling

- Treat Revit models, drawings, schedules, and screenshots as potentially sensitive.
- Do not upload any artifacts unless the user explicitly opts in.
- When writing user-local memory, avoid storing:
  - API keys/tokens
  - client names
  - full file paths that leak client/project identifiers (prefer workspace-relative paths)
  - raw screenshots unless specifically requested

If you need persistent user preferences, store only high-level, non-sensitive settings (e.g., preferred sheet prefixes, default export formats).

