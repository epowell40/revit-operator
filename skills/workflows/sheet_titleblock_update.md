# Skill: Sheet Titleblock Update and Verify

## Goal
Apply sheet/titleblock field updates and verify them with sheet-aware post-change evidence.

## Use when
- User asks to change titleblock text/parameters on sheets.
- User requires "verified" results with evidence.

## Do not use when
- Request is for model geometry changes unrelated to sheets/titleblocks.
- User only wants a planning answer (no action).

## Required inputs
- Sheet selector (`sheetNumber`, set, or filter).
- Target field/text and desired value.

## Execution steps
1. Resolve sheet and titleblock target.
2. Apply with appropriate sheet-aware tool (`/revit/set-parameter`, `/revit/titleblock-set-date-smart`, or family text workflow).
3. Regenerate if needed.
4. Verify with sheet-aware evidence (`/revit/verify-parameter-on-sheet` or `/revit/capture-sheet-region`).
5. Report exact evidence path; if missing, mark as "Not verified".

## Success criteria
- Requested field/text value is applied to the intended sheet target.
- Verification cites post-change sheet-aware evidence.
- No claim of verification is made without evidence.

## Failure handling
- If multiple plausible titleblock targets exist, ask one focused clarifying question.
- If verification capture fails, report apply status separately and mark verification as incomplete.
- If write grant is missing, request write enablement and retry.

## Examples
- "Update issue date on A1.00 titleblock to 02/16/2026 and verify."
- "Change MEP engineer name on cover sheet and prove it."
