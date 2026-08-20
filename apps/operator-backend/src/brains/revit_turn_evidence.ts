export type FreshRevitEvidenceRequirement = {
  required: boolean;
  kind: "none" | "sheet_count" | "revit_tool";
  prompt: string;
};

export const FRESH_REVIT_EVIDENCE_FAILURE =
  "I could not verify this against live Revit because the required Revit tool did not complete successfully in this turn. No result was guessed.";

export function getFreshRevitEvidenceRequirement(userText: string): FreshRevitEvidenceRequirement {
  const text = (userText ?? "").toString().trim().toLowerCase();
  if (!text) return { required: false, kind: "none", prompt: "" };
  const sheetCount =
    /\b(?:how\s+many|count|number\s+of|total)\b[^?\n]{0,80}\bsheets?\b/.test(text)
    || /\bsheets?\b[^?\n]{0,80}\b(?:how\s+many|count|number|total)\b/.test(text);
  if (sheetCount) return {
    required: true,
    kind: "sheet_count",
    prompt: "FRESH REVIT EVIDENCE REQUIRED: this turn must successfully call `revit_list_sheets` with `action:\"count\"` and `exact:true` (or call `/revit/sheets` with the same count request). Do not answer from memory, prior turns, a registry lookup, or `/revit/views`."
  };
  const entity = /\b(?:revit|model|project|document|sheet|view|schedule|element|equipment|family|type|instance|room|space|wall|door|window|duct|pipe|terminal|air device|device|fixture|tag|parameter|connector|branch|fitting|system|topology|level|plan|selection)\b/.test(text);
  const liveIntent = /\b(?:how\s+many|count|list|find|show|which|where|identify|inspect|check|verify|compare|audit|preview|change|update|set|create|add|delete|remove|move|rename|print|export|capture|place|route|connect|resize|edit|select|open|current|active)\b/.test(text);
  return entity && liveIntent ? {
    required: true,
    kind: "revit_tool",
    prompt: "FRESH REVIT EVIDENCE REQUIRED: use at least one relevant `revit_operator` tool successfully in this turn before reporting a live-model fact or completion. Do not answer from memory or prior turns."
  } : { required: false, kind: "none", prompt: "" };
}

function parseArguments(value: unknown): any {
  if (typeof value !== "string") return value && typeof value === "object" ? value : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function isSuccessfulFreshRevitEvidence(
  requirement: FreshRevitEvidenceRequirement,
  call: { server?: unknown; tool?: unknown; arguments?: unknown; success?: unknown; status?: unknown; error?: unknown }
): boolean {
  if (!requirement.required) return true;
  const server = typeof call.server === "string" ? call.server.trim().toLowerCase().replace(/-/g, "_") : "";
  if (server && server !== "revit_operator") return false;
  const status = typeof call.status === "string" ? call.status.trim().toLowerCase() : "";
  const succeeded = call.success === true || (call.success !== false && !call.error && ["success", "ok", "done", "completed"].includes(status));
  if (!succeeded) return false;
  if (requirement.kind === "revit_tool") return true;
  const tool = typeof call.tool === "string" ? call.tool.trim() : "";
  const args = parseArguments(call.arguments);
  if (tool === "revit_list_sheets") return String(args.action ?? "").toLowerCase() === "count" || args.countOnly === true;
  if (tool === "revit_call_tool") {
    const body = parseArguments(args.body);
    return String(args.path ?? "").toLowerCase() === "/revit/sheets" && String(body.action ?? "").toLowerCase() === "count";
  }
  return false;
}
