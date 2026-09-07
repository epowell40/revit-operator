import { kernelPublicationsV2 } from "./protocol_v2_kernel.js";
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];

/** Same owner for top-level evaluation and ProtocolV2 stages; never infer verification from a commit alone. */
export function hasUnresolvedTrustedVerificationFailureV2(toolResults: unknown): boolean {
  const snapshots = kernelPublicationsV2(toolResults).map(publication => row(publication.snapshot));
  const newest = new Map<string, number>();
  for (const snapshot of snapshots) {
    const id = String(row(snapshot.current_binding).assignment_id || "");
    const version = Number(snapshot.assignment_version || 0);
    newest.set(id, Math.max(newest.get(id) ?? -1, version));
  }
  return snapshots.filter(snapshot => Number(snapshot.assignment_version || 0) === newest.get(String(row(snapshot.current_binding).assignment_id || "")))
    .some(snapshot => {
      const operations = Object.values(row(snapshot.operations)).map(row);
      return operations.some(failed => {
        const subjectId = String(failed.verification_of_operation_id || "");
        const subject = operations.find(operation => operation.operation_id === subjectId);
        if (!subject || subject.persistent_effect !== "applied" || failed.purpose !== "verification"
          || row(failed.result).error_code !== "assignment_kernel_v2_trusted_verification_postcondition_not_satisfied") return false;
        return !operations.some(operation => operation.verification_of_operation_id === subjectId
          && operation.purpose === "verification" && row(operation.result).status === "succeeded"
          && strings(subject.verification_operation_ids).includes(String(operation.operation_id)));
      });
    });
}

export function verificationChecksPass(value: unknown): boolean {
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length === 0) return false;
  return rows.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const row = entry as Record<string, unknown>;
    const named = typeof row.name === "string" && row.name.trim().length > 0;
    const grounded = Object.prototype.hasOwnProperty.call(row, "expected")
      || Object.prototype.hasOwnProperty.call(row, "actual")
      || (Array.isArray(row.evidence_refs) && row.evidence_refs.length > 0);
    return row.ok === true && named && grounded;
  });
}
