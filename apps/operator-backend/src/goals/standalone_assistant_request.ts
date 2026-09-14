/** Standalone research/calculation should not require a Revit mutation receipt. */
export function isStandaloneAssistantRequest(text: string): boolean {
  // Remove only model-preservation constraints. They do not request model work.
  const request = text.replace(/\b(?:do not|don't|dont|never)\s+(?:change|modify|edit|save)\s+(?:the\s+)?(?:revit\s+)?(?:model|project|document)\b/gi, " ")
    .replace(/\b(?:make|perform|apply|commit)\s+no\s+(?:(?:revit|model|project|document)\s+)?(?:changes?|edits?|modifications?)\b/gi, " ")
    .replace(/\b(?:leave|keep)\s+(?:the\s+)?(?:revit\s+)?(?:model|project|document)\s+unchanged\b/gi, " ");
  const researchOrCalculation = /\b(?:look up|research|search (?:the )?(?:internet|web)|manufacturer|published|calculate|calculation|convert|formula|explain|engineering)\b/i.test(request);
  if (!researchOrCalculation) return false;
  // References to the current model, selection, drawing, or an executable
  // model operation keep the durable Revit owner, including mixed requests.
  if (/\b(?:revit|model|project|selected|selection|sheet|view|redline|markup|parameter|element|schedule)\b/i.test(request)) return false;
  if (/\b(?:this|that|these|those|current|active)\s+(?:duct|pipe|fan|device|equipment|system|branch)\b/i.test(request)) return false;
  if (/\b(?:add|adjust|change|correct|fix|create|place|move|delete|remove|rename|resize|replace|set|route|connect|disconnect|update|modify|edit|apply|commit|export|print)\b/i.test(request)) return false;
  if (/\b(?:wrong|incorrect|needs? (?:changing|fixing|replacing|updating))\b/i.test(request)) return false;
  return true;
}
