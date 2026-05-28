import { OPERATOR_BACKEND_CONTRACT_VERSION, type ActionCall, type ChatRequest, type ChatResponse } from "../contracts.js";
import { randomUUID } from "node:crypto";

function newAction(method: ActionCall["method"], path: string, body?: unknown): ActionCall {
  return {
    action_id: randomUUID(),
    method,
    path,
    ...(body === undefined ? {} : { body })
  };
}

function sanitizeFileName(input: string): string {
  const trimmed = input.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return "";
  const safe = trimmed.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
  return safe.slice(0, 120);
}

export async function decideRule(req: ChatRequest): Promise<ChatResponse> {
  const text = (req.user_text ?? "").trim();
  const lower = text.toLowerCase();
  const pdfAttachments = Array.isArray(req.user_attachments)
    ? req.user_attachments.filter(a => typeof a?.relative_path === "string" && /\.pdf$/i.test(String(a.relative_path)))
    : [];

  const actions: ActionCall[] = [];
  let assistant_message = "";

  if (!text) {
    assistant_message = "Type one of: ping, list views, context, capture view, export pdf.";
  } else if (lower.includes("ping")) {
    assistant_message = "Pinging Revit…";
    actions.push(newAction("GET", "/revit/ping"));
  } else if (lower.includes("context")) {
    assistant_message = "Fetching Revit context…";
    actions.push(newAction("GET", "/revit/context"));
  } else if (lower.includes("snapshot") || lower.includes("state snapshot")) {
    assistant_message = "Capturing Revit state snapshot…";
    actions.push(newAction("POST", "/revit/state-snapshot", {}));
  } else if (lower.includes("list views") || lower === "views" || lower.includes(" show views")) {
    assistant_message = "Listing views…";
    actions.push(newAction("GET", "/revit/views"));
  } else if (lower.includes("capture view") || lower.includes("capture")) {
    assistant_message = "Capturing the active view…";
    actions.push(newAction("POST", "/revit/export-image", {}));
  } else if (lower.includes("tool ui demo") || lower.includes("tool host demo") || lower.includes("open tool demo")) {
    assistant_message = "Opening the hosted tool UI demo…";
    actions.push(newAction("POST", "/ui/open", {
      url: "/ui/tool-host-demo",
      mode: lower.includes("popup") ? "popup" : "pane",
      title: "Tool Host Demo",
      width: 1100,
      height: 760,
      allowedMessageTypes: [
        "revit.ping",
        "revit.pickElements",
        "revit.pickPoints",
        "revit.showElements",
        "revit.executeAction",
        "backend.request"
      ],
      allowedActions: [
        { method: "GET", path: "/revit/ping" },
        { method: "GET", path: "/revit/context" },
        { method: "POST", path: "/revit/export-image" },
        { method: "POST", path: "/revit/set-selection" }
      ],
      allowedBackendPaths: [
        "/health"
      ],
      initialPayload: {
        openedBy: "rule_brain",
        openedAt: new Date().toISOString()
      }
    }));
  } else if (
    lower.includes("zippybim") ||
    lower.includes("floor plan import") ||
    lower.includes("import this pdf as walls") ||
    lower.includes("open import tool")
  ) {
    assistant_message = "Opening the floor plan import tool…";
    actions.push(newAction("POST", "/ui/open", {
      url: "/ui/zippybim-import",
      mode: "pane",
      title: "Floor Plan Import",
      width: 1220,
      height: 860,
      allowedMessageTypes: [
        "revit.executeAction",
        "backend.request"
      ],
      allowedActions: [
        { method: "POST", path: "/revit/import-zippybim-geometry" },
        { method: "POST", path: "/revit/place-pdf-underlay" }
      ],
      allowedBackendPaths: [
        "/tools/zippybim/*"
      ],
      initialPayload: {
        openedBy: "rule_brain",
        openedAt: new Date().toISOString(),
        user_text: text,
        attachments: pdfAttachments
      }
    }));
  } else if (lower.includes("export pdf") || lower.includes("print pdf")) {
    const after = text.replace(/.*?(export pdf|print pdf)/i, "");
    const maybeName = sanitizeFileName(after);
    assistant_message = maybeName ? `Exporting active view to PDF (“${maybeName}”)…` : "Exporting active view to PDF…";
    actions.push(newAction("POST", "/revit/export-pdf", maybeName ? { fileName: maybeName } : {}));
  } else {
    assistant_message = "I can: ping, list views, context, capture view, export pdf.";
  }

  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message,
    actions
  };
}
