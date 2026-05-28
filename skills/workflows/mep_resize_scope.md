# Skill: MEP Pathway Resize by Scope

## Goal
Resize pathway MEP systems (duct, pipe, conduit, cable tray, ductbank/duct bank) by scope with deterministic discovery and explicit limits.

## Use when
- The user asks to resize pathway systems by room/view/system intent.
- The request is outcome-first (for example: "change X from size A to B in area Y").

## Do not use when
- The user explicitly asks for a single selected element only.
- The target is not a pathway-like MEP system.

## Required inputs
- Pathway kind (explicit or inferred): duct, pipe, conduit, cable tray, ductbank/duct bank.
- Spatial/system target (`roomNumber`, room phrase, view, or equivalent scope hint).
- Target size (and source size if specified).
- System intent/classification when provided.

## Execution steps
1. Discover available resize tools for the inferred pathway kind.
2. Resolve candidate elements in requested scope.
3. If blast radius is uncertain, run dry-run or planning flow first.
4. Apply specialized resize flow if available; otherwise use parameter/type fallback.
5. Report changed ids and unresolved ids/reasons.
6. If the user asked for proof, capture post-change evidence.

## Success criteria
- Tool result shows intended pathway changes applied.
- Unresolved elements (if any) are explicitly listed with reasons.
- Verification is only claimed when post-change evidence exists.

## Failure handling
- If write grant is missing, instruct the user to enable writes and retry.
- If discovery returns zero, relax scope constraints once and report fallback logic.
- If no specialized pathway tool exists, state limitation and use safe fallback sequence.
- If post-conditions fail, do not claim completion; return unresolved details and next action.

## Examples
- "Resize supply ductwork in office unit 301 from 8\" to 10\"."
- "In room 0201, update chilled-water pipe size from 1\" to 1-1/4\"."
