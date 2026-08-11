import { createHash } from "node:crypto";
import { conditionalActionPathEffect, pathLooksWrite } from "./action_path_mutability.js";
import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "./contracts.js";

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
  max_apply_attempts: 1;
  verification_required: boolean;
  user_text_sha256: string;
  document_signature: string | null;
};

type Effect = "read" | "navigation" | "discovery" | "preview" | "apply" | "unknown";
type PendingCall = { effect: Effect; signature: string; path: string; target_tokens: string[]; expected_values: string[]; operation: string };

type TeammateLoopState = {
  key: string;
  contract: TeammateTurnContract;
  expires_at_ms: number;
  successful_preview_signatures: Set<string>;
  pending: Map<string, PendingCall>;
  preview_action_ids: string[];
  apply_action_id: string | null;
  verification_action_ids: string[];
  apply_attempts: number;
  apply_succeeded: boolean;
  apply_target_tokens: Set<string>;
  apply_expected_values: Set<string>;
  apply_operation: string;
  verified: boolean;
  tool_doc_calls: number;
  blocked_reason: string | null;
};

export type TeammateLoopOwnerLease = { owner: object; state: TeammateLoopState; turn_id: string | null };
export type TeammateMcpGate = { allowed: boolean; message?: string; call?: PendingCall; state?: TeammateLoopState };

const statesByTurn = new Map<string, TeammateLoopState>();
const statesByOwner = new WeakMap<object, { unbound: Set<TeammateLoopOwnerLease>; by_turn: Map<string, TeammateLoopOwnerLease> }>();
const MAX_STATE_AGE_MS = 5 * 60_000;
const NAVIGATION_PATHS = new Set(["/revit/activate-view"]);
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

