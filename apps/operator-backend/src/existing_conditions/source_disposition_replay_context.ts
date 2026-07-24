import {
  OPERATOR_BACKEND_CONTRACT_VERSION,
  type ChatRequest,
  type ChatResponse
} from "../contracts.js";
import { latestExistingConditionsSourceDispositionV1 } from "./source_disposition_ledger.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isSourceDispositionContinuationRequest(req: ChatRequest): boolean {
  const text = String(req.user_text ?? "");
  return /source[\s_-]+disposition/i.test(text) ||
    (/existing[\s_-]+conditions/i.test(text) && /\b(?:latest|last|persisted|saved|resume|continue)\b/i.test(text));
}

function isReadOnlyDispositionInspection(req: ChatRequest): boolean {
  const text = String(req.user_text ?? "");
  return isSourceDispositionContinuationRequest(req) &&
    (/\b(?:report|explain|show|tell)\b/i.test(text) ||
      /\b(?:do not|don't|without)\s+(?:modify|change|write|edit|draft)/i.test(text));
}

export function maybeBuildExistingConditionsSourceDispositionInspection(
  req: ChatRequest
): ChatResponse | null {
  if (!isReadOnlyDispositionInspection(req)) return null;
  const state = latestExistingConditionsSourceDispositionV1(req.session_id);
  if (!state) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        "No persisted existing-conditions source disposition exists for this Operator session, so there is no exact next repair to resume. I did not synthesize a source observation or dispatch a native Revit action. Reopen the original session or register a source-supported observation before continuing.",
      actions: []
    };
  }
  const disposition = state.disposition;
  const dispositionSummary = disposition.disposition === "abstained"
    ? `Target ${disposition.target_key} remains abstained because ${disposition.reason_code}.`
    : `Target ${disposition.target_key} has an accepted source-only observation (${disposition.reason_code}).`;
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      `${dispositionSummary} Exact next repair: ${disposition.next_repair} ` +
      `This report resumed ledger event ${state.event_key}; it did not repeat the source search or dispatch a native Revit action.`,
    actions: []
  };
}

export function withLatestExistingConditionsSourceDispositionContext(
  req: ChatRequest
): ChatRequest {
  const state = latestExistingConditionsSourceDispositionV1(req.session_id);
  if (!state) {
    if (!isSourceDispositionContinuationRequest(req)) return req;
    const context = record(req.context);
    const server = record(context.__server);
    return {
      ...req,
      context: {
        ...context,
        __server: {
          ...server,
          existing_conditions_source_disposition: {
            schema: "operator.existing_conditions.source_disposition_replay_context.v1",
            status: "not_found",
            native_write_allowed: false,
            continuation_contract:
              "No persisted source disposition exists for this session. Do not synthesize or register one without source evidence, and do not author a native action from this missing state."
          }
        }
      }
    };
  }
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
