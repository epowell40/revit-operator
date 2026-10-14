/** Legacy source notes are display hints, never a verified attachment binding
 * or native targeting authority. Do not infer pages from renamed model sheets. */
export function legacyReviewAddress(sourceBasis: string, description: string): string | null {
  const page = /\bPDF\s+(?:page\s*|p)(\d+)\b/i.exec(sourceBasis)?.[1];
  const sheet = /\b(?:PDF|source\s+sheet|drawing|sheet)\s+(?:(?:page\s*|p)\d+[\/,\s-]*)?([A-Z]\d{3}(?:\.\d+)?)\b/i.exec(sourceBasis)?.[1]
    ?? /\b([A-Z]\d{3}(?:\.\d+)?)\s+sheet\b/i.exec(description)?.[1];
  const parts = [sheet?.toUpperCase(), page ? `page ${page}` : null].filter(Boolean);
  return parts.length ? `${parts.join(' · ')} (saved note)` : null;
}

/** Show verified constituent edits without promoting incomplete scope. */
export function reviewStatusLabel(status: string, checkedEdits: number): string {
  const labels: Record<string,string> = {checked:'Checked edits',partial:'Partial',deferred:'Deferred / question',
    reported_unverified:'Reported; needs checking',not_completed:'Not completed',outcome_unknown:'Outcome uncertain',settling:'Still settling'};
  const label = labels[status] ?? 'Not completed';
  if (status === 'outcome_unknown' || status === 'settling' || status === 'checked' || checkedEdits <= 0) return label;
  return `${label}; ${checkedEdits} edit${checkedEdits === 1 ? '' : 's'} checked; scope open`;
}
