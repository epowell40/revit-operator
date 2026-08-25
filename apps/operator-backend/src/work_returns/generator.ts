import { createHash } from "node:crypto";

import { normalizeAssignmentControlPlane, reduceAssignmentControlPlane } from "../assignments/control_plane.js";
import type { GoalRecord } from "../goals/service.js";
import type { VerifiedWorkPacketV1 } from "../work_packets/contract.js";
import { WORK_RETURN_SCHEMA, type WorkReturnV1 } from "./contract.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonical(nested)]));
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

export function generateWorkReturn(
  goal: GoalRecord,
  parentWorkReturnId: string | null = null,
  packet: VerifiedWorkPacketV1 | null = null
): WorkReturnV1 {
  const projection = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
  const pending = projection.clarifications.find(item => item.clarification_id === projection.pending_clarification_id) ?? null;
  const completed = [
    ...goal.work_items.filter(item => item.status === "complete").map(item => item.result_summary || item.title),
    ...projection.criteria.filter(item => item.state === "pass" || item.state === "partial").map(item => item.criterion),
    ...(pending?.completed_work ?? [])
  ].filter((value, index, values) => values.indexOf(value) === index).slice(0, 80);
  const openItems = projection.criteria.filter(item => !["pass", "not_applicable"].includes(item.state))
    .map(item => `${item.criterion}: ${item.reason || item.state}`);
  openItems.push(...goal.work_items.filter(item => ["blocked", "failed"].includes(item.status))
    .map(item => `${item.title}: ${item.blocker || item.result_summary || item.status}`));
  if (pending) openItems.push(...pending.affected_subtasks.map(item => `${item}: awaiting input`));
  const affectedTargets = [...new Set(projection.attempts.flatMap(attempt => [
    ...attempt.target_identities,
    ...attempt.affected_target_identities
  ]))].slice(0, 200);
  const visualRefs = projection.primary_artifact_refs.filter(ref => /(?:capture|image|png|jpe?g|view)/i.test(ref)).slice(0, 20);
  const body: Omit<WorkReturnV1, "work_return_id" | "work_return_hash"> = {
    schema: WORK_RETURN_SCHEMA,
    parent_work_return_id: parentWorkReturnId,
    assignment_id: goal.id,
    run_id: projection.run_id,
    generation: projection.generation,
    created_at: projection.last_event_at ?? goal.updated_at,
    status: projection.outcome_state,
    requested_effect: projection.requested_effect,
    status_reason: projection.terminal_reason ?? pending?.reason ?? goal.current_step ?? "Work remains active.",
    completed,
    primary_artifacts: [...new Set([
      ...projection.primary_artifact_refs,
      ...goal.work_items.filter(item => item.status === "complete" || item.safe_to_retain).flatMap(item => item.primary_artifact_refs ?? [])
    ])],
    deviations_or_open_items: [...new Set(openItems)].slice(0, 80),
    question: pending?.question ?? null,
    clarification_id: pending?.clarification_id ?? null,
    recommended_next_step: pending
      ? "Answer the focused question so I can resume this same Assignment from the unresolved work."
      : projection.terminal_state === "open" ? "Continue the next ready work unit."
        : projection.outcome_state === "complete" || projection.outcome_state === "verified_noop"
          ? "Review the primary artifact; expand the audit packet only if needed."
          : "Review the listed issue and retained primary artifact before deciding whether to resume.",
    affected_targets: affectedTargets,
    visual_refs: visualRefs,
    audit_packet_id: packet?.packet_id ?? null
  };
  const digest = hash(body);
  return {
    ...body,
    work_return_id: `wr1_${Buffer.from(digest, "hex").toString("base64url").slice(0, 32)}`,
    work_return_hash: `sha256:${digest}`
  };
}

export function verifyWorkReturnHash(workReturn: WorkReturnV1): boolean {
  const { work_return_id: _id, work_return_hash: claimed, ...body } = workReturn;
  const digest = hash(body);
  return claimed === `sha256:${digest}`
    && workReturn.work_return_id === `wr1_${Buffer.from(digest, "hex").toString("base64url").slice(0, 32)}`;
}

export function renderWorkReturnMarkdown(workReturn: WorkReturnV1): string {
  const lines = [
    `# ${workReturn.status.replaceAll("_", " ").replace(/\b\w/g, value => value.toUpperCase())}`,
    "",
    workReturn.status_reason,
    "",
    "## Completed",
    "",
    ...(workReturn.completed.length ? workReturn.completed.map(item => `- ${item}`) : ["- No completed work has been established yet."]),
    "",
    "## Primary Artifact",
    "",
    ...(workReturn.primary_artifacts.length ? workReturn.primary_artifacts.map(item => `- ${item}`) : ["- No primary artifact has been recorded yet."]),
    "",
    "## Deviations or Open Items",
    "",
    ...(workReturn.deviations_or_open_items.length ? workReturn.deviations_or_open_items.map(item => `- ${item}`) : ["- None."])
  ];
  if (workReturn.question) lines.push("", "## Question", "", workReturn.question);
  lines.push("", "## Recommended Next Step", "", workReturn.recommended_next_step, "");
  return lines.join("\n");
}
