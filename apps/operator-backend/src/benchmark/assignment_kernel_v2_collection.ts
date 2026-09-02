import {
  ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA,
  ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA
} from "../assignments/assignment_kernel_v2_publication.js";
import {
  ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD,
  parseAssignmentKernelSessionIndexResponseV2
} from "@revitoperator/assignment-kernel-v2-contracts";

type JsonRecord = Record<string, unknown>;

export const BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA =
  "revit-operator.benchmark-assignment-kernel-v2/v1" as const;

type RequestJson = (
  baseUrl: string,
  pathname: string,
  options?: RequestInit,
  timeoutMs?: number
) => Promise<JsonRecord>;

type PublicationRecoveryOptions = {
  attempts?: number;
  retryDelayMs?: number;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/**
 * Read-only telemetry adapter over the canonical V2 provider ledger. This is
 * used to preserve provider accounting when the ordinary chat response is
 * lost; it never creates or modifies canonical provider truth.
 */
export function modelCallReceiptsFromAssignmentKernelPublicationsV2(value: unknown): JsonRecord[] {
  const bundle = record(value);
  if (bundle.schema !== BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA) return [];
  return records(bundle.assignments).flatMap((publication) => {
    if (publication.schema !== ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA) return [];
    const ledger = record(publication.provider_ledger);
    if (ledger.schema !== ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA) return [];
    const calls = record(ledger.calls);
    const callIds = Array.isArray(ledger.call_ids)
      ? ledger.call_ids.map(String).map((id) => id.trim()).filter(Boolean)
      : [];
    return callIds.flatMap((callId) => {
      const call = record(calls[callId]);
      if (call.call_id !== callId || call.state !== "completed") return [];
      const usage = record(call.usage);
      return [{
        schema: "revit-operator.model-call-receipt.v1",
        call_id: callId,
        provider: String(call.provider ?? "unknown"),
        route: "codex_agent",
        requested_model: String(call.model ?? "unknown"),
        model: String(call.model ?? "unknown"),
        reasoning_effort: call.reasoning_effort ?? null,
        started_at_utc: String(call.admitted_at ?? ""),
        duration_ms: nonNegativeIntegerOrNull(call.provider_duration_ms),
        success: call.success === true,
        response_status: call.success === true ? "completed" : "failed",
        error_code: call.error_class ?? null,
        tokens: {
          input_tokens: nonNegativeIntegerOrNull(usage.input_tokens),
          cached_input_tokens: null,
          output_tokens: nonNegativeIntegerOrNull(usage.output_tokens),
          reasoning_output_tokens: nonNegativeIntegerOrNull(usage.reasoning_tokens),
          total_tokens: nonNegativeIntegerOrNull(usage.total_tokens)
        },
        ...(typeof call.controller_turn_id === "string" && call.controller_turn_id.trim()
          ? { turn_id: call.controller_turn_id.trim() }
          : {}),
        canonical_source: "assignment_kernel_v2_provider_ledger",
        assignment_id: publication.assignment_id,
        assignment_version: publication.assignment_version
      }];
    });
  });
}

async function requestPublicationJson(
  baseUrl: string,
  pathname: string,
  requestJson: RequestJson,
  options: PublicationRecoveryOptions
): Promise<JsonRecord> {
  const attempts = Math.max(1, Math.min(5, Math.trunc(options.attempts ?? 4)));
  const retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? 250));
  let lastError: unknown = new Error(`Publication request failed: ${pathname}`);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestJson(baseUrl, pathname, {}, 30_000);
    } catch (error) {
      lastError = error;
      if (attempt < attempts && retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }
  throw lastError;
}

export async function loadAssignmentKernelPublicationsV2(
  baseUrl: string,
  sessionId: string,
  requestJson: RequestJson,
  options: PublicationRecoveryOptions = {}
): Promise<JsonRecord> {
  if (!sessionId) {
    return { schema: BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA, assignment_ids: [], assignments: [], failures: [] };
  }
  try {
    const indexPath = `/api/assignments/v2?limit=10&session_id=${encodeURIComponent(sessionId)}`;
    const indexResponse = await requestPublicationJson(
      baseUrl,
      indexPath,
      requestJson,
      options
    );
    const parsedIndexResponse = parseAssignmentKernelSessionIndexResponseV2(indexResponse);
    const index = record(parsedIndexResponse[ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD]);
    const entries = Array.isArray(index.assignments) ? index.assignments.map(record) : [];
    const assignmentIds = [...new Set(entries.map((entry) => String(entry.assignment_id ?? "").trim()).filter(Boolean))];
    const settled = await Promise.all(assignmentIds.map(async (assignmentId) => {
      try {
        const response = await requestPublicationJson(
          baseUrl,
          `/api/assignments/v2/${encodeURIComponent(assignmentId)}`,
          requestJson,
          options
        );
        const publication = record(response.assignment_kernel_v2);
        return publication.schema === ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA
          ? { publication }
          : { failure: { assignment_id: assignmentId, error: "v2_publication_missing" } };
      } catch (error) {
        return { failure: { assignment_id: assignmentId, error: error instanceof Error ? error.message : String(error) } };
      }
    }));
    return {
      schema: BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA,
      session_index: index,
      assignment_ids: assignmentIds,
      assignments: settled.flatMap((entry) => entry.publication ? [entry.publication] : []),
      failures: settled.flatMap((entry) => entry.failure ? [entry.failure] : [])
    };
  } catch (error) {
    return {
      schema: BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA,
      assignment_ids: [],
      assignments: [],
      failures: [{ assignment_id: null, error: error instanceof Error ? error.message : String(error) }]
    };
  }
}
