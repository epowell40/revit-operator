// Display-only diagnostics. This never supplies action admission or completion proof.
export function environmentDiagnosticSummary({backendLocal, label, profileStatus='ready', manifest={}, profile={}, health=null}) {
  const backendLabel=['timeout','unavailable'].includes(profileStatus) ? 'Unavailable' : label;
  const parts=[`${backendLocal ? 'Backend' : 'Hosted service'}: ${backendLabel}`];
  const preferred=manifest.preferred_output_dir || profile.paths?.preferred_exports;
  if(preferred) parts.push(`${backendLocal ? 'Backend' : 'Hosted'} exports: ${preferred}`);
  if(backendLocal) parts.push(manifest.capabilities?.powershell===false ? 'Backend PowerShell restricted'
    : manifest.capabilities?.powershell===true ? 'Backend PowerShell available' : 'Backend PowerShell status unknown');
  const context=health?.context;
  const nativeReady=context && context.ok!==false && context.readiness?.revit_launched===true
    && Number.isSafeInteger(context.process_id) && context.process_id>0 && health.revit_bridge?.ok!==false;
  const readiness=nativeReady
    ? health.cached || health.deferred ? 'Last known responsive' : 'Responding'
    : !health || health.reason==='no_cached_health_available' ? 'Not verified' : 'No response';
  const title=nativeReady ? String(context.document?.title || health.revit_bridge?.document_title || '').trim() : '';
  parts.push(`Local Revit: ${readiness}${title ? ` (${title})` : ''}`);
  return parts.join(' • ');
}
