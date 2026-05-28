# Acknowledge → Execute → Verify (Titleblock edits)

Use this template when the user asks to update anything that is **displayed on a sheet titleblock** (e.g., “Date”, “Issued”, “Revision”, “Drawn By”).

## Acknowledge
- Start with one short natural acknowledgement, or ask for the missing sheet/value if required.
- Keep the following planning checklist internal unless the user asked for a plan or approval is needed.

## Internal checklist
1) Identify the target sheet(s) (sheet number(s)).
2) Identify the titleblock instance and titleblock type/family.
3) Discover candidate driving fields:
   - Use `/revit/titleblock-label-map` for label → driver parameter hints.
   - Use `/revit/titleblock-date-candidates` for ranked date/issue/stamp candidates across:
     - titleblock instance
     - titleblock type
     - sheet
     - project information
4) Choose the verification method:
   - Prefer a **sheet titleblock capture**: `/revit/capture-sheet-region` with `includeOcr:true` (if OCR is configured).
   - If OCR is unavailable, capture the titleblock region and ask the user to confirm visually.

## Execute
- Apply ONE candidate first (unless using the smart tool).
- For automated selection:
  - Use `/revit/titleblock-set-date-smart` to apply + verify via OCR and revert mismatches.

## Verify (must be after apply)
1) Force a regenerate/refresh if needed.
2) Capture the titleblock region after the change:
   - `/revit/capture-sheet-region` (region=`titleblock`)
3) Confirm:
   - OCR match (if available), OR
   - explicit user confirmation from the captured image.

## Reporting rule
- Only say “verified” if the post-change evidence confirms the displayed titleblock value.
- Otherwise say “Not verified” and explain what evidence is missing.

