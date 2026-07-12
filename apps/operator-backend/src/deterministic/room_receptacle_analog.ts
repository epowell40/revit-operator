import { randomUUID } from "node:crypto";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ChatResponse, type ToolResult } from "../contracts.js";
import type { AecTaskIntentV1 } from "../aec_task_intent.js";

const PLAN_PATH = "/revit/plan-room-receptacles-from-analog";
const APPLY_PATH = "/revit/apply-room-receptacles-from-analog";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function latestResult(req: ChatRequest, path: string): ToolResult | null {
  const results = Array.isArray(req.tool_results) ? req.tool_results : [];
  for (let index = results.length - 1; index >= 0; index--) {
    if (results[index]?.path === path) return results[index];
  }
  return null;
}
function payloadFor(result: ToolResult): Record<string, unknown> | null {
  return asRecord(result.result_json);
}

function nestedRoomNumber(payload: Record<string, unknown> | null, key: "source" | "target"): string | null {
  const room = asRecord(payload?.[key]);
  return typeof room?.number === "string" && room.number.trim() ? room.number.trim() : null;
}

function finiteVector(value: unknown): boolean {
  const vector = asRecord(value);
  return !!vector && [vector.x, vector.y, vector.z].every(component => typeof component === "number" && Number.isFinite(component));
}

function verifiedApplyReceipt(payload: Record<string, unknown> | null): { createdIds: number[]; readback: Record<string, unknown>[]; typeCounts: Record<string, unknown>[] } | null {
  if (!payload || payload.applied !== true || payload.status !== "applied" || typeof payload.planHash !== "string" || !payload.planHash.trim()) return null;
  const targetRoomNumber = nestedRoomNumber(payload, "target");
  if (!targetRoomNumber) return null;
  const createdIds = Array.isArray(payload.createdIds) ? payload.createdIds.filter(id => Number.isSafeInteger(id) && (id as number) > 0) as number[] : [];
  if (createdIds.length === 0 || createdIds.length !== (payload.createdIds as unknown[]).length || new Set(createdIds).size !== createdIds.length) return null;
  const readback = Array.isArray(payload.readback) ? payload.readback.map(asRecord) : [];
  if (readback.some(value => value === null) || readback.length !== createdIds.length) return null;
  const records = readback as Record<string, unknown>[];
  const returnedIds = records.map(record => record.id);
  if (returnedIds.some(id => !Number.isSafeInteger(id)) || new Set(returnedIds).size !== createdIds.length || createdIds.some(id => !returnedIds.includes(id))) return null;
  for (const record of records) {
    const orientation = asRecord(record.orientation);
    const physicalHost = asRecord(record.physicalHost);
    const semanticAnchor = asRecord(record.semanticAnchor);
    if (record.targetRoomNumber !== targetRoomNumber || typeof record.family !== "string" || !record.family.trim() || typeof record.type !== "string" || !record.type.trim()) return null;
    if (!finiteVector(record.point) || !orientation || !finiteVector(orientation.hand) || !finiteVector(orientation.expected)) return null;
    if (typeof orientation.agreement !== "number" || !Number.isFinite(orientation.agreement) || orientation.agreement < 0.98) return null;
    if (typeof orientation.facingAgreement !== "number" || !Number.isFinite(orientation.facingAgreement) || orientation.facingAgreement < 0.95) return null;
    if (!physicalHost || !Number.isSafeInteger(physicalHost.linkInstanceId) || !Number.isSafeInteger(physicalHost.linkedElementId) || typeof physicalHost.faceFingerprint !== "string" || !physicalHost.faceFingerprint.trim()) return null;
    const validAnchor = (value: unknown) => value === null || (typeof value === "string" && !!value.trim());
    if (!semanticAnchor || !validAnchor(semanticAnchor.source) || !validAnchor(semanticAnchor.target)) return null;
  }
  const typeCounts = Array.isArray(payload.typeCounts) ? payload.typeCounts.map(asRecord) : [];
  if (typeCounts.some(value => value === null) || typeCounts.reduce((sum, value) => sum + (Number.isSafeInteger(value?.count) ? value!.count as number : -createdIds.length), 0) !== createdIds.length) return null;
  if (typeCounts.some(value => typeof value?.familyType !== "string" || !value.familyType.trim() || !Number.isSafeInteger(value.count) || (value.count as number) <= 0)) return null;
  return { createdIds, readback: records, typeCounts: typeCounts as Record<string, unknown>[] };
}

