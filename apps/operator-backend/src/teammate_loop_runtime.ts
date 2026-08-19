import { createHash } from "node:crypto";
import { conditionalActionPathEffect, pathLooksWrite } from "./action_path_mutability.js";
import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "./contracts.js";
import { hasExplicitMutationVerb } from "./revit_mutation_intent.js";
import { activeHostVersionYear, evidenceIsKnownNoEffectFailure, openModelActiveHostMismatch } from "./revit_host_model_inventory.js";
import { buildTeammateLoopReceipt, successfulPreviewReceipt, type SuccessfulPreviewReceipt } from "./teammate_loop_receipt.js";

export type AgentTurnKind = "conversation" | "inspection" | "navigation" | "mutation";
export type TeammateContextState = "not_required" | "live" | "missing" | "invalid";
export type TeammateLoopStage = "answer" | "clarify" | "ground" | "discover" | "preview" | "apply" | "verify" | "report" | "blocked";

export type TeammateTurnContract = {
  schema: "revit-operator.teammate-loop.v1";
  turn_kind: AgentTurnKind;
  intent_summary: string;
  ambiguity: "none" | "low" | "material";
  context_state: TeammateContextState;
  stage: TeammateLoopStage;
  no_write: boolean;
  write_authorized: boolean;
  preview_required: boolean;
  max_apply_attempts: 32;
  verification_required: boolean;
  user_text_sha256: string;
  document_signature: string | null;
};

type Effect = "read" | "navigation" | "discovery" | "preview" | "apply" | "unknown";
type PendingCall = { effect: Effect; signature: string; path: string; target_tokens: string[]; expected_values: string[]; operation: string };
type DocumentedToolRoute = { method: "GET" | "POST"; path: string };

type TeammateLoopState = {
  key: string;
  contract: TeammateTurnContract;
  expires_at_ms: number;
  successful_preview_signatures: Set<string>;
  pending: Map<string, PendingCall>;
  preview_action_ids: string[];
  preview_receipts: SuccessfulPreviewReceipt[];
  apply_action_id: string | null;
  verification_action_ids: string[];
  apply_attempts: number;
  stage_apply_attempts: number;
  apply_succeeded: boolean;
  apply_signature: string;
  completed_apply_signatures: Set<string>;
  apply_target_tokens: Set<string>;
  apply_target_tokens_inferred: boolean;
  apply_expected_values: Set<string>;
  verification_observed_target_tokens: Set<string>;
  verification_observed_values: Set<string>;
  verification_has_substantive_readback: boolean;
  apply_operation: string;
  verified: boolean;
  verification_mode: "none" | "explicit_apply_receipt" | "target_bound_readback" | "trusted_dynamic_program_receipt";
  verification_action_id: string | null;
  verification_evidence_sha256: string | null;
  tool_doc_calls: number;
  documented_tool_routes: Map<string, DocumentedToolRoute>;
  blocked_reason: string | null;
  active_host_version_year: string;
};

export type TeammateLoopOwnerLease = { owner: object; state: TeammateLoopState; turn_id: string | null };
export type TeammateMcpGate = { allowed: boolean; message?: string; call?: PendingCall; state?: TeammateLoopState };

