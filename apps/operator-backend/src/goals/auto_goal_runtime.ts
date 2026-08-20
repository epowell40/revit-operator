import { pathLooksWrite } from "../action_path_mutability.js";
import {
  appendGoalProgress,
  appendTrustedServerGoalValidation,
  getActiveGoalForSession,
  getCurrentGoalForSession,
  markAgentGoalBlocked,
  markAgentGoalComplete,
  transitionGoal,
  updateGoal
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
  preview_receipts?: Array<{
    action_id?: string | null;
    path?: string | null;
    status?: string | null;
    evidence_sha256?: string | null;
  }> | null;
};

type AutoGoalRequestedEffect = "read" | "preview" | "apply";
type AutoGoalObservationEffect = AutoGoalRequestedEffect | "discovery";

const APPLY_BEYOND_PREVIEW_TEXT = /\b(?:(?:do not|don't|dont|never)\s+(?:(?:just|only)\s+)?(?:stop|end|finish|halt|remain|return)\b[^.!?;\n]{0,40}\b(?:preview|preflight|dry[- ]?run)|(?:do not|don't|dont|never)\s+(?:just\s+|only\s+)?(?:preview|preflight|dry[- ]?run)\b|(?:not|rather than)\s+(?:just\s+|only\s+)?(?:a\s+)?(?:preview|preflight|dry[- ]?run)\b|(?:proceed|continue|go)\s+beyond\s+(?:the\s+)?(?:preview|preflight|dry[- ]?run)\b)/i;

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
  let lastCompletionRelevantSucceeded: boolean | null = null;
  return {
    observe(observation: AutoGoalToolObservation) {
      const effect = observationEffect(observation);
      const completionRelevant = effect !== "discovery";
      const knownNoEffectFailure = isKnownNoEffectFailure(observation);
      const explicitNoEffect = isExplicitNoEffectObservation(observation);
      const blockingNoEffect = isBlockingNoEffectObservation(observation);
      if (!explicitNoEffect && isCompletionEvidence(observation) && observation.success === true) {
        if (effect === "apply") successfulApplyTools += 1;
        else if (effect === "preview") successfulPreviewTools += 1;
        else if (effect === "read") successfulReadTools += 1;
      }
      if (completionRelevant && ((observation.success === false && !knownNoEffectFailure) || blockingNoEffect)) failedRevitTools += 1;
      if (completionRelevant && observation.success === false && knownNoEffectFailure) knownNoEffectFailures += 1;
      if (completionRelevant && blockingNoEffect) lastCompletionRelevantSucceeded = false;
      else if (completionRelevant && !explicitNoEffect && observation.success !== null && !knownNoEffectFailure) lastCompletionRelevantSucceeded = observation.success;
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
        const requestedEffect = requestedEffectForSession(sessionId);
        const alreadySatisfiedNoop = requestedEffect !== "read"
          && assistantReportsAlreadySatisfiedNoop(assistantText, requestedEffect);
        const reportedBlockedOutcome = /\b(?:i (?:could not|cannot|can't|was unable to) complete|cannot claim (?:the )?(?:revit )?change is complete|requested (?:work|task) (?:is|was) (?:blocked|not verified|failed)|(?:completion|preview|execution|apply) (?:is|was )?(?:blocked|rejected)|(?:requested (?:work|task|change)|completion|preview|execution|apply) (?:is|was|remains?) blocked by|concrete blocker|not fully verified|verification (?:is|was)(?: therefore)? incomplete|not yet complete)\b/i.test(assistantText)
          || /\b(?:the\s+)?(?:assignment|task|request|requested (?:work|task)|objective)\s+(?:is|remains?)\s+(?:incomplete|unfinished|unmet|unsatisfied|not (?:complete|finished))\b/i.test(assistantText)
          || /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[*_`~]{0,3})?(?:blocked|blocker|incomplete)(?:[*_`~]{0,3})?\b/i.test(assistantText)
          || /\bno qualifying [^.\n]{0,120} (?:exists|was found|could be found)\b/i.test(assistantText)
          || /\b(?:requested |named )?(?:target|schedule|sheet|view|family|type|element) (?:was |is )?not found\b/i.test(assistantText);
        // A truthful already-satisfied result may describe the proposed preview as
        // "blocked" because there is no defensible edit. That is a verified no-op,
        // not a capability or execution blocker.
        const blockedOutcome = reportedBlockedOutcome && !alreadySatisfiedNoop;
        const evidenceTools = requestedEffect === "apply"
          ? successfulApplyTools
          : requestedEffect === "preview"
            ? Math.max(successfulPreviewTools, successfulTeammatePreviewReceiptCount(teammateReceipt))
            : successfulReadTools + successfulPreviewTools + successfulApplyTools;
        const unexpectedApply = requestedEffect !== "apply" && successfulApplyTools > 0;
        const verifiedNoop = requestedEffect !== "read"
          && successfulApplyTools === 0
          && successfulPreviewTools === 0
          && successfulReadTools > 0
          && lastCompletionRelevantSucceeded === true
          && (teammateReceipt?.apply_attempts ?? 0) === 0
          && !teammateReceipt?.blocked_reason?.trim()
          && alreadySatisfiedNoop;
        if (unexpectedApply) {
          blockAutoGoalFromTurn(sessionId, `A ${requestedEffect}-only assignment dispatched an apply operation; completion requires effect reconciliation.`);
        } else if (!pendingApproval && !blockedOutcome && verifiedNoop) {
          completeAutoGoalFromValidatedTurn(sessionId, {
            turn_id: turnId,
            successful_tools: successfulReadTools + successfulPreviewTools,
            failed_tools: failedRevitTools,
            known_no_effect_failures: knownNoEffectFailures,
            assistant_summary: assistantText,
            verified_noop: true
          });
        } else if (!pendingApproval && !blockedOutcome && evidenceTools > 0 && lastCompletionRelevantSucceeded !== false) {
          completeAutoGoalFromValidatedTurn(sessionId, {
            turn_id: turnId,
            successful_tools: evidenceTools,
            failed_tools: failedRevitTools,
            known_no_effect_failures: knownNoEffectFailures,
            assistant_summary: assistantText
          });
        } else if ((failedRevitTools > 0 && (evidenceTools === 0 || lastCompletionRelevantSucceeded === false)) || blockedOutcome) {
          // Preserve the final task-level blocker when the agent recovered from an
          // exploratory read error and then grounded its conclusion in successful
          // live evidence. A prior malformed read remains in the action log, but it
          // must not replace a later, more specific model-state blocker.
          blockAutoGoalFromTurn(sessionId, blockedOutcome
            ? assistantText || "The General Agent reported a concrete task-level blocker."
            : "One or more live Revit tool calls failed; completion requires a clean verified turn.");
        }
      } catch {
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
  const alreadySatisfied = /\balready (?:conforms?|compliant|matches?|satisf(?:y|ies|ied)|correct|up[ -]to[ -]date)\b/i.test(receiptText)
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

function objectContainsExplicitNoEffect(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    const parsed = observationObject(value);
    return Object.keys(parsed).length > 0 && objectContainsExplicitNoEffect(parsed, depth + 1);
  }
  if (Array.isArray(value)) return value.some((entry) => objectContainsExplicitNoEffect(entry, depth + 1));
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.completionEligible === false || record.completion_eligible === false) return true;
  if (record.requestedEffectSatisfied === false || record.requested_effect_satisfied === false) return true;
  if (record.requiresExplicitDiscardAndReopen === true || record.requires_explicit_discard_and_reopen === true) return true;
  if (record.requiresExplicitUnloadAndOpen === true || record.requires_explicit_unload_and_open === true) return true;
  const status = `${record.status || ""}`.trim().toLowerCase();
  if (["already open inactive", "already loaded as link", "requires explicit action"].includes(status)) return true;
  return Object.values(record).some((entry) => objectContainsExplicitNoEffect(entry, depth + 1));
}

function objectContainsBlockingNoEffect(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    const parsed = observationObject(value);
    return Object.keys(parsed).length > 0 && objectContainsBlockingNoEffect(parsed, depth + 1);
  }
  if (Array.isArray(value)) return value.some((entry) => objectContainsBlockingNoEffect(entry, depth + 1));
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.requestedEffectSatisfied === false || record.requested_effect_satisfied === false) return true;
  if (record.requiresExplicitDiscardAndReopen === true || record.requires_explicit_discard_and_reopen === true) return true;
  if (record.requiresExplicitUnloadAndOpen === true || record.requires_explicit_unload_and_open === true) return true;
  const status = `${record.status || ""}`.trim().toLowerCase();
  if (["already open inactive", "already loaded as link", "requires explicit action"].includes(status)) return true;
  return Object.values(record).some((entry) => objectContainsBlockingNoEffect(entry, depth + 1));
}

