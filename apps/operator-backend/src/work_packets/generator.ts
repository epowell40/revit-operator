import { createHash } from "node:crypto";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../contracts.js";
import {
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptRecord,
  type AssignmentRequestedEffect
} from "../assignments/control_plane.js";
import { readEvidenceRef } from "../evidence/evidence_store.js";
import type { EvidenceRefV1 } from "../evidence/evidence_ref.js";
import type { GoalCriterionResult, GoalRecord } from "../goals/service.js";
import {
  VERIFIED_WORK_PACKET_SCHEMA,
  VERIFIED_WORK_PACKET_VERSION,
  type PacketEvidenceReference,
  type VerifiedWorkAcceptanceCriterion,
  type VerifiedWorkAction,
  type VerifiedWorkArtifact,
  type VerifiedWorkCollateralCheck,
  type VerifiedWorkIssue,
  type VerifiedWorkPacketStatus,
  type VerifiedWorkPacketV1,
  type VerifiedWorkTarget,
  type VerifiedWorkTrust
} from "./contract.js";

type JsonMap = Record<string, unknown>;

function object(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown, max = 200): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n|;/g) : [];
  return [...new Set(values.map(text).filter(Boolean))].slice(0, max);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonical(nested)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function releaseIdentity(): string {
  return text(process.env.OPERATOR_RELEASE_ID)
    || text(process.env.OPERATOR_SOURCE_REVISION)
    || text(process.env.RENDER_GIT_COMMIT)
    || text(process.env.SOURCE_VERSION)
    || `operator-backend-contract:${OPERATOR_BACKEND_CONTRACT_VERSION}`;
}

function screenedAuthorizationEnvelope(value: unknown): JsonMap | null {
  const source = object(value);
  if (!Object.keys(source).length) return null;
  const screen = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.slice(0, 100).map(screen);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate as JsonMap).map(([key, nested]) => [
      key,
      /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|private[_-]?key)/i.test(key)
        ? "[redacted]" : screen(nested)
    ]));
  };
  return canonical(screen(source)) as JsonMap;
}

function trustFromEvidence(ref: EvidenceRefV1): VerifiedWorkTrust {
  if (ref.trust_level === "authoritative_readback") return "independently_verified";
  if (ref.trust_level === "authoritative_native" || ref.trust_level === "host_observed" || ref.trust_level === "trusted_projection") {
    return "native_execution_evidence";
  }
  return "agent_reported";
}

function trustFromAttempt(attempt: AssignmentAttemptRecord): VerifiedWorkTrust {
  if (attempt.verification.state === "passed" || attempt.effect.authority === "target_readback" || attempt.effect.authority === "independent_verifier") {
    return "independently_verified";
  }
  if (["native_host", "native_transaction", "native_receipt", "native_rollback"].includes(attempt.effect.authority)) {
    return "native_execution_evidence";
  }
  if (attempt.effect.authority === "caller_report") return "agent_reported";
  return "uncertain_or_missing";
}

function strongestTrust(values: readonly VerifiedWorkTrust[]): VerifiedWorkTrust {
  if (values.includes("independently_verified")) return "independently_verified";
  if (values.includes("native_execution_evidence")) return "native_execution_evidence";
  if (values.includes("agent_reported")) return "agent_reported";
  return "uncertain_or_missing";
}

function emptyReference(evidenceId: string, trust: VerifiedWorkTrust = "uncertain_or_missing"): PacketEvidenceReference {
  return {
    evidence_id: evidenceId,
    content_hash: null,
    byte_count: null,
    media_type: null,
    artifact_location: null,
    trust,
    verification_relevance: null,
    bounded_summary: null
  };
}

type EvidenceResolver = {
  resolve: (evidenceId: string, fallback?: VerifiedWorkTrust) => PacketEvidenceReference;
  staleIssues: () => VerifiedWorkIssue[];
};

