import {
  classifyEpic0437RecoveryContinuity,
  type LaboratoryNativeAttestationBinding
} from "./laboratoryMoveEvidence.js";

export type Epic0437DiscardRequiredState = Readonly<Record<string, unknown> & {
  state: "host_restart_discard_required";
  current_document_session_id: string;
  current_native_attestation_key_id: string;
  outcome_unknown: true;
  retryable: false;
}>;

export type Epic0437RecoveryRoute<T> =
  | Readonly<{ kind: "same_native_session"; value: T }>
  | Readonly<{ kind: "discard_required"; state: Epic0437DiscardRequiredState }>;

/**
 * The single recovery control boundary used by the live runner. A rotated
 * native identity cannot invoke the same-session callback. The returned
 * discard state is non-promotable and must be persisted before the caller
 * blocks the run.
 */
export function routeEpic0437Recovery<T>(input: {
  savedState: Readonly<Record<string, unknown>>;
  trusted: LaboratoryNativeAttestationBinding;
  currentDocumentSessionId: string;
  nowUtc: string;
  sameSession: () => T;
}): Epic0437RecoveryRoute<T> {
  if (classifyEpic0437RecoveryContinuity(
    input.savedState.preview_result,
    input.trusted,
    input.currentDocumentSessionId
  ) === "same_native_session") {
    return { kind: "same_native_session", value: input.sameSession() };
  }
  return {
    kind: "discard_required",
    state: {
      ...input.savedState,
      state: "host_restart_discard_required",
      current_document_session_id: input.currentDocumentSessionId,
      current_native_attestation_key_id: input.trusted.key_id,
      outcome_unknown: true,
      retryable: false,
      updated_at_utc: input.nowUtc
    }
  };
}

export function assertNoEpic0437DiscardRequired(records: readonly string[]): void {
  if (records.length > 0) {
    throw new Error(`A prior EPIC-0437 move belongs to a rotated Revit native session and cannot authorize another mutation. Close Revit without saving, replace the exact disposable RVT with a pristine installed-sample copy, then run the discard-archive command for: ${records.join(", ")}`);
  }
}
