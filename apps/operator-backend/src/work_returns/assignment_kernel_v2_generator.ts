import { createHash } from "node:crypto";
import type { AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { reportedOperationTargetIdentitiesV2 } from "../domain/assignment-kernel/operation_target_identity.js";
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

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

export function generateWorkReturnFromKernelV2(
  goal: GoalRecord,
  snapshot: AssignmentSnapshotV2,
  parentWorkReturnId: string | null,
  packet: VerifiedWorkPacketV1 | null
): WorkReturnV1 {
  const pending = Object.values(snapshot.clarifications).find(item => !item.resolved_at) ?? null;
  const completed = snapshot.spec.criteria.flatMap(spec => {
    const evaluation = snapshot.criteria[spec.criterion_id];
    return evaluation?.status === "pass" || evaluation?.status === "partial" ? [spec.requirement] : [];
  });
  const open = snapshot.spec.criteria.flatMap(spec => {
    const evaluation = snapshot.criteria[spec.criterion_id];
    return !evaluation || !["pass", "not_applicable"].includes(evaluation.status)
      ? [`${spec.requirement}: ${evaluation?.reason ?? "not yet evaluated"}`] : [];
  });
  const targets = [...new Set(Object.values(snapshot.operations)
    .flatMap(operation => reportedOperationTargetIdentitiesV2(operation)))].sort();
  const primaryArtifacts = [...new Set(Object.values(snapshot.observations).map(observation => observation.raw_payload_ref))];
  const body: Omit<WorkReturnV1, "work_return_id" | "work_return_hash"> = {
    schema: WORK_RETURN_SCHEMA,
    parent_work_return_id: parentWorkReturnId,
    assignment_id: goal.id,
    run_id: snapshot.current_binding.run_id,
    generation: snapshot.current_binding.generation,
    created_at: snapshot.finished_at ?? goal.updated_at,
    status: snapshot.outcome,
    requested_effect: snapshot.spec.requested_effect,
    status_reason: snapshot.terminal_reason ?? (pending ? "Required user input is missing." : "Assignment remains active."),
    completed: [...new Set(completed)],
    primary_artifacts: primaryArtifacts,
    deviations_or_open_items: [...new Set([
      ...open,
      ...snapshot.unresolved_unknown_operation_ids.map(id => `Operation ${id} requires reconciliation.`)
    ])],
    question: pending?.question ?? null,
    clarification_id: pending?.clarification_id ?? null,
    recommended_next_step: pending
      ? "Answer the focused question so this same Assignment can resume from retained work."
      : snapshot.terminal ? "Review the primary artifact and expand the audit packet only if needed."
        : "Continue the next unresolved criterion or work unit.",
    affected_targets: targets,
    visual_refs: primaryArtifacts.filter(ref => /(?:capture|image|png|jpe?g)/i.test(ref)),
    audit_packet_id: packet?.packet_id ?? null
  };
  const hash = digest(body);
  return { ...body, work_return_id: `wr1_${Buffer.from(hash, "hex").toString("base64url").slice(0, 32)}`, work_return_hash: `sha256:${hash}` };
}