function evidenceResolver(goal: GoalRecord): EvidenceResolver {
  const cache = new Map<string, PacketEvidenceReference>();
  const stale = new Set<string>();
  const validationById = new Map(goal.validation_log.map(entry => [`validation:${entry.id}`, entry]));
  const evidenceById = new Map(goal.evidence_log.map(entry => [`evidence:${entry.id}`, entry]));
  return {
    resolve(evidenceId: string, fallback = "uncertain_or_missing") {
      const id = text(evidenceId);
      if (!id) return emptyReference("missing", "uncertain_or_missing");
      const cached = cache.get(`${id}:${fallback}`);
      if (cached) return cached;
      const validation = validationById.get(id);
      if (validation?.evidence?.kind === "validator") {
        const result = emptyReference(id, validation.evidence.validator.status === "pass" ? "independently_verified" : "uncertain_or_missing");
        result.bounded_summary = validation.summary;
        cache.set(`${id}:${fallback}`, result);
        return result;
      }
      const typed = evidenceById.get(id)?.evidence;
      if (typed?.kind === "artifact") {
        const result: PacketEvidenceReference = {
          evidence_id: id,
          content_hash: `sha256:${typed.artifact.sha256}`,
          byte_count: typed.artifact.size_bytes,
          media_type: null,
          artifact_location: typed.artifact.path,
          trust: "native_execution_evidence",
          verification_relevance: "supporting",
          bounded_summary: evidenceById.get(id)?.summary ?? null
        };
        cache.set(`${id}:${fallback}`, result);
        return result;
      }
      if (typed?.kind === "human_approval") {
        const result = emptyReference(id, "independently_verified");
        result.bounded_summary = evidenceById.get(id)?.summary ?? null;
        cache.set(`${id}:${fallback}`, result);
        return result;
      }
      if (/^ev1_[A-Za-z0-9_-]{32}$/.test(id)) {
        try {
          const ref = readEvidenceRef(id);
          const wrongAssignment = ref.assignment_id !== null && ref.assignment_id !== goal.id;
          const wrongSession = Boolean(goal.related_session_id && ref.session_id !== goal.related_session_id);
          if (wrongAssignment || wrongSession) {
            stale.add(id);
            const result = emptyReference(id, "uncertain_or_missing");
            cache.set(`${id}:${fallback}`, result);
            return result;
          }
          const result: PacketEvidenceReference = {
            evidence_id: ref.evidence_id,
            content_hash: ref.content_hash,
            byte_count: ref.byte_count,
            media_type: ref.media_type,
            artifact_location: ref.artifact_location,
            trust: trustFromEvidence(ref),
            verification_relevance: ref.verification_relevance,
            bounded_summary: ref.bounded_summary
          };
          cache.set(`${id}:${fallback}`, result);
          return result;
        } catch {
          stale.add(id);
        }
      }
      const result = emptyReference(id, fallback);
      cache.set(`${id}:${fallback}`, result);
      return result;
    },
    staleIssues: () => [...stale].sort().map(evidenceId => ({
      kind: "stale_evidence" as const,
      summary: `Evidence ${evidenceId} was unavailable or outside this Assignment scope and was not used to support packet claims.`,
      affected_attempt_ids: [],
      evidence_references: [emptyReference(evidenceId)],
      user_action_required: null
    }))
  };
}

function criterionObservation(workBudget: JsonMap, criterion: string): JsonMap {
  const observations = object(workBudget.criterion_observations);
  return object(observations[criterion]);
}

function criterionAuthority(goal: GoalRecord, result: GoalCriterionResult): string {
  for (const ref of result.evidence_refs) {
    const entry = goal.validation_log.find(candidate => `validation:${candidate.id}` === ref);
    if (entry?.evidence?.kind === "validator") return entry.evidence.validator.identity;
    const evidence = goal.evidence_log.find(candidate => `evidence:${candidate.id}` === ref)?.evidence;
    if (evidence?.kind === "artifact") return "workspace_hash_verification";
    if (evidence?.kind === "human_approval") return evidence.approval.approver_role;
  }
  return "missing_authority";
}

