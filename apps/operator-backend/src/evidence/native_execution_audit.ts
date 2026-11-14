import type { EvidenceRefV1 } from './evidence_ref.js';
import { parseBoundedStructuredJson } from './structured_payload.js';

const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Historical field selection from the hash-checked retained native receipt.
 * Never include the large effect observation in a code audit: it is unused by
 * that consumer and remains in the immutable original for native verification.
 * This selection grants no currentness, settlement, retry or verification.
 * The consumer must still validate source/document/transaction consistency.
 */
export function selectNativeExecutionAudit(ref: EvidenceRefV1, payload: unknown): Record<string, unknown> | null {
  if (ref.source !== 'assignment_kernel_v2:operator_run_dynamic_revit_program' || ref.trust_level !== 'authoritative_native'
      || ref.secret_screening_status !== 'passed') return null;
  const row = record(payload), evidence = record(row?.evidence);
  if (row?.schema !== 'revit-operator.dynamic-revit-program-run.v1' || row.execution_lane !== 'native'
      || typeof evidence?.nativeExecutionReceipt !== 'string') return null;
  const receipt = record(parseBoundedStructuredJson(evidence.nativeExecutionReceipt));
  if (receipt?.schema !== 'dynamic-revit-native-execution-receipt/v1') return null;
  const fields = ['schema', 'source_hash', 'document_fingerprint', 'document_session_id', 'document_revision_before',
    'verified', 'retry_permitted', 'read_only', 'success', 'transaction', 'program_result', 'error'];
  return Object.fromEntries(fields.filter(key => Object.hasOwn(receipt, key)).map(key => [key, receipt[key]]));
}
