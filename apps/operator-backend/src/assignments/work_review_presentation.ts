/** Legacy source notes are display hints, never a verified attachment binding
 * or native targeting authority. Do not infer pages from renamed model sheets. */
export function legacyReviewAddress(sourceBasis: string, description: string): string | null {
  // A retained source note may put a digest between the PDF name and its page.
  // Recognize only an adjacent explicit page/sheet pair, not arbitrary model
  // labels or equipment marks. This remains a display hint, never target proof.
  const adjacent = /\b(?:[Pp]age\s+|p\.?\s*)([1-9]\d*)\s+([A-Z]\d{3}(?:\.\d+)?)\b/.exec(sourceBasis);
  const page = /\bPDF\s+(?:page\s*|p)(\d+)\b/i.exec(sourceBasis)?.[1];
  const sheet = /\b(?:PDF|source\s+sheet|drawing|sheet)\s+(?:(?:page\s*|p)\d+[\/,\s-]*)?([A-Z]\d{3}(?:\.\d+)?)\b/i.exec(sourceBasis)?.[1]
    ?? /\b([A-Z]\d{3}(?:\.\d+)?)\s+sheet\b/i.exec(description)?.[1];
  // Preserve an already explicit primary address before using a looser saved
  // note hint; a later supporting detail must not relocate the primary markup.
  if (page && sheet) return `${sheet.toUpperCase()} · page ${page} (saved note)`;
  if (adjacent) return `${adjacent[2]} · page ${adjacent[1]} (saved note)`;
  const parts = [sheet?.toUpperCase(), page ? `page ${page}` : null].filter(Boolean);
  return parts.length ? `${parts.join(' · ')} (saved note)` : null;
}

/** Only an explicit retained disclaimer identifies a technical handoff.
 * Other deferred work stays neutral; presentation cannot infer a user decision. */
export function workFollowupKind(reason: string): 'operator_technical' | 'open_item' {
  return /^Technical (?:handoff|follow-up|blocker),\s*not (?:an? )?engineering question\s*:/i.test(reason)
    ? 'operator_technical' : 'open_item';
}

/** Show verified constituent edits without promoting incomplete scope. */
export function reviewStatusLabel(status: string, checkedEdits: number): string {
  const labels: Record<string,string> = {checked:'Checked edits',partial:'Partial',deferred:'Deferred',
    reported_unverified:'Reported; needs checking',not_completed:'Not completed',outcome_unknown:'Outcome uncertain',settling:'Still settling'};
  const label = labels[status] ?? 'Not completed';
  if (status === 'outcome_unknown' || status === 'settling' || status === 'checked' || checkedEdits <= 0) return label;
  return `${label}; ${checkedEdits} edit${checkedEdits === 1 ? '' : 's'} checked; scope open`;
}
