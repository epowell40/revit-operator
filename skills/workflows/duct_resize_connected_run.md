# Skill: Duct Resize Connected-Run Heuristic

## Goal
Handle ambiguous "change duct size" requests by defaulting to connected-run intent with safe boundaries and explicit confirmations.

## Use when
- User asks to change duct size without precise scope.
- A selected/picked seed element is available (duct, fitting, terminal, equipment).

## Do not use when
- User explicitly requests selected-element-only changes.
- Target pathway kind is not ductwork.

## Required inputs
- Seed element (selected id, picked element, or resolved candidate).
- Target diameter/size.
- Optional system name/classification filters.

## Execution steps
1. Interpret default intent as connected-run resize up to transitions/branches/terminations unless user says entire system.
2. If ambiguity remains, ask one focused question:
   - "Do you want just the selected segment, or the full run to the next transition/termination (including fittings/terminal)?"
3. Prefer specialized duct tools:
   - `/revit/resize-duct-run` for connected-run behavior.
   - `/revit/resize-ductwork-by-scope` for one-shot room/space directives.
4. For spatial requests, resolve scope first (Room -> Space -> geometry fallback) before asking for extra details.
5. For type-driven fittings/terminals, use duplicate-type + targeted swap when needed.

## Success criteria
- Duct curve changes match requested target size.
- Connected fitting/terminal convergence status is reported.
- Branch/transition stop behavior is explicitly reflected in output.

## Failure handling
- If write grant blocks apply, request write enablement and retry.
- If connected traversal yields no candidates, ask for a better seed element.
- If type-driven elements cannot converge, return unresolved ids and next-step options.

## Examples
- "Change this duct to 6 inches."
- "Change supply ductwork in office unit 301 from 8\" to 10\"."