function acceptanceCriteria(goal: GoalRecord, workBudget: JsonMap, resolver: EvidenceResolver): VerifiedWorkAcceptanceCriterion[] {
  const audited = new Map((goal.completion_audit?.criteria_results ?? []).map(result => [result.criterion, result]));
  return goal.acceptance_criteria.map(requirement => {
    const result = audited.get(requirement);
    const observation = criterionObservation(workBudget, requirement);
    const refs = (result?.evidence_refs ?? []).map(ref => resolver.resolve(ref));
    const status = result?.status === "pass" ? "pass" : result?.status === "fail" ? "fail" : "uncertain";
    return {
      requirement,
      status,
      authority: result ? criterionAuthority(goal, result) : "missing_authority",
      trust: strongestTrust(refs.map(ref => ref.trust)),
      observed_value: observation.observed_value ?? null,
      expected_value: observation.expected_value ?? requirement,
      evidence_references: refs,
      reason: text(observation.reason) || result?.notes || (status === "pass"
        ? "The existing trusted completion audit accepted evidence for this criterion."
        : status === "fail" ? "The existing completion audit records this criterion as failed."
          : "No passing trusted completion evidence is recorded for this criterion.")
    };
  });
}

function collateralChecks(workBudget: JsonMap, resolver: EvidenceResolver): VerifiedWorkCollateralCheck[] {
  const rows = Array.isArray(workBudget.collateral_checks) ? workBudget.collateral_checks : [];
  return rows.slice(0, 100).map((value, index) => {
    const row = object(value);
    const refs = strings(row.evidence_refs, 40).map(ref => resolver.resolve(ref));
    const trust = strongestTrust(refs.map(ref => ref.trust));
    const requested = text(row.status).toLowerCase();
    const status = requested === "fail" ? "fail"
      : requested === "not_applicable" ? "not_applicable"
        : requested === "pass" && (trust === "independently_verified" || trust === "native_execution_evidence") ? "pass"
          : "uncertain";
    return {
      invariant: text(row.invariant ?? row.requirement) || `Collateral check ${index + 1}`,
      status,
      authority: text(row.authority) || (trust === "uncertain_or_missing" ? "missing_authority" : "referenced_evidence"),
      trust,
      observed_value: row.observed_value ?? null,
      expected_value: row.expected_value ?? null,
      evidence_references: refs,
      reason: text(row.reason) || (requested === "pass" && status !== "pass"
        ? "A claimed collateral pass lacked native or independently verified evidence."
        : "Structured collateral result projected from Assignment state.")
    };
  });
}

function targetMetadata(workBudget: JsonMap): Map<string, JsonMap> {
  const rows = Array.isArray(workBudget.grounded_targets) ? workBudget.grounded_targets : [];
  return new Map(rows.map(row => object(row)).flatMap(row => {
    const identity = text(row.identity ?? row.element_id ?? row.view_id ?? row.sheet_id);
    return identity ? [[identity, row] as const] : [];
  }));
}

function targets(attempts: AssignmentAttemptRecord[], workBudget: JsonMap, resolver: EvidenceResolver): VerifiedWorkTarget[] {
  const metadata = targetMetadata(workBudget);
  const identities = [...new Set([
    ...attempts.flatMap(attempt => [...attempt.target_identities, ...attempt.affected_target_identities]),
    ...metadata.keys()
  ])].sort();
  return identities.map(identity => {
    const row = metadata.get(identity) ?? {};
    return {
      identity,
      element_id: text(row.element_id) || (/^\d+$/.test(identity) ? identity : null),
      view_id: text(row.view_id) || null,
      sheet_id: text(row.sheet_id) || null,
      family_id: text(row.family_id) || null,
      type_id: text(row.type_id) || null,
      system_id: text(row.system_id) || null,
      room_id: text(row.room_id) || null,
      space_id: text(row.space_id) || null,
      level_id: text(row.level_id) || null,
      host_id: text(row.host_id) || null,
      side: text(row.side) || null,
      orientation: text(row.orientation) || null,
      circuit_id: text(row.circuit_id) || null,
      before_state_references: strings(row.before_state_refs, 40).map(ref => resolver.resolve(ref))
    };
  });
}

