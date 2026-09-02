import { createHash } from "node:crypto";
import { revitRouteEffect } from "../action_path_mutability.js";
import { classifyOutcomeEnvelope, outcomeEnvelopeIsUnsafe } from "../outcome_envelope.js";
import {
  appendGoalAction,
  appendGoalEvidence,
  appendGoalProgress,
  appendTrustedServerGoalValidation,
  getActiveGoalForSession,
  getCurrentGoalForSession,
  getGoal,
  markAgentGoalBlocked,
  markAgentGoalComplete,
  requestGoalCompletionAudit,
  transitionGoal,
  updateGoal
} from "./service.js";
import {
  journalAssignmentActions,
  journalAssignmentToolObservation,
  journalAssignmentToolResults
} from "../assignments/turn_journal.js";
import { recordAssignmentTurnProgress, settleAssignmentReportedBlocked, settleAssignmentTurn } from "../assignments/turn_settlement.js";

export type AutoGoalToolObservation = {
  action_id?: string | null;
  server?: string | null;
  tool: string;
  success: boolean | null;
  status?: string | null;
  error?: string | null;
  duration_ms?: number | null;
  arguments?: unknown;
  result?: unknown;
  output?: unknown;
};

export type AutoGoalTeammateReceipt = {
  stage?: string | null;
  verified?: boolean | null;
  apply_attempts?: number | null;
  blocked_reason?: string | null;
  missing_required_inputs?: string[] | null;
  apply_action_id?: string | null;
  verification_action_id?: string | null;
  verification_evidence_sha256?: string | null;
  verification_mode?: "none" | "explicit_apply_receipt" | "target_bound_readback" | "trusted_dynamic_program_receipt";
  preview_receipts?: Array<{
    action_id?: string | null;
    path?: string | null;
    status?: string | null;
    evidence_sha256?: string | null;
  }> | null;
};

type AutoGoalRequestedEffect = "read" | "preview" | "apply";
type AutoGoalObservationEffect = AutoGoalRequestedEffect | "discovery";
type AutoGoalCompletionMode =
  | "successful_read"
  | "successful_preview"
  | "successful_apply"
  | "verified_noop";
type AutoGoalTerminalReason =
  | AutoGoalCompletionMode
  | "completed_after_recovery"
  | "missing_target_or_artifact"
  | "execution_failure"
  | "verification_incomplete"
  | "effect_reconciliation_required"
  | "task_blocked";


const APPLY_BEYOND_PREVIEW_TEXT = /\b(?:(?:do not|don't|dont|never)\s+(?:(?:just|only)\s+)?(?:stop|end|finish|halt|remain|return)\b[^.!?;\n]{0,40}\b(?:preview|preflight|dry[- ]?run)|(?:do not|don't|dont|never)\s+(?:just\s+|only\s+)?(?:preview|preflight|dry[- ]?run)\b|(?:not|rather than)\s+(?:just\s+|only\s+)?(?:a\s+)?(?:preview|preflight|dry[- ]?run)\b|(?:proceed|continue|go)\s+beyond\s+(?:the\s+)?(?:preview|preflight|dry[- ]?run)\b)/i;