function isExplicitNoEffectObservation(observation: AutoGoalToolObservation): boolean {
  return objectContainsExplicitNoEffect(observation.result ?? observation.output);
}

function isBlockingNoEffectObservation(observation: AutoGoalToolObservation): boolean {
  return objectContainsBlockingNoEffect(observation.result ?? observation.output);
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
  if (body.apply === true || body.dryRun === false || body.dry_run === false
      || ["apply", "commit", "committed"].includes(transactionMode)) return "apply";
  if (body.dryRun === true || body.dry_run === true || body.preview === true || body.apply === false
      || ["rollback", "preview", "dry_run", "dry-run"].includes(transactionMode)) return "preview";
  if (tool === "revit_call_tool") {
    const route = `${args.path || ""}`.trim().toLowerCase();
    if (/\/(?:ping|context|tool-search|tool-registry|tool-doc|tool-examples|discover|strategy|capabilities|write-grant)(?:\/|$)/.test(route)) return "discovery";
    if (route === "/revit/regenerate") return "discovery";
    if (route === "/revit/transaction-plan") return "discovery";
    const method = `${args.method || "POST"}`.trim().toUpperCase() || "POST";
    return pathLooksWrite(route, body, method) ? "apply" : "read";
  }
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
  const goal = activeAutoGoal(sessionId);
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
  input: { turn_id: string; successful_tools: number; failed_tools?: number; known_no_effect_failures?: number; assistant_summary: string; verified_noop?: boolean }
): void {
  let goal = activeAutoGoal(sessionId);
  if (!goal || input.successful_tools < 1) return;
  if (input.verified_noop) {
    goal = updateGoal(goal.id, {
      work_budget: { ...(goal.work_budget ?? {}), completion_mode: "verified_noop" }
    });
  }
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
  const recoveredFailures = Math.max(0, input.failed_tools ?? 0);
  const knownNoEffectFailures = Math.max(0, input.known_no_effect_failures ?? 0);
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
