import {
  appendGoalProgress,
  appendTrustedServerGoalValidation,
  getActiveGoalForSession,
  getCurrentGoalForSession,
  markAgentGoalBlocked,
  markAgentGoalComplete
} from "./service.js";

export type AutoGoalToolObservation = {
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
};

type AutoGoalRequestedEffect = "read" | "preview" | "apply";
type AutoGoalObservationEffect = AutoGoalRequestedEffect | "discovery";

export function findInterruptedAutoGoalForSession(sessionId?: string | null) {
  const current = getCurrentGoalForSession(sessionId);
  return current && ["paused", "blocked"].includes(current.status) ? current : null;
}

export function createAutoGoalTurnObserver(sessionId: string) {
  let successfulReadTools = 0;
  let successfulPreviewTools = 0;
  let successfulApplyTools = 0;
  let failedRevitTools = 0;
  let lastCompletionRelevantSucceeded: boolean | null = null;
  return {
    observe(observation: AutoGoalToolObservation) {
      const effect = observationEffect(observation);
      const completionRelevant = effect !== "discovery";
      if (isCompletionEvidence(observation) && observation.success === true) {
        if (effect === "apply") successfulApplyTools += 1;
        else if (effect === "preview") successfulPreviewTools += 1;
        else if (effect === "read") successfulReadTools += 1;
      }
      if (completionRelevant && observation.success === false) failedRevitTools += 1;
      if (completionRelevant && observation.success !== null) lastCompletionRelevantSucceeded = observation.success;
      try { recordAutoGoalToolObservation(sessionId, observation); } catch {}
    },
    finish(turnId: string, assistantText: string, teammateReceipt?: AutoGoalTeammateReceipt | null) {
      try {
        const receiptBlocked = teammateReceipt && (
          teammateReceipt.stage === "blocked"
          || ((teammateReceipt.apply_attempts ?? 0) > 0 && teammateReceipt.verified !== true)
        );
        if (receiptBlocked) {
          blockAutoGoalFromTurn(
            sessionId,
            teammateReceipt.blocked_reason?.trim()
              || "The Revit mutation did not produce a successful target-bound post-apply verification."
          );
          return;
        }
        const pendingApproval = /\b(awaiting approval|please (?:approve|confirm)|need(?:s)? (?:your|user) (?:approval|confirmation))\b/i.test(assistantText);
        const blockedOutcome = /\b(?:i (?:could not|cannot|can't|was unable to) complete|cannot claim (?:the )?(?:revit )?change is complete|requested (?:work|task) (?:is|was) (?:blocked|not verified|failed)|(?:completion|preview|execution|apply) (?:is|was )?(?:blocked|rejected)|blocked by|concrete blocker|not fully verified|verification (?:is|was)(?: therefore)? incomplete|not yet complete)\b/i.test(assistantText);
        const requestedEffect = requestedEffectForSession(sessionId);
        const evidenceTools = requestedEffect === "apply"
          ? successfulApplyTools
          : requestedEffect === "preview"
            ? successfulPreviewTools
            : successfulReadTools + successfulPreviewTools + successfulApplyTools;
        const unexpectedApply = requestedEffect !== "apply" && successfulApplyTools > 0;
        if (unexpectedApply) {
          blockAutoGoalFromTurn(sessionId, `A ${requestedEffect}-only assignment dispatched an apply operation; completion requires effect reconciliation.`);
        } else if (!pendingApproval && !blockedOutcome && evidenceTools > 0 && lastCompletionRelevantSucceeded !== false) {
          completeAutoGoalFromValidatedTurn(sessionId, { turn_id: turnId, successful_tools: evidenceTools, assistant_summary: assistantText });
        } else if ((failedRevitTools > 0 && (evidenceTools === 0 || lastCompletionRelevantSucceeded === false)) || blockedOutcome) {
          blockAutoGoalFromTurn(sessionId, failedRevitTools > 0
            ? "One or more live Revit tool calls failed; completion requires a clean verified turn."
            : assistantText || "The General Agent turn ended without a successful live Revit tool result.");
        }
      } catch {
        // Assignment journaling is fail-safe and must not replace a completed user response.
      }
    }
  };
}

function isLiveRevitObservation(observation: AutoGoalToolObservation): boolean {
  const server = (observation.server ?? "").trim().toLowerCase();
  const tool = observation.tool.trim().toLowerCase();
  return server === "revit_operator" || server.startsWith("mcp__revit_operator") || tool.startsWith("revit_");
}

function isCompletionEvidence(observation: AutoGoalToolObservation): boolean {
  if (observationEffect(observation) === "discovery") return false;
  const result = observation.result ?? observation.output;
  if (result === null || result === undefined) return false;
  if (typeof result === "string") return result.trim().length > 0;
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === "object") return Object.keys(result as object).length > 0;
  return true;
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
    "revit_write_grant_status"
  ]);
  if (discoveryTools.has(tool) || /(?:^|_)(?:discovery|strategy|documentation|examples)$/.test(tool)) return "discovery";
  const args = observation.arguments && typeof observation.arguments === "object" ? observation.arguments as Record<string, unknown> : {};
  const body = args.body && typeof args.body === "object" ? args.body as Record<string, unknown> : args;
  const transaction = body.transaction && typeof body.transaction === "object" ? body.transaction as Record<string, unknown> : {};
  const transactionMode = `${transaction.mode || body.mode || ""}`.trim().toLowerCase();
  if (body.apply === true || body.dryRun === false || body.dry_run === false
      || ["apply", "commit", "committed"].includes(transactionMode)) return "apply";
  if (body.dryRun === true || body.dry_run === true || body.preview === true || body.apply === false
      || ["rollback", "preview", "dry_run", "dry-run"].includes(transactionMode)) return "preview";
  if (tool === "revit_call_tool") {
    const route = `${args.path || ""}`.trim().toLowerCase();
    if (/\/(?:ping|context|tool-search|tool-registry|tool-doc|tool-examples|discover|strategy|capabilities|write-grant)(?:\/|$)/.test(route)) return "discovery";
    if (route === "/revit/transaction-plan") return "discovery";
    if (/\/(?:create|duplicate|set|update|delete|move|rotate|rename|apply|connect|route|export|print|reload|configure|replace|place|assign|link)(?:-|\/|$)/.test(route)) return "apply";
  }
  if (/revit_(?:create|duplicate|set|update|delete|move|rotate|rename|apply|connect|route|export|print|reload|configure|replace|place|assign|link)/.test(tool)) return "apply";
  return "read";
}