function assistantRequestsRequiredUserContext(assistantText: string): boolean {
  const text = assistantText.trim();
  if (!text) return false;
  const stateAdverb = "(?:(?:currently|presently|now|still)\\s+)?";
  const reportsMissingContext = new RegExp(`\\b(?:selection (?:is|was) ${stateAdverb}empty|selected elements?\\s*:\\s*0|nothing (?:is|was) ${stateAdverb}selected|no (?:model )?placement point|no (?:region|location|point|target|element|instance|device|branch|segment|view) (?:is|was) ${stateAdverb}(?:selected|specified|identified|resolved)|no (?:marked|selected|specified|identified|resolved|unique) (?:region|location|point|target|element|instance|device|branch|segment|view)|(?:target|source|location|selection|placement point|host|view) (?:is|was|remains) ${stateAdverb}(?:missing|unavailable|unresolved|unspecified|not (?:available|provided|selected|identified|specified|resolved)))\\b`, "i").test(text);
  const asksForContext = /\b(?:(?:could|can|would|will)\s+you|please)\b[^?\n]{0,320}\b(?:open|select|indicate|identify|choose|confirm|specify|provide|attach|upload|mark)\b/i.test(text);
  return reportsMissingContext && asksForContext;
}
function terminalReasonForBlockedText(value: string): AutoGoalTerminalReason {
  const text = value.normalize("NFKC").replace(/[*_`~]/g, " ");
  if (/\b(?:target|artifact|file|attachment|schedule|sheet|view|family|type|element|selection|region|location)\b[^.\n]{0,100}\b(?:missing|not found|unavailable|unresolved|not provided|not selected)\b/i.test(text)
      || /\bno (?:qualifying|matching|compatible|unambiguous) (?:target|artifact|file|schedule|sheet|view|family|type|element|selection|region|location)\b/i.test(text)) {
    return "missing_target_or_artifact";
  }
  if (/\b(?:verification|readback|reconciliation)\b[^.\n]{0,100}\b(?:incomplete|failed|missing|unavailable|not verified|required)\b/i.test(text)) {
    return "verification_incomplete";
  }
  if (/\b(?:execution|compile|compilation|transport|tool call|request)\b[^.\n]{0,100}\b(?:failed|error|closed|timed out|rejected)\b/i.test(text)) return "execution_failure";
  return "task_blocked";
}

function observationObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  const text = value.trim();
  if (!text || text.length > 1_000_000 || !text.startsWith("{")) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function canonicalRecoveryJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecoveryJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalRecoveryJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const RECOVERY_IDENTITY_CONTROL_KEYS = new Set([
  "apply", "dryRun", "dry_run", "preview", "mode", "method", "timeout", "timeoutMs",
  "transaction", "request_effect", "requestEffect", "maxElements", "maxResults", "limit", "offset",
  "page", "pageSize", "continuationToken", "discardExistingOpenDocument"
]);

function observationRecoveryKey(observation: AutoGoalToolObservation, effect: AutoGoalObservationEffect): string | null {
  if (effect === "discovery") return null;
  const tool = observation.tool.trim().toLowerCase();
  const args = observationObject(observation.arguments);
  const parsedBody = observationObject(args.body);
  const route = tool === "revit_call_tool"
    ? `${args.path || ""}`.trim().toLowerCase()
    : /^revit_[a-z0-9_]+$/.test(tool) ? `/revit/${tool.slice("revit_".length).replaceAll("_", "-")}` : "";
  if (!route) return null;
  const source = Object.keys(parsedBody).length > 0
    ? parsedBody
    : Object.fromEntries(Object.entries(args).filter(([key]) => key !== "path" && key !== "body"));
  const target = Object.fromEntries(Object.entries(source)
    .filter(([key, child]) => !RECOVERY_IDENTITY_CONTROL_KEYS.has(key) && child !== undefined));
  if (Object.keys(target).length === 0) return null;
  const digest = createHash("sha256").update(canonicalRecoveryJson(target)).digest("hex");
  return `${route}\n${effect}\nsha256:${digest}`;
}

function observationRouteEffectKey(observation: AutoGoalToolObservation, effect: AutoGoalObservationEffect): string | null {
  if (effect === "discovery") return null;
  const tool = observation.tool.trim().toLowerCase();
  const args = observationObject(observation.arguments);
  const route = tool === "revit_call_tool"
    ? `${args.path || ""}`.trim().toLowerCase()
    : /^revit_[a-z0-9_]+$/.test(tool) ? `/revit/${tool.slice("revit_".length).replaceAll("_", "-")}` : "";
  return route ? `${route}\n${effect}` : null;
}

function isPredispatchContractFailure(observation: AutoGoalToolObservation, outcome: ReturnType<typeof classifyOutcomeEnvelope>): boolean {
  if (outcome.request_dispatched_false) return true;
  const text = [observation.error, observation.result, observation.output]
    .map(value => typeof value === "string" ? value : canonicalRecoveryJson(value))
    .join("\n");
  return /(?:pre[- ]?dispatch|published tool contract|contract validation|invalid (?:tool )?(?:arguments?|request|body)|schema validation|missing required (?:field|property)|unknown (?:field|property)|must (?:be|contain|include)|is required)/i.test(text);
}



const ARTIFACT_PATH_KEYS = new Set([
  "artifactpath",
  "artifactpaths",
  "filepath",
  "imagepath",
  "outputpath",
  "outputpaths",
  "pathrel",
  "pdfpath"
]);

function looksLikeArtifactFilePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text.length > 0 && text.length <= 1_000
    && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    && /\.(?:bmp|dwf|dwfx|jpe?g|pdf|png|svg|tiff?)$/i.test(text);
}

function collectArtifactPaths(value: unknown, paths: string[], depth = 0): void {
  if (value === null || value === undefined || depth > 10 || paths.length >= 40) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length < 2 || text.length > 1_000_000 || (!text.startsWith("{") && !text.startsWith("["))) return;
    try { collectArtifactPaths(JSON.parse(text), paths, depth + 1); } catch {}
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectArtifactPaths(entry, paths, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ARTIFACT_PATH_KEYS.has(normalizedKey)) {
      const candidates = Array.isArray(child) ? child : [child];
      for (const candidate of candidates) {
        if (looksLikeArtifactFilePath(candidate) && !paths.includes(candidate.trim())) paths.push(candidate.trim());
      }
    }
    collectArtifactPaths(child, paths, depth + 1);
  }
}

function artifactPathsFromObservation(observation: AutoGoalToolObservation): string[] {
  if (observation.success !== true) return [];
  const tool = observation.tool.trim().toLowerCase();
  const args = observationObject(observation.arguments);
  const route = tool === "revit_call_tool" ? `${args.path || ""}`.trim().toLowerCase() : "";
  const artifactProducing = /(?:^|_)revit_(?:capture|export|print|render)(?:_|$)/.test(tool)
    || /^\/revit\/(?:capture|export|print|render|pdf)(?:-|\/|$)/.test(route);
  if (!artifactProducing) return [];
  const paths: string[] = [];
  collectArtifactPaths(observation.result ?? observation.output, paths);
  return paths;
}

export function findInterruptedAutoGoalForSession(sessionId?: string | null) {
  const current = getCurrentGoalForSession(sessionId);
  return current && ["paused", "blocked"].includes(current.status) ? current : null;
}

export function supersedeBlockedAutoGoalForFreshRequest(sessionId?: string | null): boolean {
  const current = getCurrentGoalForSession(sessionId);
  if (current?.status !== "blocked" || current.work_budget?.mode !== "auto_goal") return false;
  transitionGoal(current.id, "canceled", "Superseded by a fresh executable user request after the prior automatic assignment blocked.");
  return true;
}

export function createAutoGoalTurnObserver(sessionId: string) {
  let successfulReadTools = 0;
  let successfulPreviewTools = 0;
  let successfulApplyTools = 0;
  let failedRevitTools = 0;
  let knownNoEffectFailures = 0;
  let unrecoverableFailures = 0;
  let recoveredFailures = 0;
  const unresolvedFailuresByIdentity = new Map<string, number>();
  const unresolvedPredispatchFailuresByRouteEffect = new Map<string, number>();
  const rollbackPreviewTemporaryElementIds = new Set<number>();
  let rejectedNoEffectPreviews = 0;
  let canonicalObservationSequence = 0;
  return {
    observe(observation: AutoGoalToolObservation) {
      const effect = observationEffect(observation);
      const completionRelevant = effect !== "discovery";
      if (effect === "preview" && observation.success === true) {
        collectTemporaryElementIds(observation.result ?? observation.output, rollbackPreviewTemporaryElementIds);
      }
      const knownNoEffectFailure = isKnownNoEffectFailure(observation)
        || isExpectedRollbackAbsenceFailure(observation, rollbackPreviewTemporaryElementIds);
      const explicitNoEffect = isExplicitNoEffectObservation(observation);
      const blockingNoEffect = isBlockingNoEffectObservation(observation);
      const outcomeEnvelope = classifyOutcomeEnvelope(observation.result ?? observation.output);
      const unusableOutcome = outcomeEnvelopeIsUnsafe(outcomeEnvelope);
      // The observer callback itself establishes dispatch when the result omits
      // the field, but an explicit false anywhere in the transport envelope
      // overrides that implicit authority and can never increment completion.
      const dispatchedForCompletion = !outcomeEnvelope.request_dispatched_false;
      const completionEvidence = !explicitNoEffect && dispatchedForCompletion && !unusableOutcome
        && observation.success === true && isCompletionEvidence(observation);
      const recoveryKey = observationRecoveryKey(observation, effect);
      const routeEffectKey = observationRouteEffectKey(observation, effect);
      const predispatchContractFailure = observation.success === false
        && isPredispatchContractFailure(observation, outcomeEnvelope);
      const failed = completionRelevant
        && ((observation.success === false && !knownNoEffectFailure) || blockingNoEffect || (unusableOutcome && !knownNoEffectFailure));
      if (completionRelevant && effect === "preview" && explicitNoEffect) rejectedNoEffectPreviews += 1;
      if (completionEvidence) {
        if (effect === "apply") successfulApplyTools += 1;
        else if (effect === "preview") successfulPreviewTools += 1;
        else if (effect === "read") successfulReadTools += 1;
        if (recoveryKey) {
          const recovered = unresolvedFailuresByIdentity.get(recoveryKey) ?? 0;
          if (recovered > 0) {
            recoveredFailures += recovered;
            unresolvedFailuresByIdentity.delete(recoveryKey);
          }
        }
        if (routeEffectKey) {
          const recovered = unresolvedPredispatchFailuresByRouteEffect.get(routeEffectKey) ?? 0;
          if (recovered > 0) {
            recoveredFailures += recovered;
            unresolvedPredispatchFailuresByRouteEffect.delete(routeEffectKey);
          }
        }
      }
      if (failed) {
        failedRevitTools += 1;
        if (predispatchContractFailure && routeEffectKey) {
          unresolvedPredispatchFailuresByRouteEffect.set(
            routeEffectKey,
            (unresolvedPredispatchFailuresByRouteEffect.get(routeEffectKey) ?? 0) + 1
          );
        } else if (recoveryKey) unresolvedFailuresByIdentity.set(recoveryKey, (unresolvedFailuresByIdentity.get(recoveryKey) ?? 0) + 1);
        else unrecoverableFailures += 1;
      }
      if (completionRelevant && observation.success === false && knownNoEffectFailure) knownNoEffectFailures += 1;
      try {
        canonicalObservationSequence += 1;
        journalAssignmentToolObservation(
          sessionId,
          observation,
          "codex_inner_mcp",
          `${observation.action_id || `inner:${canonicalObservationSequence}`}`,
          effect === "discovery" ? undefined : effect
        );
      } catch {}
      try { recordAutoGoalToolObservation(sessionId, observation); } catch {}
    },
    finish(turnId: string, assistantText: string, teammateReceipt?: AutoGoalTeammateReceipt | null) {
      try {
        const canonical = settleAssignmentTurn(
          sessionId,
          requestedEffectForSession(sessionId),
          teammateReceipt as NonNullable<import("../contracts.js").ChatResponse["teammate_loop_receipt"]> | null | undefined
        );
        const progressed = canonical.completed
          ? canonical.projection
          : recordAssignmentTurnProgress(sessionId, turnId) ?? canonical.projection;
        if (canonical.completed) {
          completeAutoGoalFromValidatedTurn(sessionId, {
            turn_id: turnId,
            successful_tools: Math.max(1, canonical.successful_tools),
            assistant_summary: assistantText,
            verified_noop: canonical.verified_noop,
            completion_mode: canonical.verified_noop
              ? "verified_noop"
              : `successful_${requestedEffectForSession(sessionId)}` as AutoGoalCompletionMode
          });
          return;
        }
        if (progressed?.terminal_state === "blocked" || progressed?.terminal_state === "failed") {
          blockAutoGoalFromTurn(
            sessionId,
            progressed.terminal_reason || "The canonical Assignment progress watchdog terminated repeated no-progress work.",
            progressed.terminal_reason === "repeated_identical_no_progress" ? "task_blocked" : "verification_incomplete"
          );
          return;
        }
        if (canonical.projection) {
          // Canonical open/unknown state is resumable. In particular, never
          // convert an unknown effect into legacy completion or a retryable
          // Goal blocker based on counters or assistant prose.
          return;
        }
        const receiptBlocked = teammateReceipt && (
          teammateReceipt.stage === "blocked"
          || ((teammateReceipt.apply_attempts ?? 0) > 0 && teammateReceipt.verified !== true)
        );
        if (receiptBlocked) {
          blockAutoGoalFromTurn(
            sessionId,
            teammateReceipt.blocked_reason?.trim()
              || "The Revit mutation did not produce a successful target-bound post-apply verification.",
            "verification_incomplete"
          );
          return;
        }
        const requestedEffect = requestedEffectForSession(sessionId);
        const pendingApproval = /\b(awaiting approval|please (?:approve|confirm)|need(?:s)? (?:your|user) (?:approval|confirmation))\b/i.test(assistantText);
        const alreadySatisfiedNoop = requestedEffect !== "read"
          && assistantReportsAlreadySatisfiedNoop(assistantText, requestedEffect);
        const reportedBlockedOutcome = /\b(?:i (?:could not|cannot|can't|was unable to) complete|cannot claim (?:the )?(?:revit )?change is complete|requested (?:work|task) (?:is|was) (?:blocked|not verified|failed)|(?:completion|preview|execution|apply) (?:is|was )?(?:blocked|rejected)|(?:requested (?:work|task|change)|completion|preview|execution|apply) (?:is|was|remains?) blocked by|concrete blocker|not fully verified|verification (?:is|was)(?: therefore)? incomplete|not yet complete)\b/i.test(assistantText)
          || /\b(?:the\s+)?(?:assignment|task|request|requested (?:work|task)|objective)\s+(?:is|remains?)\s+(?:incomplete|unfinished|unmet|unsatisfied|not (?:complete|finished))\b/i.test(assistantText)
          || /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[*_`~]{0,3})?(?:blocked|blocker|incomplete)(?:[*_`~]{0,3})?\b/i.test(assistantText)
          || /\bno qualifying [^.\n]{0,120} (?:exists|was found|could be found)\b/i.test(assistantText)
          || /\b(?:requested |named )?(?:target|schedule|sheet|view|family|type|element) (?:was |is )?not found\b/i.test(assistantText)
          || assistantRequestsRequiredUserContext(assistantText);
        // A truthful already-satisfied result may describe the proposed preview as
        // "blocked" because there is no defensible edit. That is a verified no-op,
        // not a capability or execution blocker.
        const blockedOutcome = reportedBlockedOutcome && !alreadySatisfiedNoop;
        const teammatePreviewReceiptCount = successfulTeammatePreviewReceiptCount(teammateReceipt);
        const evidenceTools = requestedEffect === "apply"
          ? successfulApplyTools
          : requestedEffect === "preview"
            ? successfulPreviewTools
            : successfulReadTools + successfulPreviewTools + successfulApplyTools;
        const unresolvedFailureCount = unrecoverableFailures
          + [...unresolvedFailuresByIdentity.values()].reduce((sum, count) => sum + count, 0)
          + [...unresolvedPredispatchFailuresByRouteEffect.values()].reduce((sum, count) => sum + count, 0);
        const unexpectedApply = requestedEffect !== "apply" && successfulApplyTools > 0;
        const verifiedNoop = requestedEffect !== "read"
          && successfulApplyTools === 0
          && successfulPreviewTools === 0
          && successfulReadTools > 0
          && unresolvedFailureCount === 0
          && (teammateReceipt?.apply_attempts ?? 0) === 0
          && !teammateReceipt?.blocked_reason?.trim()
          && alreadySatisfiedNoop;
        if (teammatePreviewReceiptCount > 0) {
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            evt: "goal.auto_finish.evaluate",
            session_id: sessionId,
            turn_id: turnId,
            requested_effect: requestedEffect,
            successful_read_tools: successfulReadTools,
            successful_preview_tools: successfulPreviewTools,
            successful_apply_tools: successfulApplyTools,
            failed_revit_tools: failedRevitTools,
            teammate_preview_receipts: teammatePreviewReceiptCount,
            pending_approval: pendingApproval,
            blocked_outcome: blockedOutcome,
            unexpected_apply: unexpectedApply,
            unresolved_failure_count: unresolvedFailureCount,
            recovered_failure_count: recoveredFailures
          }));
        }
        if (unexpectedApply) {
          blockAutoGoalFromTurn(sessionId, `A ${requestedEffect}-only assignment dispatched an apply operation; completion requires effect reconciliation.`, "effect_reconciliation_required");
        } else if (!pendingApproval && !blockedOutcome && verifiedNoop) {
          completeAutoGoalFromValidatedTurn(sessionId, {
            turn_id: turnId,
            successful_tools: successfulReadTools + successfulPreviewTools,
            failed_tools: recoveredFailures,
            known_no_effect_failures: knownNoEffectFailures,
            assistant_summary: assistantText,
            verified_noop: true,
            completion_mode: "verified_noop",
            rejected_no_effect_count: rejectedNoEffectPreviews
          });
        } else if (!pendingApproval && !blockedOutcome && evidenceTools > 0 && unresolvedFailureCount === 0) {
          completeAutoGoalFromValidatedTurn(sessionId, {
            turn_id: turnId,
            successful_tools: evidenceTools,
            failed_tools: recoveredFailures,
            known_no_effect_failures: knownNoEffectFailures,
            assistant_summary: assistantText,
            rejected_no_effect_count: rejectedNoEffectPreviews
          });
        } else if (unresolvedFailureCount > 0 || blockedOutcome) {
          // Preserve a task-level blocker and every unresolved dispatched failure.
          // Only a later authoritative success with the same route, effect, and
          // stable request target may clear an earlier failure.
          blockAutoGoalFromTurn(sessionId, blockedOutcome
            ? assistantText || "The General Agent reported a concrete task-level blocker."
            : "One or more live Revit tool calls failed; completion requires a clean verified turn.",
          blockedOutcome ? terminalReasonForBlockedText(assistantText) : "execution_failure");
        }
      } catch (error) {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          evt: "goal.auto_finish.error",
          session_id: sessionId,
          turn_id: turnId,
          error: error instanceof Error ? error.message : String(error)
        }));
        // Assignment journaling is fail-safe and must not replace a completed user response.
      }
    }
  };
}

function successfulTeammatePreviewReceiptCount(receipt?: AutoGoalTeammateReceipt | null): number {
  if (`${receipt?.stage || ""}`.trim().toLowerCase() !== "report") return 0;
  if (!Array.isArray(receipt?.preview_receipts)) return 0;
  return receipt.preview_receipts.filter(row => {
    const actionId = `${row?.action_id || ""}`.trim();
    const path = `${row?.path || ""}`.trim().toLowerCase();
    const status = `${row?.status || ""}`.trim().toLowerCase();
    const digest = `${row?.evidence_sha256 || ""}`.trim().toLowerCase();
    return actionId.length > 0
      && actionId.length <= 300
      && /^\/revit\/[a-z0-9][a-z0-9/_-]*$/.test(path)
      && status === "success"
      && /^sha256:[a-f0-9]{64}$/.test(digest);
  }).length;
}

function isLiveRevitObservation(observation: AutoGoalToolObservation): boolean {
  const server = (observation.server ?? "").trim().toLowerCase();
  const tool = observation.tool.trim().toLowerCase();
  if (tool === "operator_retrieve_evidence" || tool === "operator_request_clarification"
      || tool === "operator_request_assignment_input"
      || tool === "operator_submit_noop_completion" || tool === "operator_submit_read_completion"
      || tool === "operator_evaluate_assignment_criteria") return false;
  return server === "revit_operator" || server.startsWith("mcp__revit_operator") || tool.startsWith("revit_");
}

function isCompletionEvidence(observation: AutoGoalToolObservation): boolean {
  if (observationEffect(observation) === "discovery") return false;
  if (isExplicitNoEffectObservation(observation)) return false;
  const result = observation.result ?? observation.output;
  if (result === null || result === undefined) return false;
  if (typeof result === "string") return result.trim().length > 0;
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === "object") return Object.keys(result as object).length > 0;
  return true;
}

function assistantReportsAlreadySatisfiedNoop(assistantText: string, requestedEffect: "read" | "preview" | "apply"): boolean {
  const receiptText = assistantText
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[*_`~]/g, "");
  const descriptiveZeroCandidatePreview = requestedEffect === "preview" && (
    /\bno\s+[^.\n]{1,120}\s+(?:contain|contains|contained|have|has|include|includes|match|matches)\s+(?:(?:the|a|an|any)\s+)?(?:requested\s+)?(?:pattern|condition|criterion|criteria|marker|delimiter|dash(?:es)?|hyphen(?:s)?|prefix|suffix|text|value|token|format)\b/i.test(receiptText)
    || /\b(?:0|zero|none)\s+(?:of\s+\d+\s+)?(?:elements?|views?|sheets?|sheet numbers?|famil(?:y|ies)|types?|parameters?|marks?|targets?|candidates?)\s+(?:contain|contains|contained|have|has|include|includes|match|matches)\s+(?:(?:the|a|an|any)\s+)?(?:requested\s+)?(?:pattern|condition|criterion|criteria|marker|delimiter|dash(?:es)?|hyphen(?:s)?|prefix|suffix|text|value|token|format)\b/i.test(receiptText)
    || /\b(?:candidate|match|preview)(?:\s+(?:table|list|set))?\s+(?:is|was)\s+empty\b/i.test(receiptText)
    || /\b(?:elements?|views?|sheets?|sheet numbers?|famil(?:y|ies)|types?|parameters?|marks?|targets?|candidates?)\s+(?:containing|with|matching)\s+[^:\n]{1,100}:\s*(?:none|zero|0)\b/i.test(receiptText)
  );
  const alreadySatisfied = /\balready (?:conforms?|compliant|matches?|satisf(?:y|ies|ied)|correct|up[ -]to[ -]date|stops?|ends?)\b/i.test(receiptText)
    || /\b(?:candidate|match(?:ing)?|proposed[ _-]?(?:change|rename))s?[ _-]?(?:count)?\s*:\s*(?:none|zero|0)\b/i.test(receiptText)
    || /\b(?:no|zero|0)\s+(?:exact\s+)?(?:rename|renumber(?:ing)?|change|edit|update|modification)\s+candidates?\b/i.test(receiptText)
    || /\b(?:0|zero|none)\s+(?:planned|proposed|previewed)?\s*(?:changes?|edits?|actions?|renames?|updates?|modifications?|writes?)\b/i.test(receiptText)
    || /\bproposed[ _-]?(?:edit|change|action)\s*:\s*none\b/i.test(receiptText)
    || /\bpreview[ _-]?status\s*:\s*(?:rejected_)?no_defensible_(?:edit|change|action)\b/i.test(receiptText)
    || /\bstatus\s*[:=]\s*["']?blocked_no_defensible_(?:edit|change|action)\b/i.test(receiptText)
    || /\bproposed[ _-]?(?:edit|change|action)\s*:\s*null\b/i.test(receiptText)
    || /["']?status["']?\s*:\s*["']?(?:no[_ -]?op|already[_ -]?satisfied)["']?/i.test(receiptText)
    || /["']?proposed(?:changes?|edits?|actions?)["']?\s*:\s*\[\s*\]/i.test(receiptText)
    || /\bno defensible (?:adjustment|change|edit|action) (?:was |is )?(?:identified|found|available|needed|necessary)\b/i.test(receiptText)
    || /\bno change\b[^\n]{0,180}\b(?:not|isn't|is not|wasn't|was not|wouldn't|would not) be defensible\b/i.test(receiptText)
    || descriptiveZeroCandidatePreview;
  const noMutationNeeded = /\bno (?:model )?(?:rename|renames|change|changes|edit|edits|update|updates|modification|modifications|action|actions|write|writes) (?:was|were|is|are)?\s*(?:required|needed|necessary|made|performed|applied)\b/i.test(receiptText)
    || /\bmodel unchanged\b/i.test(receiptText)
    || /\bnone required\b/i.test(receiptText)
    || /\b(?:renames?|changes?|edits?|updates?|modifications?|actions?|writes?)\s*:\s*(?:none|zero|0)\b/i.test(receiptText)
    || /\b(?:model[ _-]?altered|applied)\s*:\s*false\b/i.test(receiptText)
    || /["']?(?:model[ _-]?modified|model[ _-]?altered|applied)["']?\s*:\s*false/i.test(receiptText)
    || /\b(?:model[ _-]?modified|model[ _-]?altered|applied)\s*:\s*(?:no|none)\b/i.test(receiptText)
    || /\b(?:the )?(?:Revit )?model (?:was|is) not (?:modified|changed|edited|updated)\b/i.test(receiptText)
    || /\bno (?:Revit )?transaction was (?:applied|committed)\b/i.test(receiptText)
    || /\beffect\s*:\s*no[_ -]?change\b/i.test(receiptText)
    || /\bno change (?:was )?applied\b/i.test(receiptText)
    || /\bno (?:revit |model )?(?:elements?|views?|sheets?|famil(?:y|ies)|types?|parameters?) (?:was|were|is|are)?\s*(?:modified|changed|edited|updated|renamed|created|deleted|moved|written)\b/i.test(receiptText);
  return alreadySatisfied && noMutationNeeded;
}

function isExplicitNoEffectObservation(observation: AutoGoalToolObservation): boolean {
  const classification = classifyOutcomeEnvelope(observation.result ?? observation.output);
  return classification.completion_ineligible || classification.classification_incomplete;
}

function isBlockingNoEffectObservation(observation: AutoGoalToolObservation): boolean {
  return classifyOutcomeEnvelope(observation.result ?? observation.output).blocking_no_effect;
}

function objectContainsKnownPreDispatchFailure(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length < 2 || text.length > 1_000_000 || (!text.startsWith("{") && !text.startsWith("["))) return false;
    try { return objectContainsKnownPreDispatchFailure(JSON.parse(text), depth + 1); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some((entry) => objectContainsKnownPreDispatchFailure(entry, depth + 1));
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.schema === "revit-operator.mcp-pre-dispatch-failure.v1"
      && record.request_dispatched === false
      && record.outcome_unknown !== true) return true;
  return Object.values(record).some((entry) => objectContainsKnownPreDispatchFailure(entry, depth + 1));
}

function positiveElementId(value: unknown): number | null {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function collectTemporaryElementIds(value: unknown, ids: Set<number>, depth = 0): void {
  if (value === null || value === undefined || depth > 10 || ids.size >= 1_000) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length < 2 || text.length > 1_000_000 || (!text.startsWith("{") && !text.startsWith("["))) return;
    try { collectTemporaryElementIds(JSON.parse(text), ids, depth + 1); } catch {}
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTemporaryElementIds(entry, ids, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalizedKey === "temporaryelementid") {
      const id = positiveElementId(child);
      if (id !== null) ids.add(id);
    } else if (normalizedKey === "temporaryelementids" && Array.isArray(child)) {
      for (const candidate of child) {
        const id = positiveElementId(candidate);
        if (id !== null) ids.add(id);
      }
    }
    collectTemporaryElementIds(child, ids, depth + 1);
  }
}

function requestedElementIds(observation: AutoGoalToolObservation): Set<number> {
  const args = observationObject(observation.arguments);
  const parsedBody = observationObject(args.body);
  const body = Object.keys(parsedBody).length > 0 ? parsedBody : args;
  const ids = new Set<number>();
  const single = positiveElementId(body.elementId ?? body.element_id);
  if (single !== null) ids.add(single);
  const multiple = body.elementIds ?? body.element_ids;
  if (Array.isArray(multiple)) {
    for (const candidate of multiple) {
      const id = positiveElementId(candidate);
      if (id !== null) ids.add(id);
    }
  }
  return ids;
}

function isExpectedRollbackAbsenceFailure(observation: AutoGoalToolObservation, temporaryIds: ReadonlySet<number>): boolean {
  if (observation.success !== false || observationEffect(observation) !== "read" || temporaryIds.size === 0) return false;
  const requestedIds = requestedElementIds(observation);
  if (requestedIds.size === 0 || [...requestedIds].some((id) => !temporaryIds.has(id))) return false;
  let serialized = `${observation.error || ""}`;
  try { serialized += ` ${JSON.stringify(observation.result ?? observation.output ?? "")}`; } catch {}
  const missingIds = [...serialized.matchAll(/\bElement\s+(\d+)\s+not found\b/gi)]
    .map((match) => positiveElementId(match[1]))
    .filter((id): id is number => id !== null);
  return missingIds.length > 0 && missingIds.every((id) => requestedIds.has(id) && temporaryIds.has(id));
}

function observationEffect(observation: AutoGoalToolObservation): AutoGoalObservationEffect {
  if (!isLiveRevitObservation(observation)) return "discovery";
  const tool = observation.tool.trim().toLowerCase();
  const discoveryTools = new Set([
    "operator_runtime_probe",
    "operator_discover_capabilities",
    "operator_record_execution_strategy",
    "revit_ping",
    "revit_get_context",
    "revit_search_tools",
    "revit_tool_registry",
    "revit_tool_doc",
    "revit_tool_examples",
    "revit_regenerate",
    "revit_write_grant_status"
  ]);
  if (discoveryTools.has(tool) || /(?:^|_)(?:discovery|strategy|documentation|examples)$/.test(tool)) return "discovery";
  const args = observationObject(observation.arguments);
  const parsedBody = observationObject(args.body);
  const body = Object.keys(parsedBody).length > 0 ? parsedBody : args;
  const transaction = observationObject(body.transaction);
  const transactionMode = `${transaction.mode || body.mode || args.mode || ""}`.trim().toLowerCase();
  if (tool === "revit_call_tool") {
    const route = `${args.path || ""}`.trim().toLowerCase();
    if (/\/(?:ping|context|tool-search|tool-registry|tool-doc|tool-examples|discover|strategy|capabilities|write-grant)(?:\/|$)/.test(route)) return "discovery";
    if (route === "/revit/regenerate") return "discovery";
    if (route === "/revit/transaction-plan") return "discovery";
    // Historical V1 observations may lack a route identity. Preserve their
    // legacy read-only interpretation at this compatibility edge; canonical V2
    // native operations always carry an exact path and never use this fallback.
    if (!route) return "read";
    const method = `${args.method || "POST"}`.trim().toUpperCase() || "POST";
    return revitRouteEffect(route, method, body);
  }
  if (body.apply === true || body.dryRun === false || body.dry_run === false
      || ["apply", "commit", "committed"].includes(transactionMode)) return "apply";
  if (body.dryRun === true || body.dry_run === true || body.preview === true || body.apply === false
      || ["rollback", "preview", "dry_run", "dry-run"].includes(transactionMode)) return "preview";
  if (tool === "run_dynamic_revit_program") {
    if (["preview", "rollback", "dry_run", "dry-run"].includes(transactionMode)) return "preview";
    if (["apply", "commit", "committed"].includes(transactionMode)) return "apply";
  }
  if (/revit_(?:create|duplicate|set|update|delete|move|rotate|rename|apply|connect|route|export|print|open|reload|configure|replace|place|assign|link)/.test(tool)) return "apply";
  return "read";
}

function activeAutoGoal(sessionId: string) {
  const goal = getActiveGoalForSession(sessionId);
  return goal?.work_budget?.mode === "auto_goal" ? goal : null;
}

function requestedEffectForSession(sessionId: string): AutoGoalRequestedEffect {
  const goal = getActiveGoalForSession(sessionId);
  const declared = `${goal?.work_budget?.requested_effect || ""}`.trim().toLowerCase();
  if (declared === "read" || declared === "preview" || declared === "apply") return declared;
  const objective = `${goal?.objective || ""}`;
  if (/\b(preview|preflight|dry[- ]?run|rollback|do not commit|don't commit)\b/i.test(objective)
      && !APPLY_BEYOND_PREVIEW_TEXT.test(objective)) return "preview";
  if (/\b(create|duplicate|add|place|move|rotate|change|update|edit|delete|remove|rename|set|apply|connect|route|reload|export|print)\b/i.test(objective)
      && !/\b(read[- ]only|do not (?:change|modify|edit|create|apply|commit|export|print|delete|remove)|don't (?:change|modify|edit|create|apply|commit|export|print|delete|remove))\b/i.test(objective)) return "apply";
  return "read";
}

export function recordAutoGoalToolObservation(sessionId: string, observation: AutoGoalToolObservation): void {
  const goal = activeAutoGoal(sessionId);
  if (!goal) return;
  const outcome = observation.success === false ? "failed" : observation.success === true ? "completed" : "finished";
  const artifactPaths = artifactPathsFromObservation(observation);
  appendGoalProgress(sessionId, {
    summary: `Live tool ${observation.tool} ${outcome}${observation.error ? `: ${observation.error}` : "."}`,
    artifact_paths: artifactPaths,
    tool: { ...observation, request_effect: observationEffect(observation) },
    work_item: {
      id: "auto.revit-work",
      title: "Complete and verify the requested Revit work",
      status: observation.success === false ? "blocked" : "in_progress",
      blocker: observation.success === false ? observation.error || `${observation.tool} failed.` : null,
      result_summary: `${observation.tool} ${outcome}.`
    }
  });
}

export function completeAutoGoalFromValidatedTurn(
  sessionId: string,
  input: {
    turn_id: string;
    successful_tools: number;
    failed_tools?: number;
    known_no_effect_failures?: number;
    rejected_no_effect_count?: number;
    assistant_summary: string;
    verified_noop?: boolean;
    completion_mode?: AutoGoalCompletionMode;
  }
): void {
  let goal = activeAutoGoal(sessionId);
  if (!goal || input.successful_tools < 1) return;
  const recoveredFailures = Math.max(0, input.failed_tools ?? 0);
  const knownNoEffectFailures = Math.max(0, input.known_no_effect_failures ?? 0);
  const rejectedNoEffectCount = Math.max(0, input.rejected_no_effect_count ?? 0);
  const requestedEffect = requestedEffectForSession(sessionId);
  const completionMode = input.completion_mode
    ?? (input.verified_noop ? "verified_noop" : `successful_${requestedEffect}` as AutoGoalCompletionMode);
  const terminalReason: AutoGoalTerminalReason = recoveredFailures > 0
    ? "completed_after_recovery"
    : completionMode;
  goal = updateGoal(goal.id, {
    work_budget: {
      ...(goal.work_budget ?? {}),
      completion_mode: completionMode,
      terminal_reason: terminalReason,
      latest_authoritative_outcome: "succeeded",
      recovered_failure_count: recoveredFailures,
      known_no_effect_rejection_count: knownNoEffectFailures,
      rejected_no_effect_count: rejectedNoEffectCount
    }
  });
  goal = appendGoalProgress(sessionId, {
    summary: input.verified_noop
      ? `Verified that the requested Revit state was already satisfied using ${input.successful_tools} substantive live evidence call${input.successful_tools === 1 ? "" : "s"}; no write was necessary.`
      : `Completed the requested Revit work using ${input.successful_tools} successful live tool call${input.successful_tools === 1 ? "" : "s"}.`,
    work_item: {
      id: "auto.revit-work",
      title: "Complete and verify the requested Revit work",
      status: "complete",
      result_summary: input.assistant_summary
    }
  });
  const evidenceRefs: string[] = [];
  const executionMethod = input.verified_noop
    ? `Backend-observed General Agent turn established a verified no-op with ${input.successful_tools} substantive successful live Revit evidence call${input.successful_tools === 1 ? "" : "s"}${recoveredFailures > 0 ? ` after ${recoveredFailures} earlier failed call${recoveredFailures === 1 ? "" : "s"}; the final completion-relevant call succeeded` : knownNoEffectFailures > 0 ? `; no failed calls reached Revit, and ${knownNoEffectFailures} known no-effect schema or registry rejection${knownNoEffectFailures === 1 ? " was" : "s were"} recorded before dispatch` : " and no failed calls"}, zero apply attempts, and an explicit already-satisfied result.`
    : recoveredFailures > 0
    ? `Backend-observed General Agent turn completed with ${input.successful_tools} successful live Revit tool calls after ${recoveredFailures} earlier failed call${recoveredFailures === 1 ? "" : "s"}; the final completion-relevant call succeeded.`
    : knownNoEffectFailures > 0
    ? `Backend-observed General Agent turn completed with ${input.successful_tools} successful live Revit tool calls; no failed calls reached Revit, and ${knownNoEffectFailures} known no-effect schema or registry rejection${knownNoEffectFailures === 1 ? " was" : "s were"} recorded before dispatch.`
    : `Backend-observed General Agent turn completed with ${input.successful_tools} successful live Revit tool calls and no failed calls.`;
  for (const criterion of goal.acceptance_criteria) {
    const validated = appendTrustedServerGoalValidation(goal.id, {
      criterion,
      validator_id: `codex-turn:${input.turn_id}`,
      method: executionMethod,
      status: "pass"
    });
    const entry = validated.validation_log.at(-1);
    if (entry) evidenceRefs.push(`validation:${entry.id}`);
  }
  markAgentGoalComplete(sessionId, {
    criteria_results: goal.acceptance_criteria.map((criterion, index) => ({
      criterion,
      status: "pass",
      evidence_refs: evidenceRefs[index] ? [evidenceRefs[index]] : []
    })),
    evidence_summary: input.verified_noop
      ? `Verified no-op: ${input.successful_tools} substantive successful live Revit evidence call${input.successful_tools === 1 ? " was" : "s were"} observed${recoveredFailures > 0 ? ` after ${recoveredFailures} recovered failure${recoveredFailures === 1 ? "" : "s"}` : knownNoEffectFailures > 0 ? ` after ${knownNoEffectFailures} pre-dispatch schema or registry rejection${knownNoEffectFailures === 1 ? "" : "s"}` : ""}, the requested model state was already satisfied, and no apply was attempted.`
      : `${input.successful_tools} successful live Revit tool calls were observed${recoveredFailures > 0 ? ` after ${recoveredFailures} recovered failure${recoveredFailures === 1 ? "" : "s"}` : knownNoEffectFailures > 0 ? ` after ${knownNoEffectFailures} pre-dispatch schema or registry rejection${knownNoEffectFailures === 1 ? "" : "s"}` : ""} and the General Agent returned a result.`
  });
}

export type SidecarComputerGoalSettlement = {
  outcome: "complete" | "blocked";
  turn_id: string;
  assistant_summary?: string;
  reason?: string;
  successful_tools?: number;
  failed_tools?: number;
  verification_kind?: string;
  evidence?: unknown;
  assignment_run_id?: string;
  assignment_generation?: number;
};

function sha256Json(value: unknown): { sha256: string; bytes: number } | null {
  let serialized = "";
  try { serialized = JSON.stringify(value); } catch { return null; }
  if (!serialized) return null;
  return {
    sha256: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
    bytes: Buffer.byteLength(serialized, "utf8")
  };
}

function sidecarReportedActionReceipts(evidence: unknown): Array<Record<string, unknown>> {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
  const rows = Array.isArray((evidence as any).function_tools) ? (evidence as any).function_tools.slice(0, 100) : [];
  return rows.flatMap((row: any) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const tool_name = `${row.tool_name || ""}`.trim().slice(0, 160);
    const path = `${row.path || ""}`.trim().slice(0, 500);
    const result = observationObject(row.result);
    const outcomeEnvelope = classifyOutcomeEnvelope({
      request_dispatched: row.request_dispatched,
      result: row.result
    });
    const unsafeReportedOutcome = outcomeEnvelopeIsUnsafe(outcomeEnvelope) || outcomeEnvelope.request_dispatched_false;
    const status = row.status === "success" && !unsafeReportedOutcome
      ? "success"
      : row.status === "failed" || unsafeReportedOutcome ? "failed" : "";
    const request_effect = ["read", "preview", "apply"].includes(row.request_effect) ? row.request_effect : "";
    if (!tool_name || !status) return [];
    const nestedEvidence = observationObject(result.evidence);
    const declaredDigest = `${row.evidence_sha256 || row.result_sha256 || result.evidence_sha256 || result.result_sha256 || nestedEvidence.result_json_sha256 || ""}`.trim().toLowerCase();
    const inlineEvidence = nestedEvidence.result_json;
    const computed = inlineEvidence !== undefined
      ? sha256Json(inlineEvidence)
      : row.result !== undefined ? sha256Json(row.result) : null;
    const reportedEvidenceBytes = typeof nestedEvidence.result_json_bytes === "number"
      && Number.isSafeInteger(nestedEvidence.result_json_bytes) && nestedEvidence.result_json_bytes >= 0
      ? nestedEvidence.result_json_bytes : null;
    const resultEvidenceSha256 = /^sha256:[a-f0-9]{64}$/.test(declaredDigest)
      ? declaredDigest
      : /^[a-f0-9]{64}$/.test(declaredDigest) ? `sha256:${declaredDigest}` : computed?.sha256 ?? null;
    const receipt = {
      schema: "revit-operator.sidecar-function-tool-receipt-projection/v1",
      tool_name,
      path,
      method: `${row.method || result.method || (path ? "POST" : "")}`.trim().toUpperCase().slice(0, 12) || "POST",
      status,
      request_effect,
      request_dispatched: outcomeEnvelope.request_dispatched_false
        ? false
        : outcomeEnvelope.request_dispatched_true ? true : null,
      outcome_unknown: outcomeEnvelope.outcome_unknown,
      reconciliation_required: outcomeEnvelope.reconciliation_required,
      result_ok: outcomeEnvelope.ok_false ? false : typeof result.ok === "boolean" ? result.ok : null,
      call_id: `${row.call_id || ""}`.trim().slice(0, 240),
      step: Number.isSafeInteger(row.step) && row.step >= 0 ? row.step : null,
      result_evidence_sha256: resultEvidenceSha256,
      result_evidence_bytes: reportedEvidenceBytes ?? computed?.bytes ?? null,
      result_evidence_hash_source: /^(?:sha256:)?[a-f0-9]{64}$/.test(declaredDigest) ? "reported_digest" : computed ? "backend_digest_of_reported_result" : null,
      settlement_role: tool_name === "delegate_revit_task" || path === "/chat"
        ? "controller"
        : path.startsWith("/revit/") ? "revit_action" : "supporting_evidence"
    };
    return [{ ...receipt, receipt_sha256: sha256Json(receipt)?.sha256 ?? null }];
  });
}

function activeSidecarComputerGoal(sessionId: string) {
  const goal = getCurrentGoalForSession(sessionId);
  return goal?.work_budget?.mode === "sidecar_computer"
    && goal.work_budget?.source === "operator_desktop"
    ? goal
    : null;
}

/**
 * Settles work executed by the authenticated Operator Desktop outer-agent
 * lane. A caller-owned Sidecar report is persisted as completion evidence but
 * can never mint backend validator receipts or impersonate independently
 * verified completion. The projection therefore becomes complete-with-issues
 * until a trusted verifier validates the model-state claims.
 */
export function settleSidecarComputerGoal(sessionId: string, input: SidecarComputerGoalSettlement) {
  let goal = activeSidecarComputerGoal(sessionId);
  if (!goal) throw new Error("No active Operator Desktop assignment for session.");
  const turnId = `${input?.turn_id || ""}`.trim().slice(0, 240);
  if (!turnId) throw new Error("turn_id is required.");
  const successfulTools = Math.max(0, Math.floor(Number(input?.successful_tools) || 0));
  const failedTools = Math.max(0, Math.floor(Number(input?.failed_tools) || 0));
  const verificationKind = `${input?.verification_kind || "sidecar_turn_receipts"}`.trim().slice(0, 240) || "sidecar_turn_receipts";
  const requestedEffect = requestedEffectForSession(sessionId);
  let canonical = settleAssignmentTurn(sessionId, requestedEffect);
  const reportBoundToActiveRun = canonical.projection === null || (
    input.assignment_run_id === canonical.projection.run_id
    && input.assignment_generation === canonical.projection.generation
  );
  for (const receipt of sidecarReportedActionReceipts(input.evidence)) {
    if (reportBoundToActiveRun && canonical.projection && receipt.settlement_role === "revit_action") {
      const actionId = `${receipt.call_id || receipt.receipt_sha256 || ""}`.trim().slice(0, 240);
      const actionPath = `${receipt.path || ""}`.trim();
      const actionMethod = receipt.method === "GET" ? "GET" : "POST";
      if (actionId && actionPath) {
        journalAssignmentActions(sessionId, [{
          action_id: actionId,
          method: actionMethod,
          path: actionPath,
          body: { reported_receipt_sha256: receipt.receipt_sha256 },
          request_effect: receipt.request_effect as "read" | "preview" | "apply"
        }], "operator_desktop_reported");
        journalAssignmentToolResults(sessionId, [{
          action_id: actionId,
          method: actionMethod,
          path: actionPath,
          status: receipt.status === "success" ? "done" : "failed",
          request_effect: receipt.request_effect as "read" | "preview" | "apply",
          request_dispatched: receipt.request_dispatched === true,
          outcome_unknown: receipt.outcome_unknown === true,
          reconciliation_required: receipt.reconciliation_required === true,
          error: receipt.status === "failed" ? "Operator Desktop reported tool failure." : undefined
        }], "operator_desktop_reported", { trustNativeSettlement: false });
      }
    }
    const label = receipt.path ? `${receipt.tool_name} ${receipt.path}` : receipt.tool_name;
    goal = appendGoalAction(goal.id, {
      summary: `Operator Desktop reported ${label} ${receipt.status}.`,
      details: {
        source: reportBoundToActiveRun ? "operator_desktop_reported" : "operator_desktop_quarantined_report",
        quarantine_reason: reportBoundToActiveRun ? null : "stale_or_unbound_outer_report",
        ...receipt
      }
    });
  }
  if (reportBoundToActiveRun && canonical.projection?.terminal_state === "open") {
    canonical = settleAssignmentTurn(sessionId, requestedEffect);
  }

  // Legacy durable records without a canonical run retain the prior projection
  // below. Once a run exists, the reducer exclusively owns terminal truth.
  if (canonical.projection) {
    const assistantSummary = `${input.assistant_summary || input.reason || "Operator Desktop reported its turn result."}`.trim().slice(0, 3000);
    if (canonical.projection.pending_clarification_id) {
      // The durable clarification event is the authoritative turn outcome.
      // Keep the Goal paused and resumable; caller prose cannot convert it to
      // completion, no-op, or a terminal blocker.
      const awaiting = getGoal(goal.id);
      if (!awaiting) throw new Error("Awaiting-input Assignment could not be reloaded.");
      return awaiting;
    }
    if (canonical.completed && reportBoundToActiveRun && input.outcome === "complete") {
      // The accepted canonical terminal event has already synchronized and
      // packetized the Goal. Do not reopen that immutable record merely to add
      // legacy Sidecar progress, validation, or prose-derived completion data.
      const terminalGoal = getGoal(goal.id);
      if (!terminalGoal) throw new Error("Canonical terminal Assignment could not be reloaded.");
      return terminalGoal;
    }
    goal = appendGoalEvidence(goal.id, {
      summary: `Operator Desktop reported '${input.outcome}' using '${verificationKind}'.`,
      details: {
        source: reportBoundToActiveRun ? "operator_desktop" : "operator_desktop_quarantined_report",
        quarantine_reason: reportBoundToActiveRun ? null : "stale_or_unbound_outer_report",
        turn_id: turnId,
        assignment_run_id: input.assignment_run_id ?? null,
        assignment_generation: input.assignment_generation ?? null,
        verification_kind: verificationKind,
        successful_tools: successfulTools,
        failed_tools: failedTools,
        evidence: input.evidence ?? null
      }
    });

    let projection = canonical.projection;
    const canonicalEffectState = () => projection.unresolved_unknown_attempt_ids.length > 0
      ? "unknown"
      : projection.attempts.some(attempt => attempt.effect.state === "applied") ? "applied" : "none";
    if (input.outcome === "blocked") {
      const reported = settleAssignmentReportedBlocked(
        sessionId,
        input.assignment_run_id,
        input.assignment_generation,
        assistantSummary || "Operator Desktop work stopped before completion."
      );
      projection = reported.projection ?? projection;
      if (reported.accepted || projection.terminal_state === "blocked") {
        goal = appendGoalProgress(sessionId, {
          summary: reported.reason,
          work_item: {
            id: "sidecar.requested-work", title: "Complete and verify the requested work",
            status: "blocked", blocker: reported.reason, result_summary: assistantSummary
          }
        });
        return markAgentGoalBlocked(sessionId, reported.reason, {
          source: "canonical_assignment_control_plane", turn_id: turnId,
          assignment_run_id: projection.run_id, assignment_generation: projection.generation,
          effect_state: canonicalEffectState()
        });
      }
    } else if (input.outcome !== "complete") {
      throw new Error("outcome must be complete or blocked.");
    }

    const unresolvedReason = !reportBoundToActiveRun
      ? "stale_or_unbound_outer_report"
      : projection.unresolved_unknown_attempt_ids.length > 0
        ? "effect_reconciliation_required"
        : projection.attempts.some(attempt => attempt.effect.state === "applied")
          ? "post_apply_verification_required"
          : canonical.reason;
    const phase = projection.unresolved_unknown_attempt_ids.length > 0
      ? "reconciling" : projection.attempts.some(attempt => attempt.effect.state === "applied")
        ? "verifying" : projection.phase;
    goal = appendGoalProgress(sessionId, {
      summary: `${assistantSummary} Canonical settlement remains open: ${unresolvedReason}.`,
      work_item: {
        id: "sidecar.requested-work", title: "Complete and verify the requested work",
        status: "in_progress", blocker: null, result_summary: unresolvedReason
      }
    });
    goal = updateGoal(goal.id, {
      current_phase: phase,
      current_step: unresolvedReason,
      progress_summary: assistantSummary,
      work_budget: {
        ...(goal.work_budget ?? {}), reported_outcome: input.outcome,
        reported_at: new Date().toISOString(), sidecar_turn_id: turnId,
        verification_kind: verificationKind, terminal_reason: unresolvedReason,
        latest_authoritative_outcome: unresolvedReason, reported_failed_tool_count: failedTools
      }
    });
    return requestGoalCompletionAudit(goal.id, {
      criteria_results: goal.acceptance_criteria.map(criterion => ({ criterion, status: "unknown", evidence_refs: [] })),
      evidence_summary: `The Sidecar report is retained as untrusted evidence; canonical Assignment state remains ${canonicalEffectState()}/${phase}.`,
      recommendation: unresolvedReason
    });
  }

  if (input?.outcome === "blocked") {
    const reason = `${input.reason || input.assistant_summary || "Operator Desktop work stopped before verified completion."}`.trim().slice(0, 2000);
    const terminalReason = terminalReasonForBlockedText(reason);
    goal = updateGoal(goal.id, {
      current_phase: "blocked",
      work_budget: {
        ...(goal.work_budget ?? {}),
        terminal_reason: terminalReason,
        latest_authoritative_outcome: "blocked",
        recovered_failure_count: 0
      }
    });
    appendGoalProgress(sessionId, {
      summary: reason,
      work_item: {
        id: "sidecar.requested-work",
        title: "Complete and verify the requested work",
        status: "blocked",
        blocker: reason,
        result_summary: reason
      }
    });
    return markAgentGoalBlocked(sessionId, reason, {
      source: "operator_desktop",
      turn_id: turnId,
      verification_kind: verificationKind,
      successful_tools: successfulTools,
      failed_tools: failedTools,
      evidence: input.evidence ?? null
    });
  }

  if (input?.outcome !== "complete") throw new Error("outcome must be complete or blocked.");
  const assistantSummary = `${input.assistant_summary || "Operator Desktop reported successful completion."}`.trim().slice(0, 3000);
  goal = appendGoalProgress(sessionId, {
    summary: assistantSummary,
    work_item: {
      id: "sidecar.requested-work",
      title: "Complete and verify the requested work",
      status: "complete",
      result_summary: assistantSummary
    }
  });
  goal = appendGoalEvidence(goal.id, {
    summary: `Operator Desktop reported completion using '${verificationKind}'.`,
    details: {
      source: "operator_desktop",
      turn_id: turnId,
      verification_kind: verificationKind,
      successful_tools: successfulTools,
      failed_tools: failedTools,
      evidence: input.evidence ?? null
    }
  });
  goal = updateGoal(goal.id, {
    current_phase: "complete_with_issues",
    current_step: "Awaiting independent verification of Sidecar-reported evidence",
    progress_summary: assistantSummary,
    work_budget: {
      ...(goal.work_budget ?? {}),
      reported_outcome: "complete",
      reported_at: new Date().toISOString(),
      sidecar_turn_id: turnId,
      verification_kind: verificationKind,
      completion_mode: "reported_complete",
      terminal_reason: "verification_incomplete",
      latest_authoritative_outcome: "verification_incomplete",
      reported_failed_tool_count: failedTools,
      recovered_failure_count: 0,
      rejected_no_effect_count: 0
    }
  });
  return requestGoalCompletionAudit(goal.id, {
    criteria_results: goal.acceptance_criteria.map((criterion) => ({
      criterion,
      status: "unknown",
      evidence_refs: []
    })),
    evidence_summary: `${assistantSummary} Operator Desktop supplied execution receipts, but no independent backend validator has yet verified the model-state claims.`,
    recommendation: "The Sidecar-reported work is finished; retain complete-with-issues truth until an independent validator verifies the attached evidence."
  });
}

function isKnownNoEffectFailure(observation: AutoGoalToolObservation): boolean {
  if (observation.success !== false) return false;
  if (objectContainsKnownPreDispatchFailure(observation.result ?? observation.output)) return true;
  const result = observationObject(observation.result ?? observation.output);
  if (result.request_dispatched === false && result.outcome_unknown !== true) return true;
  let serialized = `${observation.error || ""}`;
  try { serialized += ` ${JSON.stringify(observation.result ?? observation.output ?? "")}`; } catch {}
  if (/\bMCP error\s+-32602\b/i.test(serialized)
      && /\b(?:input validation error|invalid arguments for tool)\b/i.test(serialized)) return true;
  return /revit_external_event_busy/i.test(serialized)
    && /outcome_unknown[\s"':=]+false/i.test(serialized);
}

export function blockAutoGoalFromTurn(sessionId: string, reason: string, terminalReason: AutoGoalTerminalReason = "task_blocked"): void {
  let goal = activeAutoGoal(sessionId);
  if (!goal) return;
  goal = updateGoal(goal.id, {
    current_phase: "blocked",
    work_budget: {
      ...(goal.work_budget ?? {}),
      terminal_reason: terminalReason,
      latest_authoritative_outcome: "blocked",
      recovered_failure_count: 0,
      rejected_no_effect_count: 0
    }
  });
  appendGoalProgress(sessionId, {
    summary: reason,
    work_item: {
      id: "auto.revit-work",
      title: "Complete and verify the requested Revit work",
      status: "blocked",
      blocker: reason
    }
  });
  markAgentGoalBlocked(sessionId, reason, { source: "general_agent_turn" });
}
