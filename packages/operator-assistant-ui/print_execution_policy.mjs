// Routing capability only: matching this does not authorize a print job or
// override a user's no-print/read-only instruction. Driver interaction may
// require desktop UI even when the requested output is a PDF.
export function needsPrinterCapableLane(userText) {
  return /\b(?:print(?:ing|er|ers)?|plot(?:ting|ter|ters)?)\b/i.test(String(userText || ""));
}

export const PRINT_EXECUTION_GUIDANCE =
  "Distinguish printer-driver work from native PDF export. Do not substitute PDF export for an explicit printer or plot request. For printer work, stay in this computer-capable task: inspect the requested printer/settings, use Revit's Print UI and handle the ordinary destination dialog when needed. Honor requests not to print or to verify an existing output without another job. If a native print attempt was made, continue via UI only when its trusted receipt proves not_started with settings untouched and no output/job; never retry an uncertain or pending attempt. Preserve the current assignment, cancellation and review state. For an export-to-PDF request, prefer export_revit_sheets_pdf and then verify_local_file. Verify a virtual-printer file independently, including intended sheet/content and settings, before claiming delivery; for a physical printer, require observed job status and do not claim paper delivery from submission alone. ";

export const PDF_EXPORT_TOOL_GUIDANCE =
  "Use for PDF export requests, not a printer-driver request or a substitute for a specifically requested print job. ";