function activeAutoGoal(sessionId: string) {
  const goal = getActiveGoalForSession(sessionId);
  return goal?.work_budget?.mode === "auto_goal" ? goal : null;
}

function requestedEffectForSession(sessionId: string): AutoGoalRequestedEffect {
  const goal = activeAutoGoal(sessionId);
  const declared = `${goal?.work_budget?.requested_effect || ""}`.trim().toLowerCase();
  if (declared === "read" || declared === "preview" || declared === "apply") return declared;
  const objective = `${goal?.objective || ""}`;
  if (/\b(preview|preflight|dry[- ]?run|rollback|do not commit|don't commit)\b/i.test(objective)) return "preview";
  if (/\b(create|duplicate|add|place|move|rotate|change|update|edit|delete|remove|rename|set|apply|connect|route|reload|export|print)\b/i.test(objective)
      && !/\b(read[- ]only|do not (?:change|modify|edit|create|apply|commit|export|print|delete|remove)|don't (?:change|modify|edit|create|apply|commit|export|print|delete|remove))\b/i.test(objective)) return "apply";
  return "read";
}

export function recordAutoGoalToolObservation(sessionId: string, observation: AutoGoalToolObservation): void {
  const goal = activeAutoGoal(sessionId);
  if (!goal) return;
  const outcome = observation.success === false ? "failed" : observation.success === true ? "completed" : "finished";
  appendGoalProgress(sessionId, {
    summary: `Live tool ${observation.tool} ${outcome}${observation.error ? `: ${observation.error}` : "."}`,
    tool: observation,
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
  input: { turn_id: string; successful_tools: number; assistant_summary: string }
): void {
  let goal = activeAutoGoal(sessionId);
  if (!goal || input.successful_tools < 1) return;
  goal = appendGoalProgress(sessionId, {
    summary: `Completed the requested Revit work using ${input.successful_tools} successful live tool call${input.successful_tools === 1 ? "" : "s"}.`,
    work_item: {
      id: "auto.revit-work",
      title: "Complete and verify the requested Revit work",
      status: "complete",
      result_summary: input.assistant_summary
    }
  });
  const evidenceRefs: string[] = [];
  for (const criterion of goal.acceptance_criteria) {
    const validated = appendTrustedServerGoalValidation(goal.id, {
      criterion,
      validator_id: `codex-turn:${input.turn_id}`,
      method: `Backend-observed General Agent turn completed with ${input.successful_tools} successful live Revit tool calls and no failed calls.`,
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
    evidence_summary: `${input.successful_tools} successful live Revit tool calls were observed and the General Agent returned a result.`
  });
}

export function blockAutoGoalFromTurn(sessionId: string, reason: string): void {
  const goal = activeAutoGoal(sessionId);
  if (!goal) return;
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