function actions(attempts: AssignmentAttemptRecord[], resolver: EvidenceResolver): VerifiedWorkAction[] {
  return attempts.map(attempt => {
    const trust = trustFromAttempt(attempt);
    return {
      attempt_id: attempt.attempt_id,
      run_id: attempt.run_id,
      generation: attempt.generation,
      purpose: attempt.purpose,
      requested_effect: attempt.requested_effect,
      action_path: attempt.action_path,
      tool_identity: attempt.tool_identity,
      action_signature: attempt.action_signature,
      target_fingerprint: attempt.target_fingerprint,
      target_identities: [...attempt.target_identities],
      affected_target_identities: [...attempt.affected_target_identities],
      attempt_state: attempt.terminal_state,
      admission: { ...attempt.admission },
      dispatch: { ...attempt.dispatch },
      effect: { ...attempt.effect },
      verification: { state: attempt.verification.state, reason: attempt.verification.reason },
      receipt_references: attempt.receipt_refs.map(ref => resolver.resolve(ref, trust)),
      evidence_references: [...new Set([...attempt.evidence_refs, ...attempt.verification.evidence_refs])].map(ref => resolver.resolve(ref, trust)),
      retry_of_attempt_id: attempt.retry_of_attempt_id,
      retry_delta: attempt.retry_delta,
      reconciliation_of_attempt_id: attempt.reconciliation_of_attempt_id,
      result: `${attempt.effect.state}: ${attempt.effect.reason}`,
      trust
    };
  });
}

function artifactRole(pathValue: string): VerifiedWorkArtifact["role"] {
  const normalized = pathValue.toLowerCase();
  if (/before/.test(normalized) && /\.(?:png|jpe?g|bmp|tiff?)$/.test(normalized)) return "before_capture";
  if (/after/.test(normalized) && /\.(?:png|jpe?g|bmp|tiff?)$/.test(normalized)) return "after_capture";
  if (/highlight/.test(normalized)) return "highlighted_capture";
  if (/\.(?:pdf|dwg|ifc|csv)$/.test(normalized)) return "export";
  if (/\.(?:md|html?|json)$/.test(normalized)) return "report";
  return "other";
}

function artifacts(goal: GoalRecord, actionRows: VerifiedWorkAction[], criteria: VerifiedWorkAcceptanceCriterion[]): VerifiedWorkArtifact[] {
  const result = new Map<string, VerifiedWorkArtifact>();
  for (const entry of goal.evidence_log) {
    if (entry.evidence?.kind !== "artifact") continue;
    const artifact = entry.evidence.artifact;
    result.set(`path:${artifact.path}`, {
      role: artifactRole(artifact.path), path: artifact.path, content_hash: `sha256:${artifact.sha256}`,
      byte_count: artifact.size_bytes, media_type: null,
      evidence_reference: emptyReference(`evidence:${entry.id}`, "native_execution_evidence"), navigation_target: null
    });
  }
  for (const artifactPath of goal.artifacts) {
    if (!result.has(`path:${artifactPath}`)) result.set(`path:${artifactPath}`, {
      role: artifactRole(artifactPath), path: artifactPath, content_hash: null, byte_count: null,
      media_type: null, evidence_reference: null, navigation_target: null
    });
  }
  const refs = [...actionRows.flatMap(row => [...row.receipt_references, ...row.evidence_references]),
    ...criteria.flatMap(row => row.evidence_references)];
  for (const ref of refs) {
    if (!ref.content_hash) continue;
    result.set(`evidence:${ref.evidence_id}`, {
      role: "raw_evidence", path: ref.artifact_location, content_hash: ref.content_hash,
      byte_count: ref.byte_count, media_type: ref.media_type, evidence_reference: ref, navigation_target: null
    });
  }
  return [...result.values()].sort((left, right) => `${left.role}:${left.path ?? left.content_hash}`.localeCompare(`${right.role}:${right.path ?? right.content_hash}`));
}

