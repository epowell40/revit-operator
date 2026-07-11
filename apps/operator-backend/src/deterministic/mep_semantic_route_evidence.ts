import { AEC_INTENT_EVIDENCE_MAX_IDENTIFIER_CHARS, AEC_INTENT_EVIDENCE_MAX_STRING_CHARS, AEC_INTENT_EVIDENCE_V1_SCHEMA, normalizeAecIntentEvidenceV1, type AecIntentEvidenceV1 } from "../aec_intent_evidence.js";
import type { ActionCall } from "../contracts.js";
import type { MepSemanticRouteRequest, MepSemanticRouteResponse } from "./mep_semantic_route.js";

export type MepSemanticEvidenceAdapterOptions = {
  id: string;
  created_at: string;
  correlation?: AecIntentEvidenceV1["correlation"];
  host?: AecIntentEvidenceV1["origin"]["host"];
};

function confidenceValue(value: string | undefined): number {
  if (value === "high") return 0.8;
  if (value === "medium") return 0.5;
  return 0.2;
}

function actionBody(action: ActionCall): Record<string, unknown> {
  if (!action.body || typeof action.body !== "object" || Array.isArray(action.body)) return {};
  return Object.fromEntries(Object.entries(action.body as Record<string, unknown>).filter(([, value]) => value !== undefined));
}

function targetStatus(response: MepSemanticRouteResponse): "resolved" | "ambiguous" | "unresolved" {
  const target = response.plan?.targets[0];
  if (!target || target.strategy === "unresolved") return "unresolved";
  if (response.plan?.blockers.length || target.strategy === "all_visible_targets") return "ambiguous";
  return target.element_id === undefined ? "unresolved" : "resolved";
}

function unique(lines: string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}

function explicitRoomScopeFromUserText(userText: string): string | undefined {
  if (userText.length > AEC_INTENT_EVIDENCE_MAX_STRING_CHARS) return undefined;
  const matches = [...userText.matchAll(/\broom\s+(\d+)(?![A-Za-z0-9_]|\.\d)/gi)];
  if (!matches.length || /\brooms?\s+(?:#\d+|\d+(?:[A-Za-z_]|\.\d))/i.test(userText)) return undefined;
  const rooms = new Set<string>();
  for (const match of matches) {
    const room = match[1]!;
    const trailing = userText.slice((match.index ?? 0) + match[0].length);
    if (room.length > AEC_INTENT_EVIDENCE_MAX_IDENTIFIER_CHARS || /^(?:\s*(?:\+|-|–|—|\/|,|&|;|:|\\|and\b|or\b|to\b|through\b|thru\b)\s*(?:room\s*)?\d+\b|\s+(?:(?:room\s*)?\d+)\b)/i.test(trailing)) return undefined;
    rooms.add(room);
  }
  return rooms.size === 1 ? rooms.values().next().value : undefined;
}

export function adaptMepSemanticRoutePlanToAecIntentEvidence(
  request: MepSemanticRouteRequest,
  response: MepSemanticRouteResponse,
  options: MepSemanticEvidenceAdapterOptions
): AecIntentEvidenceV1 {
  const plan = response.plan;
  const resolvedTargetStatus = targetStatus(response);
  const targetElementIds = plan?.targets.flatMap((target) => target.element_id === undefined ? [] : [target.element_id]) ?? [];
  const confidenceReason = plan ? `planner_confidence:${plan.confidence}` : `planner_status:${response.status}`;
  const viewId = request.view_id ?? request.viewId;
  const rawUserText = request.user_text ?? "";
  const structuredRoomNumber = request.room_number ?? request.roomNumber;
  const normalizedStructuredRoomNumber = typeof structuredRoomNumber === "string" ? structuredRoomNumber.trim() : undefined;
  const roomNumber = structuredRoomNumber !== undefined
    ? normalizedStructuredRoomNumber && normalizedStructuredRoomNumber.length <= AEC_INTENT_EVIDENCE_MAX_IDENTIFIER_CHARS ? normalizedStructuredRoomNumber : undefined
    : explicitRoomScopeFromUserText(rawUserText);
  const levelName = request.level_name ?? request.levelName;
  const userText = rawUserText.slice(0, AEC_INTENT_EVIDENCE_MAX_STRING_CHARS);

  return normalizeAecIntentEvidenceV1({
    schema: AEC_INTENT_EVIDENCE_V1_SCHEMA,
    id: options.id,
    revision: 1,
    created_at: options.created_at,
    correlation: options.correlation ?? {},
    origin: {
      host: options.host ?? { kind: "other", name: "revit-operator-backend" },
      producer: { kind: "deterministic", name: "mep_semantic_route" }
    },
    evidence: [{ id: "user_text", kind: "user_text", source: { kind: "request", field: "user_text" }, text: userText, ...(rawUserText.length > userText.length ? { text_truncated: true } : {}), confidence: 1 }],
    coordinate_frames: [],
    target: {
      status: resolvedTargetStatus,
      ...(viewId === undefined ? {} : { view: { id: viewId } }),
      ...(levelName || roomNumber || targetElementIds.length ? { location: {
        ...(levelName ? { level: levelName } : {}),
        ...(roomNumber ? { room_or_space: roomNumber } : {}),
        ...(targetElementIds.length ? { element_ids: targetElementIds } : {})
      } } : {})
    },
    intent: {
      domain: "mep",
      action: plan?.operation ?? "semantic_mep_route",
      proposed_actions: response.next_actions.map((action) => ({ tool: action.path, body: actionBody(action), requires_apply: false }))
    },
    constraints: unique([...(plan?.blockers ?? []), ...(plan?.blockers.length ? [] : response.blocker ? [response.blocker] : [])]),
    assumptions: [...(plan?.assumptions ?? [])],
    open_questions: [...(plan?.required_discovery ?? [])],
    confidence: { value: confidenceValue(plan?.confidence), basis: "deterministic", reasons: [confidenceReason] },
    verification: {
      required: ["dry_run", "apply", "readback", "visual", "revert"],
      observed: (["dry_run", "apply", "readback", "visual", "revert"] as const).map((gate) => ({ gate, status: "not_run" as const }))
    }
  });
}
