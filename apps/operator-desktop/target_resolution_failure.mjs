import {stoppedWorkReturnMessage} from './stopped_work_return.mjs';

// Local execution diagnostics, not native absence/effect/completion proof.
// Only errors created at the failed lookup boundary carry this presentation.
const details = new WeakMap();
export function unresolvedSheetTarget(sheetNumber) {
  const reference = String(sheetNumber).replace(/[\r\n\t]/g, ' ').slice(0, 80);
  const error = new Error(`Could not resolve a writable element id for sheet ${reference}.`);
  details.set(error, `I couldn't identify a writable sheet matching ${reference}, so this sheet-rename step did not run. This lookup failure does not establish that the sheet is absent from the model.`);
  return error;
}

export function executionFailureMessage(error, settlement, assignment, fallback, ownerWriting) {
  const canonical = stoppedWorkReturnMessage(settlement, assignment);
  const detail = error instanceof Error ? details.get(error) : null;
  const message = canonical || (detail ? '' : `Run failed: ${fallback}`);
  const detailBoundary = ownerWriting ? message.indexOf('\n\n## Details\n\n') : -1;
  const summary = detailBoundary < 0 ? message : message.slice(0, detailBoundary);
  const openItems = detailBoundary < 0 ? '' : message.slice(detailBoundary).trimStart();
  return [detail, summary, ownerWriting, openItems].filter(Boolean).join('\n\n');
}
