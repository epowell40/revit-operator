import {
  OPERATOR_BACKEND_CONTRACT_VERSION,
  type ActionCall,
  type ChatRequest,
  type ChatResponse,
  type ToolResult
} from "../contracts.js";

const REDLINE_CONTEXT_RE = /\b(redline|mark[\s-]*up|marked|pick\s*up|pickup|attachment|attached|pdf)\b/i;
const MODEL_OBJECT_RE =
  /\b(duct|ductwork|supply\s+air|return\s+air|exhaust\s+air|pipe|piping|conduit|fixture|receptacle|outlet|device|equipment|terminal|diffuser|grille|wall|door|window)\b/i;
const DUCT_LABEL_RE = /\b\d{1,3}\s*(?:["']?\s*)?[x×]\s*\d{1,3}\b[\s\S]{0,80}\b(supply|return|exhaust|duct|sound\s+lined|lined)\b/i;
const ANNOTATION_ONLY_RE =
  /\b(annotation\s*only|text\s*only|coordination\s*note\s*only|not\s+a\s+model\s+element|do\s+not\s+(?:model|modify\s+the\s+model|create\s+(?:a\s+)?duct|write\s+model)|no\s+model\s+change)\b/i;
const TEXT_ANNOTATION_RE = /\b(text\s*note|detail\s*annotation|annotation|coordination\s*note|red\s+text)\b/i;
const COMPLETION_RE = /\b(done|complete|completed|created|modified|updated|placed|added|picked\s+up|implemented)\b/i;
const BLOCKER_RE = /\b(cannot|can't|could\s+not|was\s+not\s+able|blocked|failed|no\s+model\s+change|did\s+not\s+make|not\s+created|not\s+modified|requires\s+confirmation)\b/i;
const ANNOTATION_DISCLOSURE_RE = /\b(annotation\s*only|text\s*note|not\s+a\s+model\s+element|no\s+duct\s+element|no\s+model\s+change|not\s+a\s+modeled)\b/i;

const TEXT_ONLY_PATHS = new Set([
  "/revit/create-text",
  "/revit/set-text-note-text",
  "/revit/replace-text-note",
  "/revit/draw-detail-curves",
  "/revit/create-revision-cloud"
]);

const MODEL_WRITE_PATHS = new Set([
  "/revit/create-duct",
  "/revit/create-pipe",
  "/revit/create-mep-route",
  "/revit/mep-route-workflow",
  "/revit/connect-mep-branch",
  "/revit/connect-mep-elements",
  "/revit/existing-conditions-mep-draft-workflow",
  "/revit/copy-mep-pattern",
  "/revit/edit-mep-route-elements",
  "/revit/resize-duct-run",
  "/revit/resize-ducts-by-scope",
  "/revit/resize-ducts-in-room",
  "/revit/resize-ductwork-by-scope",
  "/revit/repair-duct-continuity-by-scope",
  "/revit/sync-connected-sizes",
  "/revit/create-family-instance",
  "/revit/place-family-instance-on-host",
  "/revit/create-similar-from-instance",
  "/revit/move-elements",
  "/revit/rotate-elements",
  "/revit/set-parameter",
  "/revit/update-parameter-by-query",
  "/revit/change-element-type",
  "/revit/duplicate-type-and-swap-instance",
  "/revit/set-type-parameters",
  "/revit/delete"
]);

const MODEL_RESULT_ID_KEYS = new Set([
  "createdElementIds",
  "created_element_ids",
  "createdDuctIds",
  "createdPipeIds",
  "createdFittingIds",
  "modifiedElementIds",
  "updatedElementIds",
  "changedElementIds",
  "elementIds"
]);

function normalizePath(pathName: string | undefined): string {
  return (pathName ?? "").trim().toLowerCase();
}

function hasActionPath(actions: ActionCall[], paths: Set<string>): boolean {
  return actions.some(action => paths.has(normalizePath(action.path)));
}

function collectRequestText(req: ChatRequest): string {
  const parts: string[] = [];
  if (typeof req.user_text === "string") parts.push(req.user_text);
  for (const attachment of Array.isArray(req.user_attachments) ? req.user_attachments : []) {
    for (const value of [attachment.filename, attachment.relative_path, attachment.external_path, attachment.mime]) {
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join("\n");
}

function requestHasModeledRedlineIntent(req: ChatRequest): boolean {
  const text = collectRequestText(req);
  if (!REDLINE_CONTEXT_RE.test(text)) return false;
  return MODEL_OBJECT_RE.test(text) || DUCT_LABEL_RE.test(text);
}

function requestExplicitlyAnnotationOnly(req: ChatRequest): boolean {
  const text = collectRequestText(req);
  return TEXT_ANNOTATION_RE.test(text) && ANNOTATION_ONLY_RE.test(text);
}

function messageClaimsCompletion(message: string): boolean {
  return COMPLETION_RE.test(message) && !BLOCKER_RE.test(message);
}

function messageDisclosesAnnotationOnly(message: string): boolean {
  return ANNOTATION_DISCLOSURE_RE.test(message);
}

function hasNonEmptyIdArray(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => {
    if (typeof item === "number") return Number.isFinite(item) && item > 0;
    return typeof item === "string" && item.trim().length > 0;
  });
}

function resultHasModelElementIds(node: unknown, depth = 0): boolean {
  if (!node || depth > 8) return false;
  if (Array.isArray(node)) return node.some(item => resultHasModelElementIds(item, depth + 1));
  if (typeof node !== "object") return false;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (MODEL_RESULT_ID_KEYS.has(key) && hasNonEmptyIdArray(value)) return true;
    if (resultHasModelElementIds(value, depth + 1)) return true;
  }
  return false;
}

function hasNonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeGateStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function gateEntriesAllPass(value: unknown): boolean {
  if (!Array.isArray(value)) return true;
  return value.every(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    return normalizeGateStatus((entry as Record<string, unknown>).status) === "pass";
  });
}

function gateHasAfterCaptureEvidence(obj: Record<string, unknown>): boolean {
  const evidence = obj.evidence && typeof obj.evidence === "object" && !Array.isArray(obj.evidence)
    ? obj.evidence as Record<string, unknown>
    : {};
  return hasNonEmptyText(obj.after_capture_path) ||
    hasNonEmptyText(obj.afterCapturePath) ||
    hasNonEmptyText(evidence.after_capture_path) ||
    hasNonEmptyText(evidence.afterCapturePath);
}

function gatePayloadIsCleanPass(obj: Record<string, unknown>): boolean {
  if (normalizeGateStatus(obj.status) !== "pass") return false;
  if (!gateHasAfterCaptureEvidence(obj)) return false;
  if (!gateEntriesAllPass(obj.assertions)) return false;
  if (!gateEntriesAllPass(obj.landmark_relationships ?? obj.landmarkRelationships)) return false;
  const vision = obj.vision_review ?? obj.visionReview;
  if (vision && typeof vision === "object" && !Array.isArray(vision)) {
    const provider = normalizeGateStatus((vision as Record<string, unknown>).provider);
    const status = normalizeGateStatus((vision as Record<string, unknown>).status);
    if (provider && provider !== "none" && status !== "pass") return false;
  }
  return true;
}

function resultHasPassingVisualGate(node: unknown, depth = 0): boolean {
  if (!node || depth > 8) return false;
  if (Array.isArray(node)) return node.some(item => resultHasPassingVisualGate(item, depth + 1));
  if (typeof node !== "object") return false;

  const obj = node as Record<string, unknown>;
  const status = typeof obj.status === "string" ? obj.status.trim().toLowerCase() : "";
  const ok = typeof obj.ok === "boolean" ? obj.ok : null;
  const actionType = typeof obj.action_type === "string"
    ? obj.action_type
    : typeof obj.actionType === "string"
      ? obj.actionType
      : "";
  const authority = typeof obj.authority === "string" ? obj.authority : "";
  const looksLikeGate = !!actionType || !!authority || Array.isArray(obj.assertions) || Array.isArray(obj.landmark_relationships) || Array.isArray(obj.landmarkRelationships);
  if (status === "pass" && (looksLikeGate || obj.confidence !== undefined)) return gatePayloadIsCleanPass(obj);
  if (ok === true && resultHasPassingVisualGate(obj.gate, depth + 1)) return true;

  for (const [key, value] of Object.entries(obj)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === "visual_gate" ||
      normalizedKey === "visualgate" ||
      normalizedKey === "redline_visual_gate" ||
      normalizedKey === "redlinevisualgate" ||
      normalizedKey === "gate" ||
      normalizedKey === "verification"
    ) {
      if (resultHasPassingVisualGate(value, depth + 1)) return true;
    }
  }
  return false;
}

function toolResultIsSuccessfulModelWrite(result: ToolResult): boolean {
  if (result.status !== "done" || result.method !== "POST") return false;
  const pathName = normalizePath(result.path);
  if (!MODEL_WRITE_PATHS.has(pathName)) return false;
  return resultHasModelElementIds(result.result_json);
}

function hasModelWriteEvidence(req: ChatRequest): boolean {
  const results = Array.isArray(req.tool_results) ? req.tool_results : [];
  return results.some(toolResultIsSuccessfulModelWrite);
}

function hasPassingVisualGateEvidence(req: ChatRequest): boolean {
  const results = Array.isArray(req.tool_results) ? req.tool_results : [];
  return results.some(result => result.status === "done" && resultHasPassingVisualGate(result.result_json));
}

function buildBlockedModeledRedlineResponse(): ChatResponse {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      "I stopped this redline pickup because the request contains modeled MEP/ductwork language. " +
      "A text note or detail annotation is not valid completion for a modeled duct change. " +
      "The workflow must create or modify an HVAC model element first, then report the element id, category, size, level/system context, and verification result. " +
      "If the available tools cannot safely create or modify the duct, the correct result is a clear blocker rather than an annotation-only completion.",
    actions: []
  };
}

