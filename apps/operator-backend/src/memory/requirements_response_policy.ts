import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ChatResponse } from "../contracts.js";
import {
  formatRequirementsForPrompt,
  resolveRequirementsForChat,
  type RequirementsReceipt
} from "./requirements_store.js";

export type RequirementsResponseGuard = {
  initial_receipt: RequirementsReceipt | null;
  initial_error: string;
  blocker: ChatResponse | null;
};

export function formatRequirementsPromptBlockSafely(req: ChatRequest): string {
  try {
    return formatRequirementsForPrompt(resolveRequirementsForChat(req));
  } catch {
    return "";
  }
}

export function captureRequirementsResponseGuard(req: ChatRequest): RequirementsResponseGuard {
  try {
    const initial_receipt = resolveRequirementsForChat(req);
    const blocker: ChatResponse | null = initial_receipt.status === "resolved"
      ? null
      : {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message: `Durable requirements are ${initial_receipt.status}. I stopped before planning or Revit actions; resolve or narrow the attached receipt first.`,
          actions: [],
          requirements_receipt: initial_receipt
        };
    return { initial_receipt, initial_error: "", blocker };
  } catch (error) {
    const initial_error = error instanceof Error ? error.message : String(error);
    return {
      initial_receipt: null,
      initial_error,
      blocker: {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: `Durable requirements could not be read safely (${initial_error}). I stopped before planning or Revit actions.`,
        actions: []
      }
    };
  }
}

export function enforceRequirementsResponseGuard(req: ChatRequest, response: ChatResponse, guard: RequirementsResponseGuard): ChatResponse {
  try {
    const requirements_receipt = resolveRequirementsForChat(req);
    const hasActions = Array.isArray(response.actions) && response.actions.length > 0;
    if (hasActions && guard.initial_receipt && requirements_receipt.receipt_sha256 !== guard.initial_receipt.receipt_sha256) {
      response = {
        ...response,
        assistant_message: "Durable requirements changed while this plan was being prepared. I stopped before Revit actions; re-run the request against the attached current receipt.",
        actions: []
      };
    } else if (hasActions && requirements_receipt.status !== "resolved") {
      response = {
        ...response,
        assistant_message: `Durable requirements are ${requirements_receipt.status}. I stopped before Revit actions; resolve or narrow the attached receipt first.`,
        actions: []
      };
    }
    if (requirements_receipt.status !== "resolved" || requirements_receipt.applied.length > 0) {
      response = { ...response, requirements_receipt };
    }
  } catch (error) {
    if (Array.isArray(response.actions) && response.actions.length > 0) {
      response = {
        ...response,
        assistant_message: `Durable requirements could not be read safely (${error instanceof Error ? error.message : String(error)}). I stopped before Revit actions.`,
        actions: []
      };
    }
  }
  return response;
}
