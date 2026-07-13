import { randomUUID } from "node:crypto";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ChatResponse, type ToolResult } from "../contracts.js";
import type { AecTaskIntentV1 } from "../aec_task_intent.js";
import { appendGoalProgress, getActiveGoalForSession, setAgentGoal, updateGoal } from "../goals/service.js";

const PLAN_PATH = "/revit/plan-room-receptacles-from-analog";
const APPLY_PATH = "/revit/apply-room-receptacles-from-analog";
const MATCH_SOURCE_CIRCUIT_MODE = "match_source_system";

function requestedCircuitMode(intent: AecTaskIntentV1 | null): "none" | "match_source_system" {
  const text = intent?.evidence.user_text ?? "";
  const explicitCircuitMatch = /\b(?:same|match|copy|mirror|include|assign)\b.{0,48}\b(?:circuits?|panels?)\b/i.test(text)
    || /\b(?:circuits?|panels?)\b.{0,48}\b(?:same|match|copy|mirror|include|assign)\b/i.test(text)
    || /\bwire(?:d|ing)?\b/i.test(text);
  return explicitCircuitMatch ? MATCH_SOURCE_CIRCUIT_MODE : "none";
}

function payloadCircuitMode(payload: Record<string, unknown> | null): "none" | "match_source_system" {
  const validation = asRecord(payload?.circuitValidation);
  return validation?.mode === MATCH_SOURCE_CIRCUIT_MODE ? MATCH_SOURCE_CIRCUIT_MODE : "none";
}

function ensureRoomDesignGoal(req: ChatRequest, intent: AecTaskIntentV1, roomNumber: string): void {
  const objective = intent.evidence.user_text.trim() || `Lay out receptacles in Room ${roomNumber}.`;
  const active = getActiveGoalForSession(req.session_id);
  const sameObjective = !!active && active.objective.trim().toLocaleLowerCase() === objective.toLocaleLowerCase();
  const context = req.context && typeof req.context === "object" && !Array.isArray(req.context) ? req.context as Record<string, unknown> : null;
  const ui = context?.ui && typeof context.ui === "object" && !Array.isArray(context.ui) ? context.ui as Record<string, unknown> : null;
  const authoritative = typeof ui?.authoritative_user_text === "string" ? ui.authoritative_user_text.trim() : "";
  const replaceableAutoGoal = !!active && active.created_by === "auto_goal:chat" && active.related_session_id === req.session_id && (sameObjective || authoritative === objective) && active.work_items.length === 0 && active.evidence_log.length === 0 && active.action_log.length === 0 && active.validation_log.length === 0;
  if (active && !replaceableAutoGoal) return;
  setAgentGoal(req.session_id, {
    title: `Design receptacle layout in Room ${roomNumber}`,
    objective,
    success_criteria: [
      `Room ${roomNumber} receives a grounded project-standard receptacle layout without duplicates.`,
      "Every created device has exact type, room, host, position, and orientation readback.",
      "Focused visual verification remains explicit and unresolved failures do not trigger broad retries."
    ],
    current_phase: "precedent_discovery",
    current_step: "Discover and validate the strongest available project analog",
    progress_summary: `Target Room ${roomNumber} is grounded; bounded project-precedent discovery is next.`,
    work_items: [
      { id: "target.inspect", title: `Inspect Room ${roomNumber} geometry and existing receptacles`, status: "in_progress", scope: { room_number: roomNumber }, planned_actions: ["native room and anchor inventory"] },
      { id: "precedent.resolve", title: "Resolve the strongest applicable project precedent", status: "ready", scope: { target_room_number: roomNumber }, depends_on: ["target.inspect"], planned_actions: ["score same-level furnished analogs", "record selected precedent and assumptions"] },
      { id: "layout.preview", title: "Rollback-preview the exact mapped layout", status: "pending", scope: { target_room_number: roomNumber }, depends_on: ["precedent.resolve"], planned_actions: ["hash-bound native preview"] },
      { id: "layout.apply", title: "Apply the verified hash-bound layout", status: "pending", scope: { target_room_number: roomNumber }, depends_on: ["layout.preview"], planned_actions: ["atomic apply", "exact created-id receipt"] },
      { id: "layout.verify", title: "Verify device type, room, host, position, and orientation", status: "pending", scope: { target_room_number: roomNumber }, depends_on: ["layout.apply"], planned_actions: ["native persistent readback"] },
      { id: "verify.visual", title: `Perform focused visual QA in Room ${roomNumber}`, status: "pending", scope: { room_number: roomNumber }, depends_on: ["layout.verify"], planned_actions: ["focused Revit inspection", "bounded repair if needed"] }
    ],
    assumptions: [{ id: "reference.hierarchy", statement: "Use explicit direction first, then a uniquely grounded current-project analog before office/code baselines.", status: "accepted", basis: intent.reference.kind === "room" ? "explicit source room" : "office-standard project workflow" }],
    work_budget: { mode: "room_receptacle_design", target_rooms: 1, conversational_permission_loops: 0 }
  });
}