function baseIssues(
  goal: GoalRecord,
  attempts: AssignmentAttemptRecord[],
  criteria: VerifiedWorkAcceptanceCriterion[],
  collateral: VerifiedWorkCollateralCheck[],
  resolver: EvidenceResolver
): VerifiedWorkIssue[] {
  const issues: VerifiedWorkIssue[] = [];
  const push = (issue: VerifiedWorkIssue) => {
    const key = `${issue.kind}:${issue.summary}`;
    if (!issues.some(candidate => `${candidate.kind}:${candidate.summary}` === key)) issues.push(issue);
  };
  if (goal.blocker) push({ kind: "safe_blocker", summary: goal.blocker, affected_attempt_ids: [], evidence_references: [], user_action_required: null });
  if (goal.error) push({ kind: "execution_failure", summary: goal.error, affected_attempt_ids: [], evidence_references: [], user_action_required: null });
  for (const remaining of goal.completion_audit?.remaining_work ?? []) {
    push({ kind: "user_action_required", summary: remaining, affected_attempt_ids: [], evidence_references: [], user_action_required: remaining });
  }
  for (const attempt of attempts) {
    if (attempt.effect.state === "unknown") push({
      kind: "verification_uncertainty", summary: `Attempt ${attempt.attempt_id} has unknown persistent effect and requires exact-target reconciliation without replay.`,
      affected_attempt_ids: [attempt.attempt_id], evidence_references: attempt.evidence_refs.map(ref => resolver.resolve(ref)), user_action_required: "Reconcile the exact target before any retry."
    });
    if (attempt.verification.state === "failed" || attempt.verification.state === "inconclusive") push({
      kind: "verification_uncertainty", summary: `Attempt ${attempt.attempt_id} verification ${attempt.verification.state}: ${attempt.verification.reason ?? "no reason recorded"}.`,
      affected_attempt_ids: [attempt.attempt_id], evidence_references: attempt.verification.evidence_refs.map(ref => resolver.resolve(ref)), user_action_required: null
    });
  }
  for (const criterion of criteria.filter(row => row.status !== "pass" && row.status !== "not_applicable")) push({
    kind: "verification_uncertainty", summary: `${criterion.requirement}: ${criterion.reason}`, affected_attempt_ids: [],
    evidence_references: criterion.evidence_references, user_action_required: criterion.status === "uncertain" ? criterion.requirement : null
  });
  for (const check of collateral.filter(row => row.status === "fail")) push({
    kind: "collateral_mutation", summary: `${check.invariant}: ${check.reason}`, affected_attempt_ids: [],
    evidence_references: check.evidence_references, user_action_required: null
  });
  for (const issue of resolver.staleIssues()) push(issue);
  return issues;
}

function requestedEffect(attempts: AssignmentAttemptRecord[], workBudget: JsonMap): AssignmentRequestedEffect | null {
  const canonicalAttempt = [...attempts].reverse().find(attempt => attempt.purpose === "action");
  if (canonicalAttempt) return canonicalAttempt.requested_effect;
  const requested = text(workBudget.requested_effect).toLowerCase();
  return requested === "read" || requested === "preview" || requested === "apply" ? requested : null;
}

function determineStatus(input: {
  goal: GoalRecord;
  requestedEffect: AssignmentRequestedEffect | null;
  attempts: AssignmentAttemptRecord[];
  terminalState: string;
  terminalReason: string | null;
  criteria: VerifiedWorkAcceptanceCriterion[];
  collateral: VerifiedWorkCollateralCheck[];
  actions: VerifiedWorkAction[];
  workBudget: JsonMap;
}): { status: VerifiedWorkPacketStatus; reason: string } {
  const rollback = input.attempts.find(attempt => attempt.purpose === "rollback" && attempt.effect.state === "none" && attempt.effect.authority === "native_rollback");
  if (rollback) return { status: "rolled_back", reason: "canonical_native_rollback_completed" };
  const clarification = ["ambiguity", "clarification", "missing_user_context"].includes(text(input.workBudget.blocker_kind).toLowerCase())
    || input.workBudget.requires_user_input === true;
  if (clarification && (input.goal.status === "blocked" || input.terminalState === "blocked")) {
    return { status: "awaiting_clarification", reason: "canonical_assignment_requires_user_clarification" };
  }
  const hasCollateralFailure = input.collateral.some(check => check.status === "fail");
  if (hasCollateralFailure) return { status: "failed", reason: "canonical_collateral_check_failed" };
  const applied = input.attempts.some(attempt => attempt.effect.state === "applied");
  const unknown = input.attempts.some(attempt => attempt.effect.state === "unknown");
  if (unknown) return { status: "complete_with_issues", reason: "unknown_effect_requires_reconciliation" };
  const verifiedNoop = !applied && input.attempts.some(attempt => attempt.effect.state === "none"
    && attempt.effect.reason === "verified_noop" && attempt.evidence_refs.length >= 2 && attempt.effect.authority === "target_readback");
  const allCriteriaPass = Boolean(input.goal.completion_audit?.complete)
    && input.criteria.length > 0 && input.criteria.every(criterion => criterion.status === "not_applicable"
      || (criterion.status === "pass" && (criterion.trust === "independently_verified" || criterion.trust === "native_execution_evidence")));
  if (verifiedNoop && allCriteriaPass) return { status: "verified_no_op", reason: "two_fresh_target_observations_and_acceptance_audit_passed" };
  const verifiedActionEvidence = input.actions.some(action => action.purpose === "verification" && action.verification.state === "passed"
    && action.evidence_references.some(ref => ref.trust === "independently_verified" || ref.trust === "native_execution_evidence"));
  const canonicalVerified = input.requestedEffect === "apply"
    ? input.terminalState === "verified" && verifiedActionEvidence
    : input.terminalState === "complete" || input.terminalState === "verified";
  if (allCriteriaPass && canonicalVerified) return { status: "verified_complete", reason: "canonical_effect_and_acceptance_verification_passed" };
  if (input.goal.status === "blocked" || input.terminalState === "blocked") return { status: "blocked_truthfully", reason: input.terminalReason ?? "canonical_assignment_blocked" };
  if (applied) return { status: "complete_with_issues", reason: "native_effect_applied_without_complete_task_level_verification" };
  if (input.terminalState === "complete" || input.terminalState === "verified") {
    return { status: "complete_with_issues", reason: "canonical_execution_settled_without_complete_acceptance_verification" };
  }
  if (input.goal.status === "complete" && allCriteriaPass && input.requestedEffect === "read") {
    return { status: "verified_complete", reason: "trusted_read_only_acceptance_audit_passed" };
  }
  if (input.goal.status === "complete") return { status: "complete_with_issues", reason: "completion_record_lacks_complete_canonical_verification" };
  return { status: "failed", reason: input.terminalReason ?? `canonical_assignment_${input.goal.status}` };
}

