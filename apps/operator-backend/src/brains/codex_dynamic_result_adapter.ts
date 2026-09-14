import { compactParameterReadResultForPrompt } from "../tool_result_compaction.js";
import type { EvidenceProjectionV1 } from "../evidence/evidence_ref.js";
import { modelEvidenceEnvelope } from "../evidence/model_context_budget.js";
import { projectAssignmentStatusForModel } from "./assignment_status_projection.js";

/** Code mode joins text blocks with newlines. Keep a retrieved JSON selection
 * and its host observation metadata in one parseable object. Never change the
 * selection itself or turn a plain error / image response into a success. */
export function attachDynamicObservationContext(
  response: ReturnType<typeof adaptMcpToolCallResultToDynamicResponse>,
  tool: unknown,
  observationContext: string | null
): void {
  if (!observationContext) return;
  if (tool === "operator_retrieve_evidence" && response.success && response.contentItems.length === 1) {
    const item = response.contentItems[0]!;
    if (item.type === "inputText") {
      try {
        const payload = JSON.parse(item.text);
        const index = JSON.parse(observationContext);
        if (payload?.ok === true && payload?.result?.schema === "revit-operator.evidence-retrieval.v1"
          && index?.schema === "revit-operator.model-observation-index/v2") {
          item.text = JSON.stringify({ ...payload, model_observation_index: index });
          return;
        }
      } catch { /* Preserve the original correction contract below. */ }
    }
  }
  response.contentItems.push({ type: "inputText", text: observationContext });
}

function parseToolArguments(value: unknown): any {
  if (typeof value !== "string") return value && typeof value === "object" ? value : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function compactDynamicMcpTextForCodex(tool: unknown, rawArguments: unknown, text: string): string {
  if (tool === "operator_evaluate_assignment_criteria" || tool === "operator_request_assignment_input") {
    try {
      const projected = projectAssignmentStatusForModel(JSON.parse(text));
      return projected ? JSON.stringify(projected) : text;
    } catch { return text; }
  }
  if (typeof tool !== "string" || tool.trim() !== "revit_call_tool") return text;
  const args = parseToolArguments(rawArguments);
  const path = typeof args.path === "string" ? args.path.trim().toLowerCase() : "";
  if (path !== "/revit/get-parameters") return text;
  try {
    const parsed = JSON.parse(text);
    // A schema/transport rejection is a correction contract, not a parameter
    // result. The success-only compactor otherwise erases its error and issues.
    if (parsed?.error || parsed?.isError === true || parsed?.ok === false || parsed?.success === false) return text;
    const body = parseToolArguments(args.body);
    const requestedNames = Array.isArray(body.names)
      ? body.names.filter((name: unknown): name is string => typeof name === "string" && Boolean(name.trim()))
      : [];
    const requestedElementCount = Array.isArray(body.elementIds) ? body.elementIds.length : 0;
    const maxEvidence = requestedNames.length > 0 && requestedElementCount > 0
      ? Math.max(16, Math.min(100, requestedNames.length * requestedElementCount))
      : 16;
    return JSON.stringify(compactParameterReadResultForPrompt(parsed, {
      maxEvidence,
      maxElementIds: 64,
      preferredParameterNames: requestedNames
    }), null, 2);
  } catch {
    return text;
  }
}

export function adaptMcpToolCallResultToDynamicResponse(
  result: any,
  context?: { tool?: unknown; arguments?: unknown; projections?: EvidenceProjectionV1[]; omitted?: number }
): { contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }>; success: boolean } {
  const contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }> = [];
  const content = Array.isArray(result?.content) ? result.content : [];
  // operator_retrieve_evidence is the reviewed, byte-bounded expansion edge.
  // Its selection must reach the model directly; projecting the retrieval
  // result itself creates an evidence-reference recursion in which the model
  // can never consume the requested fields. The V2 settlement path still
  // retains the retrieval result and its projection durably for audit/recovery.
  const exposeFocusedRetrieval = context?.tool === "operator_retrieve_evidence" || result?.isError === true;
  const hasProjectionContext = Array.isArray(context?.projections)
    && (context!.projections!.length > 0 || (context?.omitted ?? 0) > 0) && !exposeFocusedRetrieval;
  if (hasProjectionContext) {
    contentItems.push({
      type: "inputText",
      text: JSON.stringify(modelEvidenceEnvelope(context!.projections!, context!.omitted ?? 0))
    });
  }
  let attachedImages = 0;
  for (const item of content) {
    if (hasProjectionContext && item?.type !== "image") continue;
    if (item?.type === "text" && typeof item.text === "string") {
      contentItems.push({ type: "inputText", text: result?.isError === true ? item.text : compactDynamicMcpTextForCodex(context?.tool, context?.arguments, item.text) });
      continue;
    }
    if (item?.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      if (attachedImages < 3) {
        contentItems.push({ type: "inputImage", imageUrl: `data:${item.mimeType};base64,${item.data}` });
        attachedImages += 1;
      }
      continue;
    }
    try {
      contentItems.push({ type: "inputText", text: JSON.stringify(item) });
    } catch {
      contentItems.push({ type: "inputText", text: String(item) });
    }
  }
  if (contentItems.length === 0 && result?.structuredContent !== undefined) {
    const text = JSON.stringify(result.structuredContent);
    contentItems.push({ type: "inputText", text: result?.isError === true ? text : compactDynamicMcpTextForCodex(context?.tool, context?.arguments, text) });
  }
  if (contentItems.length === 0) contentItems.push({ type: "inputText", text: result?.isError ? "MCP tool failed without an error body." : "MCP tool completed without output." });
  return { contentItems, success: result?.isError !== true };
}
