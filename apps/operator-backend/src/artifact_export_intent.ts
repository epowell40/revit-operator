/** Explicit file creation is separate from permission to alter the Revit model. */
function requestedFileExport(userText: string, kind: "workbook" | "pdf" | "document_copy"): boolean {
  const text = userText.normalize("NFKC").replace(/[\u2018\u2019]/g, "'");
  if (/^\s*(?:read[ -]?only|(?:review|inspection|discovery) only)\b/i.test(text)
      || /\b(?:dry[- ]?run|plan only|explain how|tell me how|preview only|preflight only)\b/i.test(text)
      || /\b(?:after|until|once|when|if)\b[^.!?;\n]{0,80}\b(?:approv\w*|confirm\w*|review\w*)\b/i.test(text)
      || /\b(?:later|not yet|only if|if needed|if possible|wait for)\b/i.test(text)
      || /\b(?:should|could|can|would)\s+(?:I|we)\b/i.test(text)
      || /\b(?:do not|don't|dont|never)\s+(?:export|produce|generate)\b/i.test(text)
      || /\b(?:do not|don't|dont|never)\s+(?:commit|write|save|create)\s*(?:[.!?;]|$)/i.test(text)
      || /\b(?:do not|don't|dont|never)\s+(?:\w+\s+){0,3}(?:export|write|save|create|produce|generate)\b[^.!?;\n]{0,60}\b(?:files?|pdfs?|workbooks?|spreadsheets?|excel|xlsx|anything|outputs?)\b/i.test(text)
      || /\bwithout\s+(?:creating|writing|saving|exporting)\b[^.!?;\n]{0,60}\b(?:files?|pdfs?|workbooks?|spreadsheets?|outputs?)\b/i.test(text)
      || /\b(?:do not|don't|dont|never)\b[^.!?;\n]{0,70}\b(?:anything|any files)\b/i.test(text)) return false;
  // A preflight list is an input/check, not a request to stop before exporting.
  // Imperative preview/preflight still needs an explicit subsequent export.
  if ((/\bpreview\b/i.test(text) || /(?:^|[.!?;,]\s*)(?:please\s+)?preflight\b/i.test(text))
      && !/\bthen\s+(?:export|create|produce|generate|write|save)\b/i.test(text)) return false;
  if (kind === "document_copy") {
    // A requested document checkpoint is not permission to edit elements,
    // overwrite a source, or save through an arbitrary native operation.
    if (/\b(?:do not|don't|dont|never)\s+(?:\w+\s+){0,3}save\b[^.!?;\n]{0,60}\b(?:copy|as|model|project|document|rvt)\b/i.test(text)
        || /\bwithout\s+saving\b/i.test(text)) return false;
    return /(?:^|[.!?;]\s*|\bthen\s+)(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?save\s+(?:a\s+(?:separate\s+|new\s+)?copy|as)\b[^!?;\n]*\.rvt\b/i.test(text)
      // A destination commonly follows "at:" on the next line. This is an
      // explicit native document-copy file request, not element-edit authority.
      || /(?:^|[.!?;]\s*|\bthen\s+)(?:please\s+)?(?:create|make)\s+a\s+(?:(?:separate|new|reviewed)\s+){0,3}copy\s+of\s+(?:the\s+)?(?:(?:currently|current|active|open)\s+){0,3}(?:revit\s+)?(?:model|project|document)\s+(?:at|to)\s*:?\s*["']?(?:[a-z]:[\\/]|\\\\)[^!?;\r\n]{1,1024}\.rvt\b/i.test(text);
  }
  const artifact = kind === "pdf" ? "pdfs?" : "excel|xlsx|workbook|spreadsheet";
  // "Print a PDF" requests a file, not permission to operate a physical
  // printer or publish another artifact type. Keep the existing file limits.
  if (kind === "pdf" && /\b(?:do not|don't|dont|never)\s+(?:\w+\s+){0,3}print\b[^.!?;\n]{0,100}\bpdfs?\b/i.test(text)) return false;
  const verbs = "prepare|create|make|produce|generate|write|save|export" + (kind === "pdf" ? "|print" : "");
  return new RegExp("(?:^|[.!?;,]\\s*|\\bthen\\s+)(?:(?:for|using|from|with|in)\\s+[^.!?;\\n,]{1,100},\\s*)?(?:please\\s+)?(?:(?:can|could|would|will)\\s+you\\s+)?(?:" + verbs + ")\\b[^.!?;\\n]{0,180}\\b(?:" + artifact + ")\\b", "i").test(text);
}

export function requestedWorkbookExport(userText: string): boolean {
  return requestedFileExport(userText, "workbook");
}

export function requestedArtifactExportPaths(userText: string): string[] {
  return [
    ...(requestedWorkbookExport(userText) ? ["/revit/export-elements-xlsx"] : []),
    ...(requestedFileExport(userText, "pdf") ? ["/revit/export-pdf"] : []),
    ...(requestedFileExport(userText, "document_copy") ? ["/revit/save-as"] : [])
  ];
}

/** File creation alone cannot satisfy an explicitly requested review or input list. */
export function requestedWorkbookAssessment(userText: string): boolean {
  return requestedWorkbookExport(userText)
    && /\b(?:check|verify|review|audit|assess|compare|flag|missing|unverified|decisions|questions|inputs? you need)\b/i.test(userText);
}

export function authorizedArtifactExportPath(userText: string, path: string | undefined): boolean {
  return typeof path === "string" && requestedArtifactExportPaths(userText).includes(path);
}