function rollback(attempts: AssignmentAttemptRecord[], workBudget: JsonMap, resolver: EvidenceResolver): VerifiedWorkPacketV1["rollback"] {
  const attemptsRollback = attempts.filter(attempt => attempt.purpose === "rollback");
  const completed = [...attemptsRollback].reverse().find(attempt => attempt.effect.state === "none" && attempt.effect.authority === "native_rollback");
  const latest = completed ?? attemptsRollback.at(-1);
  return {
    available: completed || attemptsRollback.length ? true : typeof workBudget.rollback_available === "boolean" ? workBudget.rollback_available : null,
    authority_or_transaction_identity: latest?.effect.authority_id ?? (text(workBudget.rollback_authority) || null),
    affected_target_identities: latest ? [...new Set([...latest.target_identities, ...latest.affected_target_identities])] : strings(workBudget.rollback_target_ids),
    completed: Boolean(completed),
    evidence_references: latest ? [...new Set([...latest.receipt_refs, ...latest.evidence_refs])].map(ref => resolver.resolve(ref, trustFromAttempt(latest))) : []
  };
}

function performance(goal: GoalRecord, workBudget: JsonMap, attempts: AssignmentAttemptRecord[], settledAt: string): VerifiedWorkPacketV1["performance"] {
  const raw = object(workBudget.performance);
  const started = Date.parse(goal.created_at);
  const ended = Date.parse(settledAt);
  const inputTokens = finite(raw.input_tokens ?? workBudget.input_tokens);
  const outputTokens = finite(raw.output_tokens ?? workBudget.output_tokens);
  const totalTokens = finite(raw.total_tokens ?? workBudget.total_tokens);
  const cost = finite(raw.estimated_cost_usd ?? workBudget.estimated_cost_usd);
  const modelCalls = finite(raw.model_calls ?? workBudget.model_calls);
  const revitCalls = finite(raw.revit_calls ?? workBudget.revit_calls)
    ?? attempts.filter(attempt => attempt.dispatch.state !== "not_dispatched").length;
  return {
    elapsed_ms: Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : finite(raw.elapsed_ms),
    model_calls: modelCalls,
    revit_calls: revitCalls,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    estimated_cost_usd: cost,
    telemetry_complete: modelCalls !== null && inputTokens !== null && outputTokens !== null && totalTokens !== null && cost !== null,
    human_intervention: typeof raw.human_intervention === "boolean" ? raw.human_intervention
      : typeof workBudget.human_intervention === "boolean" ? workBudget.human_intervention : null
  };
}

