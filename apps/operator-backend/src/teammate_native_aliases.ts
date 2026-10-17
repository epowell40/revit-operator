/** Reviewed typed MCP wrappers with the identical native POST request body.
 * Canonicalize before broad observation-name classification: PDF export may
 * write a file, while schedule checks need the exact native read selector. */
export function reviewedTeammateNativeAliasRoute(tool: string): string | null {
  if (tool === 'revit_export_pdf') return '/revit/export-pdf';
  if (tool === 'revit_list_schedules') return '/revit/schedules';
  return null;
}
