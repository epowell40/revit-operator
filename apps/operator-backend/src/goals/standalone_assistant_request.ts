import { MODEL_CHANGE_PROHIBITION } from "../no_write_intent.js";

/** Requests to reshape an answer are conversation, even in a model session. */
function isAnswerDraftRequest(request: string): boolean {
  const reference = "(?:that|this|it|the (?:above|answer|response|summary|findings|list))";
  const output = "(?:plan|checklist|summary|table|outline|list|questions|draft)";
  return new RegExp(`^\\s*(?:please\\s+)?(?:turn|organize|reorganize|convert)\\s+${reference}\\s+into\\s+(?:a\\s+|an\\s+)?[^.!?;\\n]{0,60}\\b${output}\\b`, "i").test(request)
    || new RegExp(`^\\s*(?:please\\s+)?(?:summarize|rewrite|rephrase|condense|prioritize|explain)\\s+${reference}\\b`, "i").test(request)
    || new RegExp(`^\\s*(?:please\\s+)?(?:make|keep)\\s+${reference}\\s+(?:shorter|briefer|brief|concise|simpler|more concise|more readable)\\b`, "i").test(request);
}

/** Standalone document review, answer drafting, research and calculation need no Revit observation. */
export function isStandaloneAssistantRequest(text: string): boolean {
  // Remove only model-preservation constraints. They do not request model work.
  const request = text.replace(new RegExp(MODEL_CHANGE_PROHIBITION.source, "gi"), " ")
    .replace(/\b(?:do not|don't|dont|never)\s+(?:change|modify|edit|save)\s+(?:the\s+)?(?:revit\s+)?(?:model|project|document)\b/gi, " ")
    .replace(/\b(?:make|perform|apply|commit)\s+no\s+(?:(?:revit|model|project|document)\s+)?(?:changes?|edits?|modifications?)\b/gi, " ")
    .replace(/\b(?:leave|keep)\s+(?:the\s+)?(?:revit\s+)?(?:model|project|document)\s+unchanged\b/gi, " ");
  const documentReview = /\b(?:read|review|summarize|explain|extract|compare|outline|analy[sz]e)\b[^.!?;\n]{0,100}\b(?:attached|uploaded|provided)\b[^.!?;\n]{0,60}\b(?:documents?|pdfs?|checklists?|task lists?|specifications?|specs?|reports?|redlines?|drawings?)\b/i.test(request)
    || /\bwhat\b[^.!?;\n]{0,60}\b(?:attached|uploaded|provided)\b[^.!?;\n]{0,60}\b(?:documents?|pdfs?|checklists?|task lists?|specifications?|specs?|reports?)\b[^.!?;\n]{0,60}\b(?:say|mean|require|call for)\b/i.test(request);
  const researchOrCalculation = /\b(?:look up|research|search (?:the )?(?:internet|web)|manufacturer|published|calculate|calculation|convert|formula|explain|engineering)\b/i.test(request);
  const answerDraft = isAnswerDraftRequest(request);
  if (!researchOrCalculation && !documentReview && !answerDraft) return false;
  // References to the current model, selection, drawing, or an executable
  // model operation keep the durable Revit owner, including mixed requests.
  if (documentReview) {
    if (/\b(?:revit|model|selected|selection|parameter|element)\b|\b(?:current|active|open|this|our)\s+(?:project|sheet|view|schedule)\b/i.test(request)) return false;
  } else if (/\b(?:revit|model|project|selected|selection|sheet|view|redline|markup|parameter|element|schedule)\b/i.test(request)) return false;
  if (/\b(?:this|that|these|those|current|active)\s+(?:duct|pipe|fan|device|equipment|system|branch)\b/i.test(request)) return false;
  if (/\b(?:add|adjust|change|correct|fix|create|place|move|delete|remove|rename|resize|replace|set|route|connect|disconnect|update|modify|edit|apply|commit|export|print)\b/i.test(request)) return false;
  // A drafting request does not absorb a second instruction to execute or
  // communicate the plan. Keep that mixed request with the durable owner.
  if (answerDraft && /\b(?:execute|implement|perform|carry out|go ahead|do (?:it|that|the work|the tasks)|send|email|contact|publish|submit|resume|continue|run)\b/i.test(request)) return false;
  if (/\b(?:wrong|incorrect|needs? (?:changing|fixing|replacing|updating))\b/i.test(request)) return false;
  return true;
}
