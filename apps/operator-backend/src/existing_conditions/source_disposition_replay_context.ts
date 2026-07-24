import type { ChatRequest } from "../contracts.js";
import { latestExistingConditionsSourceDispositionV1 } from "./source_disposition_ledger.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function withLatestExistingConditionsSourceDispositionContext(
  req: ChatRequest
): ChatRequest {
  const state = latestExistingConditionsSourceDispositionV1(req.session_id);
  if (!state) return req;
  const context = record(req.context);
  const server = record(context.__server);
  const disposition = state.disposition;
  return {
    ...req,
    context: {
      ...context,
      __server: {
        ...server,
        existing_conditions_source_disposition: {
          schema: "operator.existing_conditions.source_disposition_replay_context.v1",
          sequence: state.sequence,
          event_key: state.event_key,
          entry_sha256: state.entry_sha256,
          status: state.status,
          target_key: disposition.target_key,
          disposition: disposition.disposition,
          reason_code: disposition.reason_code,
          package_fingerprint_sha256: disposition.package_fingerprint_sha256,
          source_receipt_sha256: disposition.source_receipt_sha256,
          source_receipt_schema: disposition.source_receipt_schema,
          source_frame_id: disposition.source_frame_id,
          registration_context_id: disposition.registration_context_id,
          evidence_group_ids: disposition.evidence_group_ids,
          next_repair: disposition.next_repair,
          native_write_allowed: false,
          continuation_contract: disposition.disposition === "abstained"
            ? "Continue from next_repair or another source-supported target. Do not repeat this accepted source search or author a native action for target_key unless a later accepted source observation supersedes event_key."
            : "This is accepted source-only knowledge, not native-write authority. Continue with the next bounded native verification required by next_repair."
        }
      }
    }
  };
}
