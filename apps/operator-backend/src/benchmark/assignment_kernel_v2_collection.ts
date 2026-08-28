type JsonRecord = Record<string, unknown>;

type RequestJson = (
  baseUrl: string,
  pathname: string,
  options?: RequestInit,
  timeoutMs?: number
) => Promise<JsonRecord>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export async function loadAssignmentKernelPublicationsV2(
  baseUrl: string,
  sessionId: string,
  requestJson: RequestJson
): Promise<JsonRecord> {
  if (!sessionId) {
    return { schema: "revit-operator.benchmark-assignment-kernel-v2/v1", assignment_ids: [], assignments: [], failures: [] };
  }
  try {
    const indexResponse = await requestJson(
      baseUrl,
      `/api/assignments/v2?limit=10&session_id=${encodeURIComponent(sessionId)}`,
      {},
      30_000
    );
    const parsedIndexResponse = parseAssignmentKernelSessionIndexResponseV2(indexResponse);
    const index = record(parsedIndexResponse[ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD]);
    const entries = Array.isArray(index.assignments) ? index.assignments.map(record) : [];
    const assignmentIds = [...new Set(entries.map((entry) => String(entry.assignment_id ?? "").trim()).filter(Boolean))];
    const settled = await Promise.all(assignmentIds.map(async (assignmentId) => {
      try {
        const response = await requestJson(baseUrl, `/api/assignments/v2/${encodeURIComponent(assignmentId)}`, {}, 30_000);
        const publication = record(response.assignment_kernel_v2);
        return publication.schema === "revit-operator.assignment-kernel-publication/v2"
          ? { publication }
          : { failure: { assignment_id: assignmentId, error: "v2_publication_missing" } };
      } catch (error) {
        return { failure: { assignment_id: assignmentId, error: error instanceof Error ? error.message : String(error) } };
      }
    }));
    return {
      schema: "revit-operator.benchmark-assignment-kernel-v2/v1",
      session_index: index,
      assignment_ids: assignmentIds,
      assignments: settled.flatMap((entry) => entry.publication ? [entry.publication] : []),
      failures: settled.flatMap((entry) => entry.failure ? [entry.failure] : [])
    };
  } catch (error) {
    return {
      schema: "revit-operator.benchmark-assignment-kernel-v2/v1",
      assignment_ids: [],
      assignments: [],
      failures: [{ assignment_id: null, error: error instanceof Error ? error.message : String(error) }]
    };
  }
}
import {
  ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD,
  parseAssignmentKernelSessionIndexResponseV2
} from "@revitoperator/assignment-kernel-v2-contracts";