export function classifyAgentTurn(userText: string | null | undefined): AgentTurnKind {
  const text = `${userText || ""}`.replace(/\s+/g, " ").trim().toLowerCase();
  if (!text) return "conversation";
  const previewOnly =
    /\b(?:before|without)\b[^.!?\n]{0,100}\b(?:delet|remov|chang|modif|edit|apply|writ)/.test(text) ||
    /\b(?:do not|don't)\b[^.!?\n]{0,60}\b(?:change|modify|edit|delete|remove|apply|write)/.test(text);
  if (previewOnly) return "inspection";
  if (isConceptualQuestion(text) && !/\b(?:then|and)\s+(?:add|fix|change|modify|edit|create|delete|remove|move|place|set|update|replace)\b/.test(text)) return "conversation";
  const explicitMutation = /\b(?:add|fix|change|modify|edit|create|delete|remove|move|place|rename|set|update|resize|route|connect|disconnect|replace|sync|print|export)\b/.test(text);
  if (explicitMutation) return "mutation";
  if (!/^\s*(?:why|what|how|is|are|does|do|can you tell|could you tell)\b/.test(text) &&
      /\b(?:wrong|incorrect|needs? to be|should be|too (?:large|small|high|low|big))\b/.test(text)) return "mutation";
  if (/\b(?:open|show|activate|take me to|go to|zoom to|select|highlight)\b/.test(text)) return "navigation";
  if (/\b(?:ping|probe|status|find|locate|where|which|how many|count|list|inspect|check|verify|identify|current|active|selected)\b/.test(text)) return "inspection";
  return "conversation";
}

function hasNoWriteAuthority(text: string): boolean {
  return /\b(?:preview|read[ -]?only|analysis)\s+only\b/i.test(text) ||
    /\b(?:just|only)\s+(?:show|inspect|preview|check|tell|list|find)\b/i.test(text) ||
    /\b(?:before|without)\b[^.!?\n]{0,100}\b(?:delet|remov|chang|modif|edit|apply|writ)/i.test(text) ||
    /\b(?:do not|don't|dont|no)\b[^.!?\n]{0,60}\b(?:change|modify|edit|delete|remove|apply|write)/i.test(text);
}

function writeAuthorized(text: string, kind: AgentTurnKind, noWrite: boolean): boolean {
  if (kind !== "mutation" || noWrite || isConceptualQuestion(text)) return false;
  if (/\b(?:should|can|could|would)\s+(?:i|we)\b/i.test(text)) return false;
  if (/^(?:please\s+)?(?:add|fix|change|modify|edit|create|delete|remove|move|place|rename|set|update|resize|route|connect|disconnect|replace|sync|print|export)\b/i.test(text)) return true;
  if (/(?:^|[,;:]\s+|[.!?]\s+)(?:please\s+)?(?:add|fix|change|modify|edit|create|delete|remove|move|place|rename|set|update|resize|route|connect|disconnect|replace|sync|print|export)\b/i.test(text)) return true;
  if (/\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:add|fix|change|modify|edit|create|delete|remove|move|place|rename|set|update|resize|route|connect|disconnect|replace|sync|print|export)\b/i.test(text)) return true;
  if (/\b(?:i\s+(?:want|need)\s+you\s+to|please)\s+(?:add|fix|change|modify|edit|create|delete|remove|move|place|rename|set|update|resize|route|connect|disconnect|replace|sync|print|export)\b/i.test(text)) return true;
  return /\b(?:wrong|incorrect|needs? to be|should be|too (?:large|small|high|low|big))\b/i.test(text);
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
  const stage: TeammateLoopStage = ambiguity === "material"
    ? "clarify"
    : identity.state === "missing" || identity.state === "invalid"
      ? "ground"
      : turnKind === "conversation" ? "answer" : turnKind === "mutation" ? "preview" : "discover";
  return {
    schema: "revit-operator.teammate-loop.v1",
    turn_kind: turnKind,
    intent_summary: text.slice(0, 260),
    ambiguity,
    context_state: identity.state,
    stage,
    no_write: noWrite,
    write_authorized: authorized,
    preview_required: turnKind === "mutation",
    max_apply_attempts: 1,
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
      : contract.turn_kind === "mutation"
        ? "Use live context; discover one exact contract if needed; preview the same target; apply once only; verify by readback/capture before success."
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
  return sha256(JSON.stringify({ path: normalizedPath, body: stableValue(envelope) }));
}

function targetTokens(value: unknown): string[] {
  const tokens = new Set<string>();
  const visit = (node: unknown, key = "", depth = 0): void => {
    if (depth > 8 || tokens.size >= 64) return;
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
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
    if (normalizedKey === "ids") tokens.add(`id:${scalar}`);
    if (/(?:element|schedule|view|sheet|room|space|type|family|target|source|host|main).*ids?$/.test(normalizedKey)) tokens.add(`${normalizedKey.replace(/s$/, "")}:${scalar}`);
    if (/(?:parameter|field).*names?$/.test(normalizedKey) || normalizedKey === "parameter" || normalizedKey === "field") tokens.add(`parameter:${scalar}`);
    if (normalizedKey === "mark") tokens.add(`mark:${scalar}`);
  };
  visit(value);
  return [...tokens].sort();
}

function expectedValues(value: unknown): string[] {
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
    if (normalizedParent === "parameters" || ["value", "newvalue", "replaceto", "targetvalue"].includes(normalizedKey)) {
      values.add(JSON.stringify(node));
    }
  };
  visit(value);
  return [...values].sort();
}

function operationFor(path: string, body: unknown): string {
  const normalizedPath = path.toLowerCase();
  const serialized = JSON.stringify(body ?? null).toLowerCase();
  if (normalizedPath.includes("delete") || /"kind":"delete"/.test(serialized)) return "delete";
  if (normalizedPath.includes("parameter") || /"kind":"setparameters"/.test(serialized) || /"parameters"/.test(serialized)) return "set_parameters";
  if (normalizedPath.includes("type")) return "change_type";
  if (normalizedPath.includes("move") || normalizedPath.includes("route")) return "geometry";
  return "mutation";
}

function previewFlags(value: unknown): { preview: boolean; apply: boolean } {
  const body = objectValue(value);
  const preview = body.dryRun === true || body.dry_run === true || body.preview === true || body.apply === false;
  const apply = body.apply === true || body.dryRun === false || body.dry_run === false || body.commit === true || body.execute === true;
  return { preview: preview && !apply, apply: apply && !preview };
}

function classifyPathCall(method: unknown, pathValue: unknown, body: unknown): PendingCall {
  const methodName = `${method || ""}`.trim().toUpperCase();
  const path = `${pathValue || ""}`.trim().toLowerCase();
  const signature = actionSignature(path, body);
  const target_tokens = targetTokens(body);
  const expected_values = expectedValues(body);
  const operation = operationFor(path, body);
  const call = (effect: Effect): PendingCall => ({ effect, signature, path, target_tokens, expected_values, operation });
  if (NAVIGATION_PATHS.has(path)) return call("navigation");
  if (DISCOVERY_PATHS.has(path)) return call("discovery");
  if (methodName === "GET") return call("read");
  if (methodName === "POST" && path === "/revit/transaction-plan") return call("preview");
  if (methodName === "POST" && !path.startsWith("/revit/")) return call("unknown");
  const conditionalEffect = methodName === "POST" ? conditionalActionPathEffect(path, body) : undefined;
  if (conditionalEffect !== undefined) return call(conditionalEffect);
  if (methodName === "POST" && !pathLooksWrite(path, body)) return call("read");
  if (methodName !== "POST" || !path.startsWith("/revit/")) return call("unknown");
  const flags = previewFlags(body);
  return call(flags.preview ? "preview" : "apply");
}

function classifyMcpCall(toolValue: unknown, argsValue: unknown): PendingCall {
  const tool = `${toolValue || ""}`.trim();
  const args = objectValue(argsValue);
  if (tool === "revit_call_tool") return classifyPathCall(args.method, args.path, args.body);
  const target_tokens = targetTokens(args);
  const expected_values = expectedValues(args);
  const operation = operationFor(tool, args);
  const call = (effect: Effect, signaturePath = tool): PendingCall => ({ effect, signature: actionSignature(signaturePath, args), path: tool, target_tokens, expected_values, operation });
  if (DISCOVERY_TOOLS.has(tool)) return call("discovery");
  if (/^revit_(?:ping|get_|list_|query_|find_|search_|tool_|write_grant_status|resolve_|trace_|measure_|analyze_|audit_|quantify_|capture_|export_|native_api_(?:policy|catalog|search)|transaction_validate)/.test(tool)) {
    return call("read");
  }
  if (/^revit_(?:activate_|highlight_)/.test(tool)) return call("navigation");
  if (tool === "revit_transaction_plan") return call("preview", "revit_transaction");
  if (tool === "revit_transaction_apply") return call("apply", "revit_transaction");
  const flags = previewFlags(args);
  if (flags.preview || (DEFAULT_PREVIEW_TOOLS.has(tool) && !flags.apply)) return call("preview");
  if (/^revit_(?:set_|update_|replace_|delete_|move_|rotate_|create_|place_|route_|connect_|disconnect_|transaction_apply)/.test(tool) || flags.apply) {
    return call("apply");
  }
  return call("unknown");
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
    apply_action_id: null,
    verification_action_ids: [],
    apply_attempts: 0,
    apply_succeeded: false,
    apply_target_tokens: new Set(),
    apply_expected_values: new Set(),
    apply_operation: "",
    verified: false,
    tool_doc_calls: 0,
    blocked_reason: null
  };
  statesByTurn.set(key, state);
  return state;
}