function appendRoomDesignProgress(sessionId: string, entry: unknown): void {
  if (!getActiveGoalForSession(sessionId)) return;
  appendGoalProgress(sessionId, entry);
}

function updateRoomDesignPhase(sessionId: string, currentPhase: string, currentStep: string): void {
  const goal = getActiveGoalForSession(sessionId);
  if (!goal) return;
  updateGoal(goal.id, { current_phase: currentPhase, current_step: currentStep });
}

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
  const circuitValidation = asRecord(payload.circuitValidation);
  if (circuitValidation?.mode === MATCH_SOURCE_CIRCUIT_MODE) {
    const assignments = Array.isArray(circuitValidation.assignments) ? circuitValidation.assignments.map(asRecord) : [];
    if (circuitValidation.verified !== true || assignments.length !== createdIds.length || assignments.some(value => value?.exactMatch !== true)) return null;
  }
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
    ensureRoomDesignGoal(req, intent!, initialRoom);
    const circuitMode = requestedCircuitMode(intent);
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
          ...(circuitMode === MATCH_SOURCE_CIRCUIT_MODE ? { circuitMode } : {}),
          includePreviewImage: true
        }
      }]
    };
  }

  if (planResult && !applyResult) {
    if (planResult.status !== "done") {
      appendRoomDesignProgress(req.session_id, { summary: "Bounded project-precedent discovery failed; no model changes were made.", work_item: { id: "precedent.resolve", title: "Resolve the strongest applicable project precedent", status: "blocked", scope: null, depends_on: ["target.inspect"], planned_actions: ["score same-level furnished analogs", "record selected precedent and assumptions"], blocker: planResult.error || planResult.failure_hint || "Analog preview failed.", evidence_refs: [`action:${planResult.action_id}`] } });
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: failureMessage("preview", planResult), actions: [] };
    }
    const plan = payloadFor(planResult);
    const targetRoomNumber = nestedRoomNumber(plan, "target");
    const sourceRoomNumber = nestedRoomNumber(plan, "source");
    const planHash = typeof plan?.planHash === "string" ? plan.planHash : "";
    const circuitMode = payloadCircuitMode(plan);
    const ready = plan?.ready === true && plan?.status === "ready" && !!targetRoomNumber && !!sourceRoomNumber && !!planHash;
    if (!ready) {
      appendRoomDesignProgress(req.session_id, { summary: "The analog preview did not establish a unique hash-bound project precedent.", work_items: [{ id: "precedent.resolve", title: "Resolve the strongest applicable project precedent", status: "blocked", scope: null, depends_on: ["target.inspect"], planned_actions: ["score same-level furnished analogs", "record selected precedent and assumptions"], blocker: "No complete unique analog plan was returned.", evidence_refs: [`action:${planResult.action_id}`] }, { id: "layout.preview", title: "Rollback-preview the exact mapped layout", status: "blocked", scope: null, depends_on: ["precedent.resolve"], planned_actions: ["hash-bound native preview"], blocker: "Project precedent remains unresolved.", evidence_refs: [`action:${planResult.action_id}`] }] });
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: "The rollback preview did not produce a complete, hash-bound analog plan, so I stopped without changing the model.",
        actions: []
      };
    }
    const groundedScope = { target_room_number: targetRoomNumber, source_room_number: sourceRoomNumber };
    appendRoomDesignProgress(req.session_id, {
      summary: `Selected Room ${sourceRoomNumber} as the unique current-project precedent and verified a hash-bound rollback preview for Room ${targetRoomNumber}.`,
      assumptions: [{ id: "precedent.room", statement: `Room ${sourceRoomNumber} is the selected current-project analog for target Room ${targetRoomNumber}.`, status: "accepted", basis: "native same-level geometry, anchor, adjacency, and exact device-inventory scoring", evidence_refs: [`action:${planResult.action_id}`] }],
      work_items: [
        { id: "target.inspect", title: `Inspect Room ${targetRoomNumber} geometry and existing receptacles`, status: "complete", scope: { room_number: targetRoomNumber }, planned_actions: ["native room and anchor inventory"], evidence_refs: [`action:${planResult.action_id}`], result_summary: "Target room and anchor geometry were resolved natively." },
        { id: "precedent.resolve", title: "Resolve the strongest applicable project precedent", status: "complete", scope: groundedScope, depends_on: ["target.inspect"], planned_actions: ["score same-level furnished analogs", "record selected precedent and assumptions"], evidence_refs: [`action:${planResult.action_id}`], result_summary: `Unique project analog Room ${sourceRoomNumber} selected.` },
        { id: "layout.preview", title: "Rollback-preview the exact mapped layout", status: "complete", scope: groundedScope, depends_on: ["precedent.resolve"], planned_actions: ["hash-bound native preview"], evidence_refs: [`action:${planResult.action_id}`], result_summary: `Hash-bound plan ${planHash} verified with no persistent model change.` },
        { id: "layout.apply", title: "Apply the verified hash-bound layout", status: "ready", scope: groundedScope, depends_on: ["layout.preview"], planned_actions: ["atomic apply", "exact created-id receipt"] }
      ]
    });
    updateRoomDesignPhase(req.session_id, "layout_execution", `Apply the verified Room ${sourceRoomNumber} analog in Room ${targetRoomNumber}`);
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `The rollback preview verified the Room ${targetRoomNumber} layout against analog Room ${sourceRoomNumber}. Applying the same hash-bound plan…`,
      actions: [{
        action_id: randomUUID(),
        method: "POST",
        path: APPLY_PATH,
        body: { targetRoomNumber, sourceRoomNumber, planHash, ...(circuitMode === MATCH_SOURCE_CIRCUIT_MODE ? { circuitMode } : {}), includePreviewImage: true }
      }]
    };
  }

  if (applyResult) {
    if (applyResult.status !== "done") {
      appendRoomDesignProgress(req.session_id, { summary: "The atomic apply failed and no broad or conversational recovery was attempted.", work_item: { id: "layout.apply", title: "Apply the verified hash-bound layout", status: "failed", scope: null, depends_on: ["layout.preview"], planned_actions: ["atomic apply", "exact created-id receipt"], blocker: applyResult.error || applyResult.failure_hint || "Apply failed.", evidence_refs: [`action:${applyResult.action_id}`] } });
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
      appendRoomDesignProgress(req.session_id, { summary: "Apply returned without complete exact persistent readback, so completion is not claimed.", work_items: [{ id: "layout.apply", title: "Apply the verified hash-bound layout", status: "blocked", scope: null, depends_on: ["layout.preview"], planned_actions: ["atomic apply", "exact created-id receipt"], blocker: "Created IDs or persistent readback were incomplete.", evidence_refs: [`action:${applyResult.action_id}`] }, { id: "layout.verify", title: "Verify device type, room, host, position, and orientation", status: "blocked", scope: null, depends_on: ["layout.apply"], planned_actions: ["native persistent readback"], blocker: "Persistent readback is incomplete.", evidence_refs: [`action:${applyResult.action_id}`] }] });
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
    const circuitValidation = asRecord(applied?.circuitValidation);
    const circuitNote = circuitValidation?.mode === MATCH_SOURCE_CIRCUIT_MODE
      ? circuitValidation.engineeringReviewRequired === true
        ? ` Exact source circuit-state parity passed, including ${String(circuitValidation.assignedCount ?? "the assigned")} real system memberships; ${String(circuitValidation.unassignedCount ?? "one or more")} source-matched device(s) remain intentionally unassigned and require engineering review.`
        : " Every created device was verified on its exact source power-system ID. This is factual membership/load readback, not a capacity or code-compliance determination."
      : "";
    appendRoomDesignProgress(req.session_id, {
      summary: `Atomic Room ${targetRoomNumber} apply and native persistent readback passed for ${createdIds.length} receptacle(s) using Room ${sourceRoomNumber}.`,
      work_items: [
        { id: "layout.apply", title: "Apply the verified hash-bound layout", status: "complete", scope: { target_room_number: targetRoomNumber, source_room_number: sourceRoomNumber }, depends_on: ["layout.preview"], planned_actions: ["atomic apply", "exact created-id receipt"], evidence_refs: [`action:${applyResult.action_id}`], result_summary: `${createdIds.length} unique receptacle IDs created atomically.` },
        { id: "layout.verify", title: "Verify device type, room, host, position, and orientation", status: "complete", scope: { target_room_number: targetRoomNumber, source_room_number: sourceRoomNumber }, depends_on: ["layout.apply"], planned_actions: ["native persistent readback"], evidence_refs: [`action:${applyResult.action_id}`], result_summary: "Exact ID, type, room, physical host, point, and orientation readback passed for every created device." },
        { id: "verify.visual", title: `Perform focused visual QA in Room ${targetRoomNumber}`, status: "ready", scope: { room_number: targetRoomNumber }, depends_on: ["layout.verify"], planned_actions: ["focused Revit inspection", "bounded repair if needed"], evidence_refs: [`action:${applyResult.action_id}`], result_summary: previewNote ? "Native readback passed; focused visual follow-up remains required by the preview warning." : "Native readback passed; focused human-style Revit inspection is queued." }
      ]
    });
    updateRoomDesignPhase(req.session_id, "visual_verification", `Perform focused visual QA in Room ${targetRoomNumber}`);
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `Room ${targetRoomNumber} is complete. I placed and natively verified ${createdIds.length} receptacles using Room ${sourceRoomNumber} as the project-standard analog${types ? ` (${types})` : ""}. The model write was atomic and the returned host, position, orientation, type, and room readback all passed.${circuitNote}${previewNote}`,
      actions: []
    };
  }

  return null;
}
export const __testOnlyVerifiedAnalogApplyReceipt = verifiedApplyReceipt;
