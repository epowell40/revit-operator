# MEP Resize Policy

When intent is "resize pathway MEP" (for example ducts, pipes, conduit, cable tray, ductbank/duct bank), use a pathway-aware deterministic flow:

1. Resolve pathway kind + available tooling:
- Determine target pathway kind from user intent and discovered element categories.
- Use capability discovery (`/revit/capabilities`, `/revit/tool-doc`) before assuming a specialized resize tool exists.
- If a specialized tool is unavailable for the requested pathway kind, switch to parameter/type-driven fallback and state that explicitly.

2. Scope discovery:
- Resolve room/view/system/scope and collect candidate elements for the requested pathway kind.
- Prefer dedicated spatial tools where available.
- If strict system filters return zero while nearby candidates exist, use one explicit fallback and record it in output.

3. Apply:
- Prefer specialized resize endpoints for the pathway kind.
- If no specialized endpoint exists, use a safe fallback sequence:
  - discover candidate ids,
  - inspect instance/type parameters,
  - apply instance edits first,
  - for type-driven elements, use duplicate-type + targeted swap where supported.

4. Verify (required for claimed success):
- Verify post-change state on impacted elements.
- Success requires convergence for targeted elements; unresolved/mismatched elements must be reported.
- Never claim full success when any targeted elements remain unresolved.

5. Duct specialization (current strongest support):
- For duct workflows, prefer dedicated connected-run/scope tools and fitting/terminal synchronization.
- Preserve dry-run-first behavior and explicit unresolved reporting.

6. Output requirements:
- Include pathway kind, selection/scope logic, fallback usage, matched counts, changed counts, and unresolved list.
- Include evidence paths for verification artifacts when available.