const statesByTurn = new Map<string, TeammateLoopState>();
const statesByOwner = new WeakMap<object, { unbound: Set<TeammateLoopOwnerLease>; by_turn: Map<string, TeammateLoopOwnerLease> }>();
const MAX_STATE_AGE_MS = 5 * 60_000;
// Transient UI/derived-state POSTs must not replace the last persistent mutation's verification target.
const NAVIGATION_PATHS = new Set(["/revit/activate-view", "/revit/regenerate"]);
const DISCOVERY_PATHS = new Set(["/revit/ping", "/revit/context", "/revit/write-grant-status", "/revit/tool-registry", "/revit/tool-search", "/revit/tool-doc", "/revit/tool-examples"]);
const DISCOVERY_TOOLS = new Set([
  "operator_discover_capabilities",
  "operator_record_execution_strategy",
  "revit_ping",
  "revit_get_context",
  "revit_write_grant_status",
  "revit_search_tools",
  "revit_tool_registry",
  "revit_tool_doc",
  "revit_tool_examples"
]);
const DEFAULT_PREVIEW_TOOLS = new Set(["revit_update_schedule_cell", "revit_replace_schedule_values", "revit_set_parameters"]);

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function structuredActionBody(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1_000_000 || !/^[\[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" && value.length <= max ? value.trim() : "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizedUserText(req: Pick<ChatRequest, "user_text" | "context">): string {
  const context = objectValue(req.context);
  const ui = objectValue(context.ui);
  const authoritative = boundedString(ui.authoritative_user_text, 20_000);
  return (authoritative || `${req.user_text || ""}`).replace(/\s+/g, " ").trim();
}

function isConceptualQuestion(text: string): boolean {
  const liveCue = /\b(?:current|active|selected|this (?:model|view|sheet|schedule)|in (?:the|this) (?:model|view|sheet|schedule)|room number|element id)\b/i.test(text);
  return !liveCue && /\b(?:explain|what (?:does|is|are)|how (?:does|do|is|are|can|could|should|would)|why (?:does|do|is|are)|should (?:i|we)|tell me about)\b/i.test(text);
}

function containsMutationVerb(text: string): boolean {
  return hasExplicitMutationVerb(text);
}

const COORDINATED_GLOBAL_NO_WRITE = new RegExp(
  "\\b(?:do not|don't|dont|never)\\s+"
  + "(?:(?:actually|ever|otherwise)\\s+|(?:attempt|try)\\s+to\\s+)?"
  + "(?:change|save|modify|edit|create|apply|commit|export|print|delete|remove|write|mutate)"
  + "(?:\\s*,?\\s*(?:(?:or|and)\\s+)?(?:(?:actually|ever|otherwise)\\s+)?(?:change|save|modify|edit|create|apply|commit|export|print|delete|remove|write|mutate)){1,6}"
  + "\\s+(?:the\\s+)?(?:revit\\s+)?(?:model|project|document|anything|it)\\b",
  "i"
);

const TERMINAL_DIRECT_NO_WRITE = new RegExp(
  "\\b(?:do not|don't|dont|never)\\s+"
  + "(?:(?:actually|ever|otherwise)\\s+|(?:attempt|try)\\s+to\\s+)?"
  + "(?:change|save|modify|edit|configure|reload|create|apply|commit|export|print|delete|remove|write|mutate)"
  + "(?:\\s*(?:,|or|and)\\s*(?:(?:actually|ever|otherwise)\\s+)?(?:change|save|modify|edit|configure|reload|create|apply|commit|export|print|delete|remove|write|mutate)){0,6}"
  + "\\s+(?:(?:the|any)\\s+)?(?:schedule|family|model|project|document|files?|changes?|anything|it)\\s*[.!?]*\\s*$",
  "i"
);

function hasPreviewOrGlobalNoWriteFraming(text: string): boolean {
  // A leading, sentence-level READ-ONLY declaration is an authoritative turn
  // contract even when a long planning request later names the future edits it
  // wants described. Do not require "plan" to appear within an arbitrary
  // character window before honoring that explicit boundary.
  if (/^\s*read[ -]?only(?:\s+only)?\s*[.!:;-]/i.test(text)) return true;
  if (COORDINATED_GLOBAL_NO_WRITE.test(text)) return true;
  if (TERMINAL_DIRECT_NO_WRITE.test(text)) return true;
  if (/\bread[ -]?only\b[^.!?\n]{0,60}\b(?:plan|preview|analysis|inspection|report)\b/i.test(text)
      || /\b(?:plan|preview|analysis|inspection|report)\b[^.!?\n]{0,60}\bread[ -]?only\b/i.test(text)
      || /\b(?:preview|analysis)\s+only\b/i.test(text)) return true;
  if (/\b(?:preview|preflight|dry[ -]?run)\b/i.test(text)
      && /\b(?:do not|don't|dont|never)\s+(?:(?:actually|ever)\s+)?(?:apply|commit|write|modify|change|edit|save|execute|make)\b|\bwithout\s+(?:applying|committing|writing|modifying|changing|editing|saving|executing|making)\b/i.test(text)) return true;
  if (/\b(?:preview|preflight|dry[ -]?run)\b/i.test(text)
      && /\bwithout\s+(?:creating|writing|saving|exporting|printing)\b[^.!?;\n]{0,50}\bfiles?\b|\b(?:do not|don't|dont|never)\s+(?:export|print|write|save|create)\b[^.!?;\n]{0,35}\b(?:files?|outputs?|pdfs?)\b|\b(?:do not|don't|dont|never)\s+send\b[^.!?;\n]{0,30}\bphysical\s+prints?\b/i.test(text)) return true;
  if (/\b(?:preview|preflight|dry[ -]?run)\b/i.test(text)
      && /\b(?:do not|don't|dont|never)\s+create\s+(?:(?:the|an?|any)\s+)?(?:copy|file|output|sheet|view|schedule|element|template|family|type|model\s+change)\b/i.test(text)) return true;
  if (/\bwithout\s+(?:making|applying|committing|saving)\s+(?:any\s+)?changes?\b/i.test(text)) return true;
  if (/\bbefore\b[^.!?\n]{0,100}\b(?:delet|remov|chang|modif|edit|apply|commit|writ|creat|renam|print)/i.test(text)) return true;
  return /\b(?:do not|don't|dont|never)\s+(?:(?:actually|ever)\s+|(?:attempt|try)\s+to\s+)?(?:change|modify|edit|delete|remove|apply|commit|write|create|rename|print|mutate)\b[^.!?;\n]{0,40}\b(?:the\s+)?(?:model|project|document|anything|it|the\s+change)\b/i.test(text);
}

function hasRevitWorkSubject(text: string): boolean {
  return /\b(?:revit|model|project|element|equipment|device|fixture|terminal|duct|pipe|fitting|accessor|connector|family|type|parameter|mark|comment|note|tag|dimension|annotation|room|space|level|view|template|sheet|schedule|title\s*block|viewport|plan|section|elevation|detail|crop|scale|visibility|graphics|filter|workset|phase|system|circuit|panel|print|pdf)\w*\b/.test(text);
}

function withoutAdjectivalOpenDocumentState(text: string): string {
  // "the open Revit model" and "the open Snowdon Towers Sample HVAC model"
  // describe the current model; neither is an imperative to open another
  // document. Likewise, "which model is open" and "the project is already
  // open" describe or ask about state rather than authorizing a lifecycle
  // mutation. Strip both forms before applying the deliberately broad
  // lifecycle-command grammar.
  return text
    .replace(
      /\b(?:the|this|that|an?|current(?:ly)?|already|presently)\s+open\s+(?:revit\s+)?(?:model|project|document)\b/gi,
      " "
    )
    .replace(
      /\b(?:the|this|that|an?|current(?:ly)?|already|presently)\s+open\s+(?:(?:(?!\b(?:open|reopen|close|save)\b)[^.!?;\n]){0,120}?\s+)?(?:model|project|document)\b/gi,
      " "
    )
    .replace(
      /\b(?:(?:which|what|the|this|that|current|active)\s+)?(?:(?:revit\s+)?(?:model|project|document))\s+(?:is|was|remains?|appears?|looks?)\s+(?:already\s+|currently\s+|presently\s+)?open\b/gi,
      " "
    );
}

function containsDocumentLifecycleMutation(text: string): boolean {
  const commandText = withoutAdjectivalOpenDocumentState(text);
  return /\b(?:open|reopen|close|save)\b[^.!?\n]{0,180}(?:\b(?:revit\s+)?(?:model|project|document)\b|\.rvt\b)/i.test(commandText)
    || /(?:\b(?:revit\s+)?(?:model|project|document)\b|\.rvt\b)[^.!?\n]{0,180}\b(?:open|reopen|close|save)\b/i.test(commandText)
    || /\brevit_open_model\b|\/revit\/open-model\b/i.test(commandText);
}

function deniesDocumentLifecycleMutation(text: string): boolean {
  const directDenial = /\b(?:do not|don't|dont|never)\s+(?:(?:actually|ever)\s+|(?:attempt|try)\s+to\s+)?(?:open|reopen|close|save)\b/i;
  const deferredInspection = /\bbefore\s+(?:opening|reopening|closing|saving)\b[^.!?;\n]{0,100}\b(?:inspect|show|preview|check|confirm)\b/i;
  const inspectionWithoutLifecycle = /\b(?:inspect|show|preview|check|confirm)\b[^.!?;\n]{0,100}\bwithout\s+(?:first\s+)?(?:opening|reopening|closing|saving)\b/i;
  const previewOnly = /\b(?:preview|inspect|show)\s+only\b[^.!?;\n]{0,100}\b(?:open|reopen|close|save)\b/i;
  if (!directDenial.test(text) && !COORDINATED_GLOBAL_NO_WRITE.test(text) && !deferredInspection.test(text) && !inspectionWithoutLifecycle.test(text) && !previewOnly.test(text)) return false;

  // A lifecycle turn can authorize one application-state change while denying
  // another (for example, "open it, then close without saving"). Strip only
  // the denied/inspection clauses and keep the turn writable when an
  // affirmative lifecycle command remains.
  const affirmativeText = text
    .replace(new RegExp(directDenial.source, "gi"), " ")
    .replace(new RegExp(COORDINATED_GLOBAL_NO_WRITE.source, "gi"), " ")
    .replace(new RegExp(deferredInspection.source, "gi"), " ")
    .replace(new RegExp(inspectionWithoutLifecycle.source, "gi"), " ")
    .replace(new RegExp(previewOnly.source, "gi"), " ");
  return !containsDocumentLifecycleMutation(affirmativeText);
}

export function isAffirmativeDocumentLifecycleMutation(userText: string | null | undefined): boolean {
  const text = `${userText || ""}`.replace(/\s+/g, " ").trim();
  return !!text && containsDocumentLifecycleMutation(text) && !deniesDocumentLifecycleMutation(text);
}

export function classifyAgentTurn(userText: string | null | undefined): AgentTurnKind {
  const text = `${userText || ""}`.replace(/\s+/g, " ").trim().toLowerCase();
  if (!text) return "conversation";
  const documentLifecycleMutation = containsDocumentLifecycleMutation(text);
  // A scoped persistence constraint such as "make the edit, but do not save"
  // must not downgrade the model edit to an inspection. Lifecycle denial is
  // turn-defining only when the turn actually asks to change document
  // lifecycle state (for example, "do not save the Revit model").
  const documentLifecycleDenied = documentLifecycleMutation && deniesDocumentLifecycleMutation(text);
  const previewOnly = hasPreviewOrGlobalNoWriteFraming(text);
  const explicitMutation = containsMutationVerb(text);
  // Opening/saving/closing a Revit document changes authoritative application
  // state even when the user correctly says not to edit model elements.
  if (documentLifecycleMutation && !documentLifecycleDenied) return "mutation";
  if (previewOnly || documentLifecycleDenied) return "inspection";
  const explicitlyConceptualFraming = /^(?:please\s+)?(?:for planning\b|explain\b|(?:can|could|would) you explain\b|what\b|how\b|why\b|should\s+(?:i|we)\b|tell me about\b)/.test(text);
  if (isConceptualQuestion(text)
      && (!explicitMutation || explicitlyConceptualFraming)
      && !/\b(?:then|and|also|otherwise)\s+(?:add|fix|change|modify|edit|create|delete|remove|move|place|set|update|replace)\b/.test(text)) return "conversation";
  if (explicitMutation) return "mutation";
  if (!/^\s*(?:why|what|how|is|are|does|do|can you tell|could you tell)\b/.test(text) &&
      /\b(?:wrong|incorrect|needs? to be|should be|too (?:large|small|high|low|big))\b/.test(text)) return "mutation";
  if (/\b(?:only\s+show|show\s+only)\b/.test(text) && hasRevitWorkSubject(text)) return "mutation";
  const navigationText = withoutAdjectivalOpenDocumentState(text);
  if (/\b(?:open|show|activate|take me to|go to|zoom to|select|highlight)\b/.test(navigationText)) return "navigation";
  if (/\b(?:ping|probe|status|find|locate|where|which|how many|count|list|inspect|check|verify|identify|current|active|selected)\b/.test(text)) return "inspection";
  // Delegated Revit work is commonly written as a terse redline or noun phrase
  // (for example, "12x10 SUPPLY DUCT at the marked branch"). Once a turn has a
  // concrete Revit subject and is neither a question nor explicitly read-only,
  // default to doing the work instead of requiring a magic mutation verb.
  if (hasRevitWorkSubject(text)) return "mutation";
  return "conversation";
}

function hasNoWriteAuthority(text: string): boolean {
  if (containsDocumentLifecycleMutation(text)) {
    return deniesDocumentLifecycleMutation(text)
      || /\b(?:preview|read[ -]?only|analysis)\s+only\b/i.test(text);
  }
  return hasPreviewOrGlobalNoWriteFraming(text);
}

// Keep durable assignment effect classification and the host-enforced teammate
// loop on one no-write grammar. Scoped exclusions such as "do not modify
// non-mechanical sheets" constrain an authorized mutation; they do not turn the
// entire request into a read-only task.
export function isExplicitNoWriteRequest(userText: string | null | undefined): boolean {
  const text = `${userText || ""}`.replace(/\s+/g, " ").trim();
  return !!text && hasNoWriteAuthority(text);
}

function writeAuthorized(text: string, kind: AgentTurnKind, noWrite: boolean): boolean {
  if (kind !== "mutation" || noWrite) return false;
  if (/\b(?:should|can|could|would)\s+(?:i|we)\b/i.test(text)) return false;
  return true;
}

function explicitlyRequestsExecutablePreview(text: string, kind: AgentTurnKind): boolean {
  if (kind === "conversation") return false;
  if (/\b(?:preflight|dry[ -]?run|simulation|simulate(?:d)?)\b/i.test(text)) return true;
  return /\bpreview\b/i.test(text) && containsMutationVerb(text.toLowerCase());
}

function ambiguityFor(text: string, kind: AgentTurnKind): "none" | "low" | "material" {
  if (kind !== "mutation") return "none";
  if (/^(?:please\s+)?(?:fix|change|update|move|delete|remove|replace)\s+(?:it|that|this|those|them)\.?$/i.test(text)) return "material";
  if (text.length < 18) return "material";
  return /\b(?:some|something|whatever|one of them|as needed)\b/i.test(text) ? "low" : "none";
}

function contextIdentity(contextValue: unknown, kind: AgentTurnKind): { state: TeammateContextState; signature: string | null } {
  if (kind === "conversation") return { state: "not_required", signature: null };
  const context = objectValue(contextValue);
  if (Object.prototype.hasOwnProperty.call(context, "revit")) {
    const revit = objectValue(context.revit);
    const source = objectValue(revit.source);
    const document = objectValue(revit.document);
    const title = boundedString(document.title, 260);
    const path = boundedString(document.path, 1000);
    const projectIdentity = objectValue(document.projectIdentity ?? document.project_identity);
    const fingerprint = boundedString(projectIdentity.fingerprint ?? document.project_fingerprint, 256).toLowerCase();
    const executor = boundedString(revit.courier_executor_id, 200);
    const processId = Number.isInteger(revit.process_id) && Number(revit.process_id) > 0 ? Number(revit.process_id) : 0;
    if (source.live !== true || boundedString(source.error, 200) || !title || !processId || (!path && !fingerprint)) {
      return { state: "invalid", signature: null };
    }
    return { state: "live", signature: sha256(JSON.stringify({ title: title.toLowerCase(), path: path.toLowerCase(), fingerprint, processId, executor })) };
  }
  const ui = objectValue(context.ui);
  if (Object.prototype.hasOwnProperty.call(ui, "revit_document")) {
    const document = objectValue(ui.revit_document);
    const title = boundedString(document.title, 260);
    const path = boundedString(document.path, 1000);
    const fingerprint = boundedString(document.project_fingerprint, 256).toLowerCase();
    const executor = boundedString(document.courier_executor_id, 200);
    const processId = Number.isInteger(document.process_id) && Number(document.process_id) > 0 ? Number(document.process_id) : 0;
    if (boundedString(document.error, 200) || !title || !processId || (!path && !fingerprint)) return { state: "invalid", signature: null };
    return { state: "live", signature: sha256(JSON.stringify({ title: title.toLowerCase(), path: path.toLowerCase(), fingerprint, processId, executor })) };
  }
  return { state: "missing", signature: null };
}

export function buildTeammateTurnContract(req: Pick<ChatRequest, "user_text" | "context">): TeammateTurnContract {
  const text = normalizedUserText(req);
  const turnKind = classifyAgentTurn(text);
  const identity = contextIdentity(req.context, turnKind);
  const ambiguity = ambiguityFor(text, turnKind);
  const noWrite = hasNoWriteAuthority(text);
  const authorized = writeAuthorized(text, turnKind, noWrite);
  const previewRequired = explicitlyRequestsExecutablePreview(text, turnKind);
  const stage: TeammateLoopStage = ambiguity === "material"
    ? "clarify"
    : identity.state === "missing" || identity.state === "invalid"
      ? "ground"
      : turnKind === "conversation" ? "answer" : previewRequired || turnKind === "mutation" ? "preview" : "discover";
  return {
    schema: "revit-operator.teammate-loop.v1",
    turn_kind: turnKind,
    intent_summary: text.slice(0, 260),
    ambiguity,
    context_state: identity.state,
    stage,
    no_write: noWrite,
    write_authorized: authorized,
    preview_required: previewRequired,
    max_apply_attempts: 32,
    verification_required: turnKind === "mutation",
    user_text_sha256: sha256(text),
    document_signature: identity.signature
  };
}

export function formatTeammateTurnContract(req: Pick<ChatRequest, "user_text" | "context">): string {
  const contract = buildTeammateTurnContract(req);
  if (!contract.intent_summary) return "";
  const compact = {
    schema: contract.schema,
    turn_kind: contract.turn_kind,
    ambiguity: contract.ambiguity,
    context_state: contract.context_state,
    stage: contract.stage,
    no_write: contract.no_write,
    write_authorized: contract.write_authorized,
    preview_required: contract.preview_required,
    max_apply_attempts: contract.max_apply_attempts,
    verification_required: contract.verification_required,
    user_text_sha256: contract.user_text_sha256,
    document_signature: contract.document_signature
  };
  const rules = contract.turn_kind === "conversation"
    ? "Answer naturally; do not call Revit for a conceptual answer."
    : contract.ambiguity === "material"
      ? "Paraphrase the likely intent and ask one focused question; take no Revit action."
      : contract.preview_required && contract.no_write
        ? "Use live context; resolve the exact target and execute one real bounded, noncommitting Revit preview or dry-run, then stop before apply. A prose plan, table, proposed receipt, capture, cropped image, render, or temporary visual is not an executed mutation preview without a successful noncommitting Revit primitive receipt. If discovery proves no preview-capable target or primitive exists, report that exact blocker instead of claiming preview completion."
        : contract.preview_required
          ? "Use live context; resolve the exact target and execute a real bounded preview or dry-run before applying; bind the apply to that preview and verify by readback/capture before success. A prose plan, table, or proposed receipt is not an executed preview."
      : contract.turn_kind === "mutation"
        ? "Use live context; discover one exact contract if needed; preview when the primitive supports it or the preview is useful, but atomic Revit primitives may apply directly; verify by readback/capture before success."
        : "Use live context and the smallest read/navigation step; discover one exact contract if needed; never mutate the model.";
  return `CURRENT TURN CONTRACT (host-enforced):\n${JSON.stringify(compact)}\n${rules}${contract.no_write ? " No-write wording is authoritative: preview/read only." : ""}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, stableValue(item)]));
}

function actionSignature(path: string, body: unknown): string {
  const normalizedPath = path.trim().toLowerCase().replace(/^\/revit\/transaction-(?:plan|apply)$/, "/revit/transaction").replace(/^revit_transaction_(?:plan|apply)$/, "revit_transaction");
  const source = objectValue(body);
  const ignored = new Set(["apply", "dryRun", "dry_run", "preview", "commit", "execute", "expectedPlanHash", "expected_plan_hash", "confirmationToken", "confirmation_token", "confirm", "confirmed"]);
  const envelope = Object.fromEntries(Object.entries(source).filter(([key]) => !ignored.has(key)));
  if (normalizedPath === "/revit/native-api-mutation-ops") {
    const transaction = objectValue(envelope.transaction);
    envelope.transaction = Object.fromEntries(Object.entries(transaction)
      .filter(([key]) => !["mode", "name", "commit", "execute", "confirm", "confirmed"].includes(key)));
  }
  return sha256(JSON.stringify({ path: normalizedPath, body: stableValue(envelope) }));
}

function targetTokens(value: unknown): string[] {
  const tokens = new Set<string>();
  const scopeEnvelopeKeys = new Set([
    "allowedexistingelementids",
    "commitallowedexistingelementids",
    "unexpectedexistingelementids",
    "transientcreatedids"
  ]);
  const visit = (node: unknown, key = "", depth = 0): void => {
    if (depth > 8 || tokens.size >= 64) return;
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    // These IDs fence the maximum native transaction scope; they are not all
    // principal targets that a verification read must independently observe.
    if (scopeEnvelopeKeys.has(normalizedKey)) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
        if (normalizedKey === "parameters") tokens.add(`parameter:${childKey.trim().toLowerCase()}`);
        visit(child, childKey, depth + 1);
      }
      return;
    }
    if (node === null || node === undefined) return;
    if (typeof node === "string" && /^[\[{]/.test(node.trim())) {
      try { visit(JSON.parse(node), key, depth + 1); return; } catch {}
    }
    const scalar = `${node}`.trim().toLowerCase();
    if (!scalar || scalar.length > 260) return;
    const exportedViewMatch = scalar.match(/(?:^|[\\/])revit_(\d+)_/i);
    if (exportedViewMatch) tokens.add(`id:${exportedViewMatch[1]}`);
    // Native program step IDs (for example "set" or "after") are local
    // handles, not Revit element identities. Bare id/ids fields bind only
    // canonical numeric Revit element IDs; named element/view/sheet fields are
    // handled by the more specific rule below.
    if ((normalizedKey === "id" || normalizedKey === "ids") && /^\d+$/.test(scalar)) tokens.add(`id:${scalar}`);
    if (/(?:element|schedule|view|sheet|room|space|type|family|target|source|host|main).*ids?$/.test(normalizedKey)) {
      tokens.add(`${normalizedKey.replace(/s$/, "")}:${scalar}`);
      tokens.add(`id:${scalar}`);
    }
    if (/(?:parameter|field).*names?$/.test(normalizedKey) || normalizedKey === "parameter" || normalizedKey === "field") tokens.add(`parameter:${scalar}`);
    if (normalizedKey === "mark") tokens.add(`mark:${scalar}`);
    if (["filepath", "documentpath", "path"].includes(normalizedKey) && /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(scalar)) {
      tokens.add(`path:${scalar.replace(/\\/g, "/")}`);
    }
  };
  visit(value);
  return [...tokens].sort();
}

function expectedValues(value: unknown, includeIdentityRenames = true): string[] {
  const values = new Set<string>();
  const visit = (node: unknown, key = "", parent = "", depth = 0): void => {
    if (depth > 6 || values.size >= 32) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, parent, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) visit(child, childKey, key, depth + 1);
      return;
    }
    if (node === null || node === undefined) return;
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const normalizedParent = parent.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const valueIsPredicate = /(?:filter|condition|rule|criterion|criteria)/.test(normalizedParent);
    const identityRename = includeIdentityRenames && ["newname", "newnumber"].includes(normalizedKey);
    const assignedValue = ["value", "newvalue", "replaceto", "targetvalue"].includes(normalizedKey);
    if (normalizedParent === "parameters" || (!valueIsPredicate && (identityRename || assignedValue))) {
      values.add(JSON.stringify(node));
    }
  };
  visit(value);
  return [...values].sort();
}

function operationFor(path: string, body: unknown): string {
  const normalizedPath = path.toLowerCase();
  const serialized = JSON.stringify(body ?? null).toLowerCase();
  if (/(?:create|duplicate|place|add)/.test(normalizedPath) || /"kind":"(?:create|duplicate|place|add)/.test(serialized)) return "create";
  if (normalizedPath.includes("delete") || /"kind":"delete"/.test(serialized)) return "delete";
  if (normalizedPath.includes("parameter") || /"kind":"setparameters"/.test(serialized) || /"parameters"/.test(serialized)) return "set_parameters";
  if (normalizedPath.includes("type")) return "change_type";
  if (normalizedPath.includes("move") || normalizedPath.includes("route")) return "geometry";
  return "mutation";
}

function previewFlags(value: unknown): { preview: boolean; apply: boolean } {
  const body = objectValue(value);
  const transactionMode = (boundedString(objectValue(body.transaction).mode, 40) || boundedString(body.mode, 40)).toLowerCase();
  const preview = body.dryRun === true || body.dry_run === true || body.preview === true || body.apply === false
    || ["rollback", "preview", "dry_run", "dry-run"].includes(transactionMode);
  const apply = body.apply === true || body.dryRun === false || body.dry_run === false || body.commit === true || body.execute === true
    || ["commit", "apply", "execute"].includes(transactionMode);
  return { preview: preview && !apply, apply: apply && !preview };
}

function classifyPathCall(method: unknown, pathValue: unknown, body: unknown): PendingCall {
  const methodName = `${method || ""}`.trim().toUpperCase();
  const path = `${pathValue || ""}`.trim().toLowerCase();
  // MCP adapters may carry an HTTP request body as serialized JSON. Classify
  // that wire form identically to an object body so dry-runs are not mistaken
  // for applies and preview/apply signatures remain comparable.
  const normalizedBody = structuredActionBody(body);
  const signature = actionSignature(path, normalizedBody);
  const target_tokens = targetTokens(normalizedBody);
  const operation = operationFor(path, normalizedBody);
  const expected_values = expectedValues(normalizedBody, operation !== "create");
  const call = (effect: Effect): PendingCall => ({ effect, signature, path, target_tokens, expected_values, operation });
  if (NAVIGATION_PATHS.has(path)) return call("navigation");
  if (DISCOVERY_PATHS.has(path)) return call("discovery");
  if (methodName === "GET") return call("read");
  if (methodName === "POST" && path === "/revit/transaction-plan") return call("preview");
  if (methodName === "POST" && !path.startsWith("/revit/")) return call("unknown");
  const conditionalEffect = methodName === "POST" ? conditionalActionPathEffect(path, normalizedBody) : undefined;
  if (conditionalEffect !== undefined) return call(conditionalEffect);
  if (methodName === "POST" && !pathLooksWrite(path, normalizedBody)) return call("read");
  if (methodName !== "POST" || !path.startsWith("/revit/")) return call("unknown");
  const flags = previewFlags(normalizedBody);
  return call(flags.preview ? "preview" : "apply");
}

function classifyMcpCall(toolValue: unknown, argsValue: unknown): PendingCall {
  const tool = `${toolValue || ""}`.trim();
  const args = objectValue(structuredActionBody(argsValue));
  if (tool === "revit_call_tool") return classifyPathCall(args.method, args.path, args.body);
  // The typed PDF alias exposes the same handler and dry-run semantics as the
  // generic route. Classify it before the broad export_* observation family;
  // a real PDF export creates a durable file while dryRun=true is executable
  // preflight evidence.
  if (tool === "revit_export_pdf") return classifyPathCall("POST", "/revit/export-pdf", args);
  const target_tokens = targetTokens(args);
  const operation = operationFor(tool, args);
  const expected_values = expectedValues(args, operation !== "create");
  const call = (effect: Effect, signaturePath = tool): PendingCall => ({ effect, signature: actionSignature(signaturePath, args), path: tool, target_tokens, expected_values, operation });
  if (DISCOVERY_TOOLS.has(tool)) return call("discovery");
  if (/^revit_(?:ping|get_|list_|query_|find_|search_|tool_|write_grant_status|resolve_|trace_|measure_|analyze_|audit_|quantify_|capture_|export_|native_api_(?:ops|policy|catalog|search)|transaction_validate)/.test(tool)) {
    return call("read");
  }
  if (/^revit_(?:activate_|highlight_)/.test(tool)) return call("navigation");
  if (tool === "revit_transaction_plan") return call("preview", "revit_transaction");
  if (tool === "revit_transaction_apply") return call("apply", "revit_transaction");
  const flags = previewFlags(args);
  if (tool === "run_dynamic_revit_program") {
    return call(flags.preview ? "preview" : flags.apply ? "apply" : "unknown", "revit_dynamic_program");
  }
  if (flags.preview || (DEFAULT_PREVIEW_TOOLS.has(tool) && !flags.apply)) return call("preview");
  if (/^revit_(?:set_|update_|replace_|delete_|move_|rotate_|create_|place_|route_|connect_|disconnect_|transaction_apply|open_|close_|save_|sync_)/.test(tool) || flags.apply) {
    return call("apply");
  }
  return call("unknown");
}

function canonicalTypedAliasForRoute(pathValue: unknown): string | null {
  const path = `${pathValue || ""}`.trim().toLowerCase();
  if (!path.startsWith("/revit/") || path.length <= "/revit/".length) return null;
  const suffix = path.slice("/revit/".length);
  if (!/^[a-z0-9][a-z0-9/-]*$/.test(suffix)) return null;
  return `revit_${suffix.replace(/[/-]+/g, "_")}`;
}

function documentedToolRouteFromResult(result: unknown): { alias: string; route: DocumentedToolRoute } | null {
  const root = objectValue(result);
  const content = Array.isArray(root.content) ? root.content : [];
  for (const item of content) {
    const text = boundedString(objectValue(item).text, 2_000_000);
    if (!text || !text.startsWith("{")) continue;
    try {
      const doc = objectValue(JSON.parse(text));
      const method = `${doc.method || ""}`.trim().toUpperCase();
      const path = `${doc.path || ""}`.trim().toLowerCase();
      const alias = canonicalTypedAliasForRoute(path);
      if ((method === "GET" || method === "POST") && alias) {
        return { alias, route: { method, path } as DocumentedToolRoute };
      }
    } catch {}
  }
  return null;
}

function classifyDocumentedMcpCall(state: TeammateLoopState, toolValue: unknown, argsValue: unknown): PendingCall {
  const direct = classifyMcpCall(toolValue, argsValue);
  if (direct.effect !== "unknown") return direct;
  const tool = `${toolValue || ""}`.trim();
  const documented = state.documented_tool_routes.get(tool);
  return documented
    ? classifyPathCall(documented.method, documented.path, structuredActionBody(argsValue))
    : direct;
}

function turnKey(req: Pick<ChatRequest, "session_id" | "message_id">): string {
  return `${req.session_id || ""}::${req.message_id || ""}`;
}

function stateFor(req: ChatRequest): TeammateLoopState {
  const now = Date.now();
  for (const [key, state] of statesByTurn) if (state.expires_at_ms <= now) statesByTurn.delete(key);
  const key = turnKey(req);
  const incomingText = normalizedUserText(req);
  const exactExisting = statesByTurn.get(key);
  if (!incomingText && exactExisting) {
    exactExisting.expires_at_ms = now + MAX_STATE_AGE_MS;
    const currentIdentity = contextIdentity(req.context, exactExisting.contract.turn_kind);
    const identityMatches = exactExisting.contract.turn_kind === "conversation" || (
      currentIdentity.state === "live" &&
      currentIdentity.signature === exactExisting.contract.document_signature
    );
    if (!identityMatches) {
      exactExisting.contract.context_state = currentIdentity.state === "live" ? "invalid" : currentIdentity.state;
      exactExisting.contract.stage = "blocked";
      exactExisting.blocked_reason = "document_identity_changed_or_unavailable";
    }
    return exactExisting;
  }
  const contract = buildTeammateTurnContract(req);
  const existing = exactExisting;
  if (existing && existing.contract.user_text_sha256 === contract.user_text_sha256 && existing.contract.document_signature === contract.document_signature) {
    existing.expires_at_ms = now + MAX_STATE_AGE_MS;
    return existing;
  }
  const state: TeammateLoopState = {
    key,
    contract,
    expires_at_ms: now + MAX_STATE_AGE_MS,
    successful_preview_signatures: new Set(),
    pending: new Map(),
    preview_action_ids: [],
    preview_receipts: [],
    apply_action_id: null,
    verification_action_ids: [],
    apply_attempts: 0,
    stage_apply_attempts: 0,
    apply_succeeded: false,
    apply_signature: "",
    completed_apply_signatures: new Set(),
    apply_target_tokens: new Set(),
    apply_target_tokens_inferred: false,
    apply_expected_values: new Set(),
    verification_observed_target_tokens: new Set(),
    verification_observed_values: new Set(),
    verification_has_substantive_readback: false,
    apply_operation: "",
    verified: false,
    verification_mode: "none",
    verification_action_id: null,
    verification_evidence_sha256: null,
    tool_doc_calls: 0,
    documented_tool_routes: new Map(),
    blocked_reason: null,
    active_host_version_year: activeHostVersionYear(req.context)
  };
  statesByTurn.set(key, state);
  return state;
}

function clearVerification(state: TeammateLoopState): void {
  state.verified = false;
  state.verification_mode = "none";
  state.verification_action_id = null;
  state.verification_evidence_sha256 = null;
  state.verification_observed_target_tokens.clear();
  state.verification_observed_values.clear();
  state.verification_has_substantive_readback = false;
}

function isContextFreeDocumentBootstrapCall(call: PendingCall): boolean {
  return call.effect === "apply" && (call.path === "revit_open_model" || call.path === "/revit/open-model");
}

function gateCall(state: TeammateLoopState, call: PendingCall): string | null {
  const contract = state.contract;
  if (contract.ambiguity === "material") return "material_ambiguity_requires_clarification";
  if (call.effect === "unknown") return "unknown_revit_contract_requires_one_tool_doc_lookup";
  if (contract.turn_kind === "conversation") return "conceptual_turn_does_not_require_revit";
  // Opening the first document is the one exact mutation that must be able to
  // establish live document context. All ordinary reads, navigation, previews,
  // and model writes remain fail-closed until a document identity is live.
  if (call.effect !== "discovery" && contract.context_state !== "live" && !isContextFreeDocumentBootstrapCall(call)) {
    return "live_revit_context_required";
  }
  if (isContextFreeDocumentBootstrapCall(call) && openModelActiveHostMismatch(state.active_host_version_year, call.target_tokens)) {
    return "open_model_sample_year_mismatch";
  }
  if (call.effect === "apply") {
    if (contract.turn_kind !== "mutation") return "turn_does_not_authorize_model_mutation";
    if (contract.no_write) return "user_no_write_limit";
    if (!contract.write_authorized) return "explicit_write_authority_required";
    if (state.stage_apply_attempts >= 1) {
      if (!state.apply_succeeded || !state.verified) return "prior_apply_verification_required";
      if (state.completed_apply_signatures.has(call.signature)) return "completed_apply_may_not_be_retried";
      state.successful_preview_signatures.clear();
      state.apply_action_id = null;
      state.stage_apply_attempts = 0;
      state.apply_succeeded = false;
      state.apply_signature = "";
      state.apply_target_tokens.clear();
      state.apply_target_tokens_inferred = false;
      state.apply_expected_values.clear();
      state.apply_operation = "";
      clearVerification(state);
      state.blocked_reason = null;
    }
  }
  if (call.effect === "preview" && state.stage_apply_attempts > 0) {
    if (!state.apply_succeeded || !state.verified) return "preview_before_prior_apply_verification_not_allowed";
    if (state.completed_apply_signatures.has(call.signature)) return "completed_apply_may_not_be_retried";
    state.successful_preview_signatures.clear();
    state.apply_action_id = null;
    state.stage_apply_attempts = 0;
    state.apply_succeeded = false;
    state.apply_signature = "";
    state.apply_target_tokens.clear();
    state.apply_target_tokens_inferred = false;
    state.apply_expected_values.clear();
    state.apply_operation = "";
    state.blocked_reason = null;
  }
  return null;
}

function registerPending(state: TeammateLoopState, actionId: string, call: PendingCall): void {
  if (state.blocked_reason !== "apply_failed_or_outcome_unknown_no_retry") state.blocked_reason = null;
  state.pending.set(actionId, call);
  if (call.effect === "discovery" && /(?:tool-doc|revit_tool_doc)$/.test(call.path)) state.tool_doc_calls += 1;
  if (call.effect === "preview") state.preview_action_ids.push(actionId);
  if (call.effect === "apply") {
    clearVerification(state);
    state.apply_attempts += 1;
    state.stage_apply_attempts += 1;
    state.apply_action_id = actionId;
    state.apply_signature = call.signature;
    state.apply_target_tokens = new Set(call.target_tokens);
    state.apply_target_tokens_inferred = call.target_tokens.filter(token => token.startsWith("id:")).length === 0;
    state.apply_expected_values = new Set(call.expected_values);
    state.apply_operation = call.operation;
    state.contract.stage = "apply";
  } else if (state.stage_apply_attempts > 0 && (call.effect === "read" || call.effect === "navigation")) {
    state.verification_action_ids.push(actionId);
    state.contract.stage = "verify";
  } else if (call.effect === "preview") state.contract.stage = "preview";
  else if ((call.effect === "read" || call.effect === "navigation" || call.effect === "discovery")
      && state.successful_preview_signatures.size === 0
      && state.contract.stage !== "report") state.contract.stage = "discover";
}

function resultSucceeded(result: ToolResult): boolean {
  if (result.status !== "done") return false;
  const body = objectValue(result.result_json);
  return body.ok !== false && body.success !== false;
}

function evidenceValues(value: unknown): Set<string> {
  const values = new Set<string>();
  const visit = (node: unknown, depth = 0): void => {
    if (depth > 8 || values.size >= 512 || node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (node && typeof node === "object") { for (const item of Object.values(node as Record<string, unknown>)) visit(item, depth + 1); return; }
    if (typeof node === "string" && /^[\[{]/.test(node.trim())) {
      try { visit(JSON.parse(node), depth + 1); } catch {}
    }
    values.add(JSON.stringify(node));
  };
  visit(value);
  return values;
}

function explicitVerification(value: unknown): boolean {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length < 2 || text.length > 1_000_000 || (!text.startsWith("{") && !text.startsWith("["))) return false;
    try { return explicitVerification(JSON.parse(text)); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some(explicitVerification);
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (["verified", "complete", "allpassed", "notexists"].includes(normalized) && item === true) return true;
    if (normalized === "exists" && item === false) return true;
    if (explicitVerification(item)) return true;
  }
  return false;
}

function substantiveReadback(value: unknown, depth = 0): boolean {
  if (value === null || value === undefined || depth > 8) return false;
  if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
    try { return substantiveReadback(JSON.parse(value), depth + 1); } catch { return false; }
  }
  if (Array.isArray(value)) return value.length > 0 && value.some(item => substantiveReadback(item, depth + 1));
  if (typeof value !== "object") return false;
  const ignored = new Set(["ok", "success", "status", "action", "message", "open_prints_folder_url"]);
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    if (ignored.has(key.toLowerCase())) return false;
    if (item === null || item === undefined || item === "") return false;
    if (Array.isArray(item)) return item.length > 0;
    if (typeof item === "object") return Object.keys(item as Record<string, unknown>).length > 0;
    return true;
  });
}

function verificationMatches(state: TeammateLoopState, evidence: unknown, requireExplicit: boolean): boolean {
  if (requireExplicit && !explicitVerification(evidence)) return false;
  const observed = evidenceValues(evidence);
  if (state.apply_expected_values.size > 0) return [...state.apply_expected_values].every(value => observed.has(value));
  return explicitVerification(evidence) || (!requireExplicit && substantiveReadback(evidence));
}

function accumulatedReadbackMatches(state: TeammateLoopState): boolean {
  if (!state.verification_has_substantive_readback) return false;
  if (state.apply_expected_values.size > 0
      && ![...state.apply_expected_values].every(value => state.verification_observed_values.has(value))) return false;
  const applyIds = [...state.apply_target_tokens].filter(token => token.startsWith("id:"));
  const applyIdentityTokens = applyIds.length > 0
    ? applyIds
    : [...state.apply_target_tokens].filter(token => !token.startsWith("parameter:"));
  if (applyIdentityTokens.length > 0) {
    if (state.apply_target_tokens_inferred) {
      return applyIdentityTokens.some(token => state.verification_observed_target_tokens.has(token));
    }
    return state.apply_operation === "create"
      ? applyIdentityTokens.some(token => state.verification_observed_target_tokens.has(token))
      : applyIdentityTokens.every(token => state.verification_observed_target_tokens.has(token));
  }
  return [...state.apply_target_tokens].some(token => state.verification_observed_target_tokens.has(token));
}

function explicitDocumentOpenCompletion(call: PendingCall, evidence: unknown): boolean {
  if (call.path !== "revit_open_model" && call.path !== "/revit/open-model") return false;
  const requestedPaths = new Set(call.target_tokens.filter(token => token.startsWith("path:")));
  if (requestedPaths.size === 0) return false;
  let matched = false;
  const visit = (value: unknown, depth = 0): void => {
    if (matched || value === null || value === undefined || depth > 8) return;
    if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
      try { visit(JSON.parse(value), depth + 1); } catch {}
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const status = `${row.status || ""}`.trim().toLowerCase();
    const title = `${row.title || ""}`.trim();
    const resultPaths = targetTokens({ path: row.path }).filter(token => token.startsWith("path:"));
    if (["success", "already active", "reopened and activated", "unloaded link and activated"].includes(status)
        && title && resultPaths.some(token => requestedPaths.has(token))) {
      matched = true;
      return;
    }
    for (const child of Object.values(row)) visit(child, depth + 1);
  };
  visit(evidence);
  return matched;
}

function markVerified(
  state: TeammateLoopState,
  mode: Exclude<TeammateLoopState["verification_mode"], "none">,
  actionId: string,
  evidence: unknown
): void {
  state.verified = true;
  state.verification_mode = mode;
  state.verification_action_id = actionId;
  state.verification_evidence_sha256 = `sha256:${sha256(JSON.stringify(stableValue(evidence)))}`;
  if (state.apply_signature) state.completed_apply_signatures.add(state.apply_signature);
  state.contract.stage = "report";
}

function clearKnownNoEffectApply(state: TeammateLoopState): void {
  state.stage_apply_attempts = Math.max(0, state.stage_apply_attempts - 1);
  state.apply_action_id = null;
  state.apply_succeeded = false;
  state.apply_signature = "";
  state.apply_target_tokens.clear();
  state.apply_target_tokens_inferred = false;
  state.apply_expected_values.clear();
  state.apply_operation = "";
  clearVerification(state);
  state.blocked_reason = null;
  state.contract.stage = state.successful_preview_signatures.size > 0 ? "preview" : "apply";
}

function recordResult(state: TeammateLoopState, actionId: string, succeeded: boolean, evidence?: unknown): void {
  const pending = state.pending.get(actionId);
  if (!pending) return;
  state.pending.delete(actionId);
  if (pending.effect === "preview" && succeeded) {
    state.successful_preview_signatures.add(pending.signature);
    state.preview_receipts.push(successfulPreviewReceipt(actionId, pending.path, sha256(JSON.stringify(stableValue(evidence)))));
  }
  if (pending.effect === "apply") {
    state.apply_succeeded = succeeded;
    if (!succeeded) {
      if (evidenceIsKnownNoEffectFailure(evidence, {
        firstDocumentOpen: isContextFreeDocumentBootstrapCall(pending),
        contextIsLive: state.contract.context_state === "live"
      })) clearKnownNoEffectApply(state);
      else {
        state.blocked_reason = "apply_failed_or_outcome_unknown_no_retry";
        state.contract.stage = "blocked";
      }
    } else {
      for (const token of targetTokens(evidence)) state.apply_target_tokens.add(token);
      // An apply response is execution evidence, not an independent observation.
      // Admit same-call verification only when the primitive returns an explicit
      // verified/complete receipt (and, when present, the requested values). A
      // generic non-empty success payload must advance to a target-bound readback.
      if (verificationMatches(state, evidence, true) || explicitDocumentOpenCompletion(pending, evidence)) {
        markVerified(state, "explicit_apply_receipt", actionId, evidence);
      } else state.contract.stage = "verify";
    }
  }
  const verificationIdentityTokens = [...new Set([...pending.target_tokens, ...targetTokens(evidence)])]
    .filter(token => !token.startsWith("parameter:"));
  const applyIdentityTokens = [...state.apply_target_tokens].filter(token => !token.startsWith("parameter:"));
  const targetBound = applyIdentityTokens.length > 0
    ? verificationIdentityTokens.some(token => state.apply_target_tokens.has(token))
    : pending.target_tokens.some(token => state.apply_target_tokens.has(token));
  if (state.apply_succeeded && succeeded && targetBound && pending.effect === "read" && substantiveReadback(evidence)) {
    for (const token of [...pending.target_tokens, ...targetTokens(evidence)]) {
      state.verification_observed_target_tokens.add(token);
    }
    for (const value of evidenceValues(evidence)) state.verification_observed_values.add(value);
    state.verification_has_substantive_readback = true;
    if (accumulatedReadbackMatches(state)) {
      markVerified(state, "target_bound_readback", actionId, {
        verification_action_ids: state.verification_action_ids,
        target_tokens: [...state.verification_observed_target_tokens].sort(),
        observed_values: [...state.verification_observed_values].sort()
      });
    }
  }
}

function ingestToolResults(state: TeammateLoopState, results: ToolResult[] | undefined): void {
  for (const result of results || []) recordResult(state, result.action_id, resultSucceeded(result), result);
}

function receipt(state: TeammateLoopState): NonNullable<ChatResponse["teammate_loop_receipt"]> {
  return buildTeammateLoopReceipt(state);
}

const INCOMPLETE_MUTATION_REPORTS = [
  /\[teammate_loop_blocked\]/i,
  /\bassignment is blocked\b/i,
  /\bcannot claim (?:the )?(?:revit )?change is complete\b/i,
  /\brequest(?:ed)?(?: [^.\n]{0,80})? (?:is|was) not (?:yet )?complete\b/i,
  /\bnot yet complete\b/i
];

function assistantClaimsExecutedPreview(text: string): boolean {
  return /\b(?:preview|preflight|dry[ -]?run)\b[^.!?\n]{0,80}\b(?:complete(?:d)?|successful|passed|receipt|done|ready|generated|created|produced)\b/i.test(text)
    || /\b(?:complete(?:d)?|successful|passed|done|generated|created|produced)\b[^.!?\n]{0,80}\b(?:preview|preflight|dry[ -]?run)\b/i.test(text);
}

function assistantReportsNoPreviewCandidate(text: string): boolean {
  return /\b(?:no|not any|zero)\b[^.!?\n]{0,100}\b(?:eligible|matching|writable|preview-capable|candidate|target)s?\b/i.test(text)
    || /\b(?:already|currently)\b[^.!?\n]{0,100}\b(?:matches|complies|satisfies|complete|correct)\b/i.test(text)
    || /\bno (?:change|rename|edit|update|action)s? (?:is|are|was|were) (?:needed|required|necessary)\b/i.test(text);
}

export function reconcileTeammateReceiptWithAssistant(
  value: ChatResponse["teammate_loop_receipt"] | undefined,
  assistantText: string
): ChatResponse["teammate_loop_receipt"] | undefined {
  if (!value || value.turn_kind !== "mutation" || value.apply_attempts < 1) return value;
  if (!INCOMPLETE_MUTATION_REPORTS.some(pattern => pattern.test(assistantText))) return value;
  return {
    ...value,
    stage: "blocked",
    verified: false,
    verification_mode: "none",
    verification_action_id: null,
    verification_evidence_sha256: null,
    blocked_reason: value.blocked_reason || "assistant_reported_incomplete"
  };
}

export function guardGenericTeammateDecision(req: ChatRequest, decision: ChatResponse): ChatResponse {
  const state = stateFor(req);
  ingestToolResults(state, req.tool_results);
  const dynamicReceipt = decision.dynamic_program_execution_receipt;
  if (dynamicReceipt) {
    if (dynamicReceipt.status === "completed") {
      state.blocked_reason = null;
      if (dynamicReceipt.apply_requested) {
        state.apply_attempts = 1;
        state.apply_succeeded = true;
        state.verified = true;
        state.verification_mode = "trusted_dynamic_program_receipt";
        state.verification_action_id = "dynamic_program";
        state.verification_evidence_sha256 = `sha256:${sha256(JSON.stringify(stableValue(dynamicReceipt)))}`;
        state.contract.stage = "report";
      } else {
        state.contract.stage = "preview";
      }
    } else {
      state.blocked_reason = dynamicReceipt.failure || `dynamic_program_${dynamicReceipt.status}`;
      state.contract.stage = "blocked";
    }
    return { ...decision, actions: [], teammate_loop_receipt: receipt(state) };
  }
  const actions: ActionCall[] = [];
  const blocked: string[] = [];
  for (const action of Array.isArray(decision.actions) ? decision.actions : []) {
    const call = classifyPathCall(action.method, action.path, action.body);
    const reason = gateCall(state, call);
    if (reason) blocked.push(`${action.action_id}:${reason}`);
    else {
      registerPending(state, action.action_id, call);
      actions.push(action);
    }
  }
  if (blocked.length) {
    state.blocked_reason = blocked[0].split(":").slice(1).join(":");
    state.contract.stage = "blocked";
  } else if (state.apply_succeeded && !state.verified && actions.length === 0) {
    state.blocked_reason = "post_apply_verification_required";
    state.contract.stage = "blocked";
  } else if (actions.length === 0
      && state.contract.preview_required
      && state.successful_preview_signatures.size === 0
      && assistantClaimsExecutedPreview(decision.assistant_message || "")
      && !assistantReportsNoPreviewCandidate(decision.assistant_message || "")) {
    state.blocked_reason = "executable_preview_not_completed";
    state.contract.stage = "blocked";
  } else if (actions.length === 0 && !state.blocked_reason) {
    const completedSafePreview = state.apply_attempts === 0 && state.preview_receipts.length > 0;
    state.contract.stage = state.verified || state.contract.turn_kind !== "mutation" || completedSafePreview
      ? "report"
      : state.contract.stage;
  }
  const suffix = state.blocked_reason
    ? `\n\nI stopped before an unsafe or unverified Revit step (${state.blocked_reason.replace(/_/g, " ")}). No blocked action was executed.`
    : "";
  return { ...decision, assistant_message: `${decision.assistant_message || ""}${suffix}`.trim(), actions, teammate_loop_receipt: receipt(state) };
}

export function beginTeammateLoopOwner(owner: object, req: ChatRequest): TeammateLoopOwnerLease {
  const state = stateFor(req);
  ingestToolResults(state, req.tool_results);
  const lease = { owner, state, turn_id: null };
  const registry = statesByOwner.get(owner) ?? { unbound: new Set<TeammateLoopOwnerLease>(), by_turn: new Map<string, TeammateLoopOwnerLease>() };
  registry.unbound.add(lease);
  statesByOwner.set(owner, registry);
  return lease;
}

export function bindTeammateLoopOwnerTurn(lease: TeammateLoopOwnerLease, turnIdValue: unknown): void {
  const turnId = boundedString(turnIdValue, 300);
  if (!turnId) throw new Error("A teammate-loop owner lease requires a bounded Codex turn id.");
  const registry = statesByOwner.get(lease.owner);
  if (!registry || !registry.unbound.has(lease)) throw new Error("The teammate-loop owner lease is not active.");
  const existing = registry.by_turn.get(turnId);
  if (existing && existing !== lease) throw new Error(`Codex turn ${turnId} already has a teammate-loop owner lease.`);
  registry.unbound.delete(lease);
  lease.turn_id = turnId;
  registry.by_turn.set(turnId, lease);
}

export function endTeammateLoopOwner(lease: TeammateLoopOwnerLease | null | undefined): void {
  if (!lease) return;
  const registry = statesByOwner.get(lease.owner);
  if (!registry) return;
  registry.unbound.delete(lease);
  if (lease.turn_id && registry.by_turn.get(lease.turn_id) === lease) registry.by_turn.delete(lease.turn_id);
  if (registry.unbound.size === 0 && registry.by_turn.size === 0) statesByOwner.delete(lease.owner);
}

function ownerState(owner: object, turnIdValue: unknown): TeammateLoopState | undefined {
  const registry = statesByOwner.get(owner);
  if (!registry) return undefined;
  const turnId = boundedString(turnIdValue, 300);
  if (turnId) {
    const bound = registry.by_turn.get(turnId);
    if (bound) return bound.state;
    if (registry.unbound.size === 1) return [...registry.unbound][0].state;
    return undefined;
  }
  const leases = [...registry.unbound, ...registry.by_turn.values()];
  return leases.length === 1 ? leases[0].state : undefined;
}

export function teammateLoopSessionIdForOwner(owner: object, turnIdValue: unknown): string | null {
  const state = ownerState(owner, turnIdValue);
  if (!state) return null;
  const separator = state.key.lastIndexOf("::");
  return separator >= 0 ? state.key.slice(0, separator) : null;
}

export function guardTeammateMcpCall(owner: object, params: { tool?: unknown; arguments?: unknown; turnId?: unknown }): TeammateMcpGate {
  const state = ownerState(owner, params.turnId);
  if (!state) return { allowed: false, message: "[teammate_loop_missing] No active host teammate-loop contract exists for this Revit call." };
  const call = classifyDocumentedMcpCall(state, params.tool, params.arguments);
  const reason = gateCall(state, call);
  if (reason) {
    state.blocked_reason = reason;
    state.contract.stage = "blocked";
    return { allowed: false, message: `[teammate_loop_blocked] ${reason.replace(/_/g, " ")}.`, call, state };
  }
  const actionId = `mcp:${state.pending.size + state.preview_action_ids.length + state.apply_attempts + state.verification_action_ids.length + 1}`;
  registerPending(state, actionId, call);
  return { allowed: true, call: { ...call, path: `${actionId}|${call.path}` }, state };
}

function mcpResultSucceeded(result: unknown): boolean {
  const root = objectValue(result);
  if (root.isError === true) return false;
  const content = Array.isArray(root.content) ? root.content : [];
  for (const item of content) {
    const text = boundedString(objectValue(item).text, 2_000_000);
    if (!text || (!text.startsWith("{") && !text.startsWith("["))) continue;
    try {
      const parsed = objectValue(JSON.parse(text));
      if (parsed.ok === false || parsed.success === false) return false;
    } catch {}
  }
  return true;
}

function recoveredLiveContextIdentity(result: unknown): { state: TeammateContextState; signature: string | null } | null {
  const root = objectValue(result);
  const content = Array.isArray(root.content) ? root.content : [];
  for (const item of content) {
    const text = boundedString(objectValue(item).text, 2_000_000);
    if (!text || !text.startsWith("{")) continue;
    try {
      const context = objectValue(JSON.parse(text));
      const identity = contextIdentity({ revit: { ...context, source: { live: true } } }, "inspection");
      if (identity.state === "live" && identity.signature) return identity;
    } catch {}
  }
  return null;
}

export function recordTeammateMcpResult(owner: object, gate: TeammateMcpGate, result: unknown): void {
  const state = gate.state;
  if (!state || !gate.allowed || !gate.call) return;
  const [actionId] = gate.call.path.split("|", 1);
  const succeeded = mcpResultSucceeded(result);
  const separator = gate.call.path.indexOf("|");
  const observedPath = separator >= 0 ? gate.call.path.slice(separator + 1) : gate.call.path;
  if (succeeded && observedPath === "revit_tool_doc") {
    const documented = documentedToolRouteFromResult(result);
    if (documented) state.documented_tool_routes.set(documented.alias, documented.route);
  }
  if (succeeded && (observedPath === "revit_get_context" || observedPath === "/revit/context")) {
    const identity = recoveredLiveContextIdentity(result);
    if (identity) {
      state.contract.context_state = "live";
      state.contract.document_signature = identity.signature;
      if (state.blocked_reason === "live_revit_context_required" || state.blocked_reason === "document_identity_changed_or_unavailable") {
        state.blocked_reason = null;
      }
      if (state.contract.stage === "blocked") state.contract.stage = "ground";
    }
  }
  recordResult(state, actionId, succeeded, result);
}

export function teammateLoopReceiptForOwner(owner: object): NonNullable<ChatResponse["teammate_loop_receipt"]> | undefined {
  const state = ownerState(owner, undefined);
  return state ? receipt(state) : undefined;
}

export function teammateLoopReceiptForLease(lease: TeammateLoopOwnerLease | null | undefined): NonNullable<ChatResponse["teammate_loop_receipt"]> | undefined {
  return lease ? receipt(lease.state) : undefined;
}

export function __testOnlyResetTeammateLoopState(): void {
  statesByTurn.clear();
}
