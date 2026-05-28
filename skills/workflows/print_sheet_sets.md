# Skill: Print Sheet Sets Safely

## Goal
Resolve sheet-set intent into explicit matches, confirm scope when needed, and export with clear artifact paths.

## Use when
- User asks to print/export multiple sheets by series/discipline.
- Request includes ambiguous phrases like "M100 series", "mechanical sheets", or "all A-sheets".

## Do not use when
- User asks for a single known sheet export with explicit id/sheet number.
- Output is not PDF/print related.

## Required inputs
- Query phrase or known sheet set key.
- Output filename/path preferences (if provided).

## Execution steps
1. Dry-run first with `print_sheets` or discover via `/revit/sheets`.
2. Summarize exact matched sheet numbers and count.
3. Request confirmation for real export if ambiguity or destructive volume exists.
4. Execute export and return artifact paths with `op://open-folder` link.

## Success criteria
- Matched sheet list is explicit before final export.
- Export result returns concrete artifact paths.
- User-facing summary includes total sheets exported.

## Failure handling
- If no sheets match, report match logic used and offer one narrower fallback query.
- If export fails, include exact tool error and preserve resolved match list for retry.

## Examples
- "Print all M100s to one PDF."
- "Export mechanical sheets for coordination."