function failureMessage(stage: "preview" | "apply", result: ToolResult): string {
  const detail = (result.error || result.failure_hint || result.failure_code || `${stage} failed`).trim();
  if (stage === "apply") {
    return `I could not verify completion of the Room receptacle apply. The current Room inventory must be read back before any retry; no further model actions were attempted. ${detail}`;
  }
  return `I could not complete the Room receptacle preview. No model changes were made. ${detail}`;
}

export function maybeRunDeterministicRoomReceptacleAnalog(req: ChatRequest, intent: AecTaskIntentV1 | null = null): ChatResponse | null {
  const planResult = latestResult(req, PLAN_PATH);
  const applyResult = latestResult(req, APPLY_PATH);
  const initialRoom = intent?.target.room_number ?? null;

  if (!planResult && !applyResult && !initialRoom) return null;

  if (!planResult && !applyResult && initialRoom) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `Preparing and validating the office-standard receptacle layout for Room ${initialRoom}…`,
      actions: [{
        action_id: randomUUID(),
        method: "POST",
        path: PLAN_PATH,
        body: {
          targetRoomNumber: initialRoom,
          ...(intent?.reference.kind === "room" && intent.reference.room_number ? { sourceRoomNumber: intent.reference.room_number } : {}),
          includePreviewImage: true
        }
      }]
    };
  }

  if (planResult && !applyResult) {
    if (planResult.status !== "done") {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: failureMessage("preview", planResult), actions: [] };
    }
    const plan = payloadFor(planResult);
    const targetRoomNumber = nestedRoomNumber(plan, "target");
    const sourceRoomNumber = nestedRoomNumber(plan, "source");
    const planHash = typeof plan?.planHash === "string" ? plan.planHash : "";
    const ready = plan?.ready === true && plan?.status === "ready" && !!targetRoomNumber && !!sourceRoomNumber && !!planHash;
    if (!ready) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: "The rollback preview did not produce a complete, hash-bound analog plan, so I stopped without changing the model.",
        actions: []
      };
    }
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `The rollback preview verified the Room ${targetRoomNumber} layout against analog Room ${sourceRoomNumber}. Applying the same hash-bound plan…`,
      actions: [{
        action_id: randomUUID(),
        method: "POST",
        path: APPLY_PATH,
        body: { targetRoomNumber, sourceRoomNumber, planHash, includePreviewImage: true }
      }]
    };
  }

  if (applyResult) {
    if (applyResult.status !== "done") {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: failureMessage("apply", applyResult), actions: [] };
    }
    const applied = payloadFor(applyResult);
    const targetRoomNumber = nestedRoomNumber(applied, "target") ?? "target room";
    const sourceRoomNumber = nestedRoomNumber(applied, "source") ?? "verified analog";
    const receipt = verifiedApplyReceipt(applied);
    const createdIds = receipt?.createdIds ?? [];
    const typeCounts = receipt?.typeCounts ?? [];
    const warnings = Array.isArray(applied?.warnings) ? applied.warnings.filter(value => typeof value === "string") as string[] : [];
    if (!receipt) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: "The apply call did not return a complete persistent inventory/readback receipt, so I cannot claim the layout is complete.",
        actions: []
      };
    }
    const types = typeCounts
      .map(value => `${String(value.familyType ?? "receptacle")}: ${String(value.count ?? "?")}`)
      .join("; ");
    const previewCleanupUnproven = warnings.some(value => value.startsWith("post_apply_preview_cleanup_failed:"));
    const previewUnavailable = warnings.some(value => value.startsWith("post_apply_preview_unavailable:"));
    const previewNote = previewCleanupUnproven
      ? " The model write and native element readback passed, but preview-decoration cleanup could not be proven; inspect the current view before treating visual verification as complete."
      : previewUnavailable
        ? " The model write and native element readback passed, but the optional post-apply preview image was unavailable; visual confirmation remains a follow-up."
        : "";
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `Room ${targetRoomNumber} is complete. I placed and natively verified ${createdIds.length} receptacles using Room ${sourceRoomNumber} as the project-standard analog${types ? ` (${types})` : ""}. The model write was atomic and the returned host, position, orientation, type, and room readback all passed.${previewNote}`,
      actions: []
    };
  }

  return null;
}
export const __testOnlyVerifiedAnalogApplyReceipt = verifiedApplyReceipt;
