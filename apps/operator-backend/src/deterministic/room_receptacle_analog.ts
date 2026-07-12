import { randomUUID } from "node:crypto";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ChatResponse, type ToolResult } from "../contracts.js";

const PLAN_PATH = "/revit/plan-room-receptacles-from-analog";
const APPLY_PATH = "/revit/apply-room-receptacles-from-analog";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function roomNumberFromIntent(text: string): string | null {
  if (!/\b(receptacles?|outlets?)\b/i.test(text) || !/\boffice\s+standards?\b/i.test(text)) return null;
  if (!/\b(layout|lay\s*out|place|add|reposition|replace|rework)\b/i.test(text)) return null;
  const matches = [...text.matchAll(/\broom\s+#?([A-Za-z0-9][A-Za-z0-9._-]{0,31})\b/gi)].map(match => match[1]);
  if (matches.length === 0 || new Set(matches.map(value => value.toLowerCase())).size !== 1) return null;
  return matches[0];
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

function failureMessage(stage: "preview" | "apply", result: ToolResult): string {
  const detail = (result.error || result.failure_hint || result.failure_code || `${stage} failed`).trim();
  if (stage === "apply") {
    return `I could not verify completion of the Room receptacle apply. The current Room inventory must be read back before any retry; no further model actions were attempted. ${detail}`;
  }
  return `I could not complete the Room receptacle preview. No model changes were made. ${detail}`;
}

export function maybeRunDeterministicRoomReceptacleAnalog(req: ChatRequest): ChatResponse | null {
  const planResult = latestResult(req, PLAN_PATH);
  const applyResult = latestResult(req, APPLY_PATH);
  const initialRoom = roomNumberFromIntent((req.user_text ?? "").trim());

  if (!planResult && !applyResult && !initialRoom) return null;

  if (!planResult && !applyResult && initialRoom) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `Preparing and validating the office-standard receptacle layout for Room ${initialRoom}…`,
      actions: [{
        action_id: randomUUID(),
        method: "POST",
        path: PLAN_PATH,
        body: { targetRoomNumber: initialRoom, includePreviewImage: true }
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
    const createdIds = Array.isArray(applied?.createdIds) ? applied.createdIds.filter(id => Number.isInteger(id)) : [];
    const typeCounts = Array.isArray(applied?.typeCounts)
      ? applied.typeCounts.map(value => asRecord(value)).filter((value): value is Record<string, unknown> => !!value)
      : [];
    const readback = Array.isArray(applied?.readback) ? applied.readback : [];
    const warnings = Array.isArray(applied?.warnings) ? applied.warnings.filter(value => typeof value === "string") as string[] : [];
    const verified = applied?.applied === true && applied?.status === "applied" && createdIds.length > 0 && readback.length === createdIds.length;
    if (!verified) {
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

export const __testOnlyRoomReceptacleIntent = roomNumberFromIntent;
