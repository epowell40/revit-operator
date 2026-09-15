/** Explicit file creation is separate from permission to alter the Revit model. */
export function requestedWorkbookExport(userText: string): boolean {
  const text = userText.normalize("NFKC").replace(/[\u2018\u2019]/g, "'");
  if (/^\s*read[ -]?only\b/i.test(text)
      || /\b(?:preview|preflight|dry[- ]?run|plan only|explain how|tell me how)\b/i.test(text)
      || /\b(?:should|could|can|would)\s+(?:I|we)\b/i.test(text)
      || /\b(?:do not|don't|dont|never)\s+(?:export|produce|generate)\b/i.test(text)
      || /\b(?:do not|don't|dont|never)\s+(?:\w+\s+){0,3}(?:export|write|save|create|produce|generate)\b[^.!?;\n]{0,60}\b(?:files?|workbooks?|spreadsheets?|excel|xlsx|anything|outputs?)\b/i.test(text)
      || /\bwithout\s+(?:creating|writing|saving|exporting)\b[^.!?;\n]{0,60}\b(?:files?|workbooks?|spreadsheets?|outputs?)\b/i.test(text)
      || /\b(?:do not|don't|dont|never)\b[^.!?;\n]{0,70}\b(?:anything|any files)\b/i.test(text)) return false;
  return /(?:^|[.!?;\n]\s*|\bthen\s+)(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:prepare|create|make|produce|generate|write|save|export)\b[^.!?;\n]{0,180}\b(?:excel|xlsx|workbook|spreadsheet)\b/i.test(text);
}

/** File creation alone cannot satisfy an explicitly requested review or input list. */
export function requestedWorkbookAssessment(userText: string): boolean {
  return requestedWorkbookExport(userText)
    && /\b(?:check|verify|review|audit|assess|compare|flag|missing|unverified|decisions|questions|inputs? you need)\b/i.test(userText);
}

export function authorizedArtifactExportPath(userText: string, path: string | undefined): boolean {
  return path === "/revit/export-elements-xlsx" && requestedWorkbookExport(userText);
}
