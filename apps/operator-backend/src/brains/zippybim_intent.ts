import { randomUUID } from "node:crypto";
import {
  OPERATOR_BACKEND_CONTRACT_VERSION,
  type ActionCall,
  type ChatRequest,
  type ChatResponse,
  type UserAttachment
} from "../contracts.js";

const ZIPPYBIM_TOOL_UI_VERSION = "20260308i";

function newAction(method: ActionCall["method"], path: string, body?: unknown): ActionCall {
  return {
    action_id: randomUUID(),
    method,
    path,
    ...(body === undefined ? {} : { body })
  };
}

function pdfAttachments(req: ChatRequest): UserAttachment[] {
  return Array.isArray(req.user_attachments)
    ? req.user_attachments.filter(a => typeof a?.relative_path === "string" && /\.pdf$/i.test(String(a.relative_path)))
    : [];
}

function preferredPdfAttachment(req: ChatRequest): UserAttachment | null {
  const pdfs = pdfAttachments(req);
  if (pdfs.length === 0) return null;
  return [...pdfs].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0] ?? null;
}

function includesAny(text: string, phrases: string[]): boolean {
  return phrases.some(phrase => text.includes(phrase));
}

export function shouldOpenZippyBimTool(req: ChatRequest): boolean {
  const text = (req.user_text ?? "").trim().toLowerCase();
  if (!text) return false;

  const pdfs = pdfAttachments(req);
  const hasPdfAttachment = pdfs.length > 0;
  const redlineOrMepIntent = includesAny(text, [
    "redline",
    "markup",
    "mark-up",
    "comment bubble",
    "comments",
    "duct",
    "ductwork",
    "supply duct",
    "return duct",
    "exhaust duct",
    "pipe",
    "piping",
    "mep"
  ]);

  const explicitToolIntent = includesAny(text, [
    "zippybim",
    "floor plan import",
    "open import tool",
    "open floor plan import"
  ]);

  if (!explicitToolIntent && redlineOrMepIntent) return false;

  const importIntent = includesAny(text, [
    "import this pdf floor plan",
    "import this floor plan pdf",
    "import pdf floor plan",
    "import floor plan pdf",
    "import pdf vectors",
    "import this pdf as walls",
    "draft walls from pdf",
    "trace walls from pdf",
    "pdf wall import",
    "draft the walls from pdf",
    "draft walls from this pdf"
  ]);

  const floorPlanIntent =
    text.includes("floor plan") &&
    includesAny(text, ["import", "draft", "trace", "walls", "vectors", "pdf"]);

  const genericPdfImportIntent =
    hasPdfAttachment &&
    text.includes("import this pdf") &&
    !redlineOrMepIntent;

  return explicitToolIntent || (hasPdfAttachment && (importIntent || floorPlanIntent || genericPdfImportIntent));
}

export function maybeBuildZippyBimToolDecision(req: ChatRequest): ChatResponse | null {
  if (!shouldOpenZippyBimTool(req)) return null;
  const preferredAttachment = preferredPdfAttachment(req);

  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Opening the floor plan import tool…",
    actions: [
      newAction("POST", "/ui/open", {
        url: "/ui/zippybim-import?v=" + encodeURIComponent(ZIPPYBIM_TOOL_UI_VERSION),
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
          openedBy: "zippybim_intent",
          openedAt: new Date().toISOString(),
          user_text: (req.user_text ?? "").trim(),
          attachments: pdfAttachments(req),
          preferred_relative_path: preferredAttachment?.relative_path ?? null,
          preferred_filename: preferredAttachment?.filename ?? null
        }
      })
    ]
  };
}
