import type http from "node:http";
import { readJson, writeJson } from "../http.js";
import { recordSidecarExecutionFailureV2 } from "./sidecar_execution_failure.js";

/** Called only after the composition's authentication gateway. Ownership stays
 * with that gateway; execution settlement retains the exact kernel binding. */
export async function handleSidecarExecutionFailureHttp(
  req: http.IncomingMessage, res: http.ServerResponse,
  boundary: { normalizeSessionId(value: unknown): string; sessionAllowed(sessionId: string): boolean }
): Promise<void> {
  const body = await readJson(req, 4096).catch(() => ({}));
  const sessionId = boundary.normalizeSessionId((body as any)?.session_id);
  if (!sessionId) return writeJson(res, 400, { error: "session_id is required." });
  if (!boundary.sessionAllowed(sessionId)) return;
  try {
    const settled = recordSidecarExecutionFailureV2(sessionId, body);
    return writeJson(res, 200, { ok: true, disposition: settled.disposition,
      assignment_id: settled.snapshot.current_binding.assignment_id,
      assignment_version: settled.snapshot.assignment_version });
  } catch (error) {
    return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}
