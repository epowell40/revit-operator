/** Reviewed typed MCP wrappers with the identical native POST request body.
 * Canonicalize before broad observation-name classification: PDF export may
 * write a file, while schedule checks need the exact native read selector. */
export function reviewedTeammateNativeAliasRoute(tool: string): string | null {
  if (tool === 'revit_export_pdf') return '/revit/export-pdf';
  if (tool === 'revit_list_schedules') return '/revit/schedules';
  return null;
}

/** Mirror the reviewed wrapper's canonical write mode, not its display name.
 * Invalid/conflicting modes remain with ordinary admission and MCP validation;
 * this translation never supplies native proof or authorizes an operation. */
export function reviewedTeammateNativeAliasRequest(tool: string, args: Record<string, unknown>):
  { path: string; body: Record<string, unknown> } | null {
  if (tool === 'revit_set_parameters') {
    const apply = args.apply === true;
    const dryRun = typeof args.dryRun === 'boolean' ? args.dryRun : !apply;
    if (apply === dryRun) return null;
    return { path: '/revit/set-parameter', body: { ...args, apply, dryRun } };
  }
  const path = reviewedTeammateNativeAliasRoute(tool);
  return path ? { path, body: args } : null;
}
