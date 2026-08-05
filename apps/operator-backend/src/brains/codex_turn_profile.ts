import type { ChatRequest } from "../contracts.js";
import { formatAgentTurnContract } from "../agent_response_policy.js";
import {
  CERTIFIED_SIDECAR_PROMPT_LINES,
  CERTIFIED_SIDECAR_TOOL_SUMMARY_LINES,
  isCertifiedSidecarRequest
} from "../capabilities/certified_sidecar_capability.js";

function clipPromptBlock(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n…(truncated)`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedString(value: unknown, maxChars = 512): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, maxChars) : null;
}

function boundedValue(value: unknown, maxItems = 24): unknown {
  if (Array.isArray(value)) return value.slice(0, maxItems).map(item => typeof item === "string" ? item.slice(0, 256) : item);
  return value ?? null;
}

function compactFields(source: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string") output[field] = value.slice(0, 512);
    else if (typeof value === "number" || typeof value === "boolean") output[field] = value;
    else if (Array.isArray(value)) output[field] = boundedValue(value);
  }
  return output;
}

function certifiedEnvelopeEvidence(context: unknown): Record<string, unknown> {
  const root = record(context);
  const revit = record(root.revit);
  const source = record(revit.source);
  const document = record(revit.document);
  const readiness = record(revit.readiness);
  const ui = record(root.ui);
  const uiDocument = record(ui.revit_document);
  const processId = revit.process_id ?? uiDocument.process_id ?? null;
  const courierExecutorId = revit.courier_executor_id ?? revit.executor_id ?? null;
  return {
    operator_brain_route: "direct",
    certified_sidecar_bootstrap: root.certified_sidecar_bootstrap,
    revit: {
      source: compactFields(source, ["live", "provenance", "source", "context_endpoint", "observed_at", "timestamp"]),
      process_id: processId,
      courier_executor_id: courierExecutorId,
      document: {
        title: boundedString(document.title) ?? boundedString(uiDocument.title),
        path: boundedString(document.path) ?? boundedString(uiDocument.path),
        projectIdentity: boundedString(document.projectIdentity ?? document.project_identity) ?? boundedString(uiDocument.projectIdentity ?? uiDocument.project_identity),
        activeView: compactFields(record(document.activeView ?? document.active_view), ["id", "name", "type", "view_id", "view_name", "view_type"])
      },
      readiness: {
        active_document_name: boundedString(readiness.active_document_name ?? readiness.activeDocumentName) ?? boundedString(document.title) ?? boundedString(uiDocument.title),
        active_document_path: boundedString(readiness.active_document_path ?? readiness.activeDocumentPath) ?? boundedString(document.path) ?? boundedString(uiDocument.path),
        active_view_name: boundedString(readiness.active_view_name ?? readiness.activeViewName),
        active_view_type: boundedString(readiness.active_view_type ?? readiness.activeViewType),
        active_view_id: boundedValue(readiness.active_view_id ?? readiness.activeViewId),
        selection: boundedValue(readiness.selection ?? readiness.selection_ids ?? readiness.selectionIds)
      }
    },
    ui: {
      revit_document: {
        title: boundedString(uiDocument.title),
        path: boundedString(uiDocument.path),
        projectIdentity: boundedString(uiDocument.projectIdentity ?? uiDocument.project_identity),
        process_id: uiDocument.process_id ?? null
      }
    }
  };
}

export function formatCodexRequestEnvelope(req: ChatRequest): string {
  if (isCertifiedSidecarRequest(req)) {
    return `CERTIFIED REVIT EVIDENCE (host-injected, canonical):\n${JSON.stringify(certifiedEnvelopeEvidence(req.context))}`;
  }
  const blocks: string[] = [];
  const turnContract = formatAgentTurnContract(req.user_text, req.context);
  if (turnContract) blocks.push(turnContract);
  if (req.context !== undefined) {
    try {
      blocks.push(`CURRENT REVIT/SERVER CONTEXT:\n${clipPromptBlock(JSON.stringify(req.context, null, 2), 20_000)}`);
    } catch {
      blocks.push("CURRENT REVIT/SERVER CONTEXT:\n(not serializable)");
    }
  }
  if (Array.isArray(req.user_attachments) && req.user_attachments.length > 0) {
    const attachments = req.user_attachments.map(attachment => ({
      id: attachment.id,
      relative_path: attachment.relative_path,
      filename: attachment.filename,
      mime: attachment.mime,
      bytes: attachment.bytes,
      sha256: attachment.sha256
    }));
    blocks.push(`USER ATTACHMENTS (paths are relative to the Operator Workspace; inspect these exact files when visual evidence is required):\n${clipPromptBlock(JSON.stringify(attachments, null, 2), 8_000)}`);
  }
  return blocks.join("\n\n");
}

function getCertifiedSidecarBaseInstructions(): string {
  return [
    "You are Revit Operator in the certified direct Sidecar lane.",
    ...CERTIFIED_SIDECAR_PROMPT_LINES,
    ...CERTIFIED_SIDECAR_TOOL_SUMMARY_LINES,
    "Do not use MCP, dynamic tools, skills, file tools, web tools, or discovery. Answer only from the host-injected certified context and state any unavailable detail as a limitation."
  ].join("\n");
}

function getCertifiedSidecarDeveloperInstructions(): string {
  return [
    ...CERTIFIED_SIDECAR_PROMPT_LINES,
    ...CERTIFIED_SIDECAR_TOOL_SUMMARY_LINES,
    "The context is the current host observation. Do not request, plan, or imply any tool call."
  ].join("\n");
}

export type CodexThreadStartProfile = {
  certified: boolean;
  profileNamespace: "normal-v1" | "certified-v1";
  threadKey: string;
  sandbox: "workspace-write" | "read-only";
  approvalPolicy: "never";
  dynamicToolMode: "revit_runtime" | "none";
  startRevitTurnRuntime: boolean;
  baseInstructions: string;
  developerInstructions: string;
};

function persistedProfileKey(namespace: CodexThreadStartProfile["profileNamespace"], sessionId: string): string {
  return `${namespace}:${sessionId.length}:${sessionId}`;
}

export function getCodexThreadStartProfile(
  req: Pick<ChatRequest, "session_id" | "context">,
  normalInstructions: { baseInstructions: string; developerInstructions: string }
): CodexThreadStartProfile {
  if (isCertifiedSidecarRequest(req)) {
    return {
      certified: true,
      profileNamespace: "certified-v1",
      threadKey: persistedProfileKey("certified-v1", req.session_id),
      sandbox: "read-only",
      approvalPolicy: "never",
      dynamicToolMode: "none",
      startRevitTurnRuntime: false,
      baseInstructions: getCertifiedSidecarBaseInstructions(),
      developerInstructions: getCertifiedSidecarDeveloperInstructions()
    };
  }
  return {
    certified: false,
    profileNamespace: "normal-v1",
    threadKey: persistedProfileKey("normal-v1", req.session_id),
    sandbox: "workspace-write",
    approvalPolicy: "never",
    dynamicToolMode: "revit_runtime",
    startRevitTurnRuntime: true,
    baseInstructions: normalInstructions.baseInstructions,
    developerInstructions: normalInstructions.developerInstructions
  };
}