function buildBlockedUnverifiedRedlineResponse(): ChatResponse {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      "I stopped this redline pickup before completion because the model write evidence does not include a passing visual verification gate. " +
      "For redline pickup, created or modified element IDs are necessary but not sufficient: the workflow must also compare the redline, before/after view evidence, intended action, and observed element location, then return a `pass` gate. " +
      "If the gate is `fail`, `uncertain`, or missing, the correct result is to continue verification or report the blocker rather than claim completion.",
    actions: []
  };
}

function appendAnnotationOnlyDisclosure(decision: ChatResponse): ChatResponse {
  const message = (decision.assistant_message ?? "").trim();
  if (messageDisclosesAnnotationOnly(message)) return decision;
  const disclosure =
    "This is annotation-only work; it does not satisfy a modeled ductwork pickup unless a Ducts-category model element is created or modified and verified.";
  return {
    ...decision,
    assistant_message: message.length > 0 ? `${message}\n\n${disclosure}` : disclosure
  };
}

export function enforceModeledRedlineGuard(req: ChatRequest, decision: ChatResponse): ChatResponse {
  if (!requestHasModeledRedlineIntent(req)) return decision;

  const actions = Array.isArray(decision.actions) ? decision.actions : [];
  const hasTextOnlyAction = hasActionPath(actions, TEXT_ONLY_PATHS);
  const hasModelWriteAction = hasActionPath(actions, MODEL_WRITE_PATHS);
  const annotationOnly = requestExplicitlyAnnotationOnly(req);

  if (hasTextOnlyAction && !hasModelWriteAction) {
    return annotationOnly ? appendAnnotationOnlyDisclosure(decision) : buildBlockedModeledRedlineResponse();
  }

  const message = (decision.assistant_message ?? "").toString();
  const hasWriteEvidence = hasModelWriteEvidence(req);
  if (!hasModelWriteAction && !hasWriteEvidence && messageClaimsCompletion(message)) {
    return annotationOnly || messageDisclosesAnnotationOnly(message)
      ? appendAnnotationOnlyDisclosure(decision)
      : buildBlockedModeledRedlineResponse();
  }
  if (!hasModelWriteAction && hasWriteEvidence && !hasPassingVisualGateEvidence(req) && messageClaimsCompletion(message)) {
    return buildBlockedUnverifiedRedlineResponse();
  }

  return decision;
}