function gateCall(state: TeammateLoopState, call: PendingCall): string | null {
  const contract = state.contract;
  if (contract.ambiguity === "material") return "material_ambiguity_requires_clarification";
  if (call.effect === "unknown") return "unknown_revit_contract_requires_one_tool_doc_lookup";
  if (contract.turn_kind === "conversation") return "conceptual_turn_does_not_require_revit";
  if (call.effect !== "discovery" && contract.context_state !== "live") return "live_revit_context_required";
  if (call.effect === "apply") {
    if (contract.turn_kind !== "mutation") return "turn_does_not_authorize_model_mutation";
    if (contract.no_write) return "user_no_write_limit";
    if (!contract.write_authorized) return "explicit_write_authority_required";
    if (state.apply_attempts >= 1) return "single_apply_attempt_already_consumed";
    if (!state.successful_preview_signatures.has(call.signature)) return "matching_successful_preview_required";
  }
  if (call.effect === "preview" && state.apply_attempts > 0) return "preview_after_apply_not_allowed";
  return null;
}

function registerPending(state: TeammateLoopState, actionId: string, call: PendingCall): void {
  if (state.blocked_reason !== "apply_failed_or_outcome_unknown_no_retry") state.blocked_reason = null;
  state.pending.set(actionId, call);
  if (call.effect === "discovery" && /(?:tool-doc|revit_tool_doc)$/.test(call.path)) state.tool_doc_calls += 1;
  if (call.effect === "preview") state.preview_action_ids.push(actionId);
  if (call.effect === "apply") {
    state.apply_attempts += 1;
    state.apply_action_id = actionId;
    state.apply_target_tokens = new Set(call.target_tokens);
    state.apply_expected_values = new Set(call.expected_values);
    state.apply_operation = call.operation;
    state.contract.stage = "apply";
  } else if (state.apply_attempts > 0 && (call.effect === "read" || call.effect === "navigation")) {
    state.verification_action_ids.push(actionId);
    state.contract.stage = "verify";
  } else if (call.effect === "preview") state.contract.stage = "preview";
  else if (call.effect === "read" || call.effect === "navigation" || call.effect === "discovery") state.contract.stage = "discover";
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

function verificationMatches(state: TeammateLoopState, evidence: unknown, requireExplicit: boolean): boolean {
  if (requireExplicit && !explicitVerification(evidence)) return false;
  const observed = evidenceValues(evidence);
  if (state.apply_expected_values.size > 0) return [...state.apply_expected_values].every(value => observed.has(value));
  return explicitVerification(evidence);
}

function recordResult(state: TeammateLoopState, actionId: string, succeeded: boolean, evidence?: unknown): void {
  const pending = state.pending.get(actionId);
  if (!pending) return;
  state.pending.delete(actionId);
  if (pending.effect === "preview" && succeeded) state.successful_preview_signatures.add(pending.signature);
  if (pending.effect === "apply") {
    state.apply_succeeded = succeeded;
    if (!succeeded) {
      state.blocked_reason = "apply_failed_or_outcome_unknown_no_retry";
      state.contract.stage = "blocked";
    } else if (verificationMatches(state, evidence, true)) {
      state.verified = true;
      state.contract.stage = "report";
    } else state.contract.stage = "verify";
  }
  const applyIdentityTokens = [...state.apply_target_tokens].filter(token => !token.startsWith("parameter:"));
  const verificationIdentityTokens = [...new Set([...pending.target_tokens, ...targetTokens(evidence)])]
    .filter(token => !token.startsWith("parameter:"));
  const targetBound = applyIdentityTokens.length > 0
    ? verificationIdentityTokens.some(token => state.apply_target_tokens.has(token))
    : pending.target_tokens.some(token => state.apply_target_tokens.has(token));
  if (state.apply_succeeded && succeeded && targetBound && pending.effect === "read" && verificationMatches(state, evidence, false)) {
    state.verified = true;
    state.contract.stage = "report";
  }
}

function ingestToolResults(state: TeammateLoopState, results: ToolResult[] | undefined): void {
  for (const result of results || []) recordResult(state, result.action_id, resultSucceeded(result), result.result_json);
}

function receipt(state: TeammateLoopState): NonNullable<ChatResponse["teammate_loop_receipt"]> {
  return {
    schema: "revit-operator.teammate-loop-receipt.v1",
    turn_kind: state.contract.turn_kind,
    context_state: state.contract.context_state,
    stage: state.contract.stage,
    preview_action_ids: state.preview_action_ids.slice(-8),
    apply_action_id: state.apply_action_id,
    verification_action_ids: state.verification_action_ids.slice(-8),
    apply_attempts: state.apply_attempts,
    verified: state.verified,
    blocked_reason: state.blocked_reason
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
  } else if (actions.length === 0 && !state.blocked_reason) {
    state.contract.stage = state.verified || state.contract.turn_kind !== "mutation" ? "report" : state.contract.stage;
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
  const call = classifyMcpCall(params.tool, params.arguments);
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

export function recordTeammateMcpResult(owner: object, gate: TeammateMcpGate, result: unknown): void {
  const state = gate.state;
  if (!state || !gate.allowed || !gate.call) return;
  const [actionId] = gate.call.path.split("|", 1);
  recordResult(state, actionId, mcpResultSucceeded(result), result);
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