function packetBody(goal: GoalRecord, parentPacketId: string | null): Omit<VerifiedWorkPacketV1, "packet_id" | "packet_hash"> {
  const workBudget = object(goal.work_budget);
  const projection = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
  const resolver = evidenceResolver(goal);
  const criterionRows = acceptanceCriteria(goal, workBudget, resolver);
  const collateralRows = collateralChecks(workBudget, resolver);
  const actionRows = actions(projection.attempts, resolver);
  const effect = requestedEffect(projection.attempts, workBudget);
  const settledAt = projection.last_event_at && projection.terminal_state !== "open" ? projection.last_event_at : goal.updated_at;
  const derivedStatus = determineStatus({
    goal, requestedEffect: effect, attempts: projection.attempts,
    terminalState: projection.terminal_state, terminalReason: projection.terminal_reason,
    criteria: criterionRows, collateral: collateralRows, actions: actionRows, workBudget
  });
  const issueRows = baseIssues(goal, projection.attempts, criterionRows, collateralRows, resolver);
  const performanceRow = performance(goal, workBudget, projection.attempts, settledAt);
  const trustValues = [...actionRows.map(row => row.trust), ...criterionRows.map(row => row.trust)];
  const overall = derivedStatus.status === "verified_complete" || derivedStatus.status === "verified_no_op"
    ? "independently_verified" : strongestTrust(trustValues);
  return {
    schema: VERIFIED_WORK_PACKET_SCHEMA,
    packet_version: VERIFIED_WORK_PACKET_VERSION,
    parent_packet_id: parentPacketId,
    identity: {
      assignment_id: goal.id,
      run_id: projection.run_id,
      generation: projection.generation,
      project_document_fingerprint: text(workBudget.document_fingerprint ?? workBudget.project_fingerprint) || null,
      created_at: settledAt,
      source_release_identity: releaseIdentity()
    },
    assignment: {
      normalized_user_request: text(workBudget.source_user_request ?? workBudget.user_request) || goal.objective,
      requested_effect: effect,
      scope: strings(workBudget.scope),
      exclusions: strings(workBudget.exclusions).length ? strings(workBudget.exclusions) : [...goal.non_goals],
      constraints: strings(workBudget.constraints),
      authorization_envelope: screenedAuthorizationEnvelope(workBudget.authorization_envelope)
    },
    status: derivedStatus.status,
    status_reason: derivedStatus.reason,
    grounded_targets: targets(projection.attempts, workBudget, resolver),
    actions: actionRows,
    acceptance_criteria: criterionRows,
    collateral_checks: collateralRows,
    artifacts: artifacts(goal, actionRows, criterionRows),
    issues: issueRows,
    rollback: rollback(projection.attempts, workBudget, resolver),
    performance: performanceRow,
    trust_presentation: {
      overall,
      agent_reported: "Reported by an agent or caller; it does not establish native effect or verification.",
      native_execution_evidence: "Backed by an authoritative native host, transaction, receipt, or hash-verified Workspace artifact.",
      independently_verified: "Backed by target-bound readback, trusted validator authority, or canonical independent verification.",
      uncertain_or_missing: "Required authority or evidence is missing, stale, inconclusive, or has unknown effect."
    }
  };
}

export function generateVerifiedWorkPacket(goal: GoalRecord, parentPacketId: string | null = null): VerifiedWorkPacketV1 {
  if (!["blocked", "complete", "canceled", "failed"].includes(goal.status)) {
    const projection = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
    if (projection.terminal_state === "open") throw new Error("Verified Work Packet requires a settled Assignment.");
  }
  const body = packetBody(goal, parentPacketId);
  const hash = digest(body);
  return {
    ...body,
    packet_id: `vwp1_${Buffer.from(hash, "hex").toString("base64url").slice(0, 32)}`,
    packet_hash: `sha256:${hash}`
  };
}

export function verifyVerifiedWorkPacketHash(packet: VerifiedWorkPacketV1): boolean {
  const { packet_id: _packetId, packet_hash: packetHash, ...body } = packet;
  const hash = digest(body);
  return packetHash === `sha256:${hash}`
    && packet.packet_id === `vwp1_${Buffer.from(hash, "hex").toString("base64url").slice(0, 32)}`;
}
