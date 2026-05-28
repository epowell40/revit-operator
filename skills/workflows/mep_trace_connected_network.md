# Skill: Trace Connected MEP Network from Seed

## Goal
Resolve the connected MEP network from a picked seed element and return a deterministic candidate set for downstream resize/audit actions.

## Use when
- The user asks to find all pathway elements connected to equipment/terminal/duct/pipe/conduit seed.
- Scope is implied by connectivity rather than room-only or selection-only filters.

## Do not use when
- The user only wants the currently selected elements with no traversal.
- The request is not connectivity-based (for example, pure room inventory without network intent).

## Required inputs
- Seed element id (picked or selected).
- Optional pathway/system filters (system name/classification).
- Optional traversal limits (`maxHops`, branch/transition stop behavior).

## Execution steps
1. Confirm seed element exists and has usable connectors.
2. Run connected-network tracing with explicit traversal limits.
3. Apply requested system/pathway filters after traversal (best-effort when system labels are incomplete).
4. If seed traversal returns zero, ask for a better seed element or relax one filter once.
5. Return connected ids plus unresolved diagnostics for skipped/unsupported elements.

## Success criteria
- Returns a stable connected candidate set from the seed.
- Reports traversal boundaries and filters used.
- Includes unresolved/skipped reasons when full traversal is not possible.

## Failure handling
- If connectors are unavailable on seed, request a different seed element.
- If traversal is too broad, tighten limits and rerun.
- If tool path is unavailable, fall back to scoped query + parameter filtering and state the limitation.

## Examples
- "Find all ductwork connected to this rooftop unit."
- "Trace everything connected to this VAV box and list mismatched sizes."
