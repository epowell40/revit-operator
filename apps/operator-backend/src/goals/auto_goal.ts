const MULTI_ACTION = /\b(all|these|every|batch|several|multiple|set of|clean up|fix up|pick up|update this area)\b/i;
const UNCERTAIN_PATH = /\b(figure out|determine|resolve|where marked|where shown|as marked|redline|markup|make sure|verify|iterate|try|adjust)\b/i;
const SPATIAL = /\b(room|wall|sheet|view|redline|markup|receptacle|outlet|device|tag|near|adjacent|along|align|move|rotate|place|add)\b/i;
const VISUAL = /\b(redline|markup|screenshot|capture|image|pdf|shown|marked|visual)\b/i;
const OUTCOME = /\b(make sure|so it works|complete|finish|clean up|pick up|apply|update|fix|add|place|print)\b/i;
const SINGLE_COMMAND = /\b(select|what is|change this one|open sheet|open view|show me|list|find)\b/i;

export type AutoGoalDecision = {
  shouldStart: boolean;
  score: number;
  signals: string[];
  title: string;
  objective: string;
  acceptanceCriteria: string[];
};

export function classifyAutoGoalRequest(userText: string): AutoGoalDecision {
  const text = (userText ?? "").replace(/\s+/g, " ").trim();
  const signals: string[] = [];
  if (!text) return empty(text);
  if (MULTI_ACTION.test(text)) signals.push("multiple Revit actions or batch scope");
  if (UNCERTAIN_PATH.test(text)) signals.push("uncertain path or verification/retry likely");
  if (SPATIAL.test(text)) signals.push("spatial/model interpretation");
  if (VISUAL.test(text)) signals.push("visual/redline interpretation");
  if (OUTCOME.test(text)) signals.push("outcome-oriented request");

  let score = signals.length;
  if (SINGLE_COMMAND.test(text) && score < 3) score -= 2;
  const shouldStart = score >= 2;
  return {
    shouldStart,
    score,
    signals,
    title: makeTitle(text),
    objective: text,
    acceptanceCriteria: [
      "The requested Revit outcome is completed or a concrete blocker is reported.",
      "Actions are verified with native Revit context, coordinates, exported evidence, or tool validation.",
      "Any retries are bounded and each retry changes placement, orientation, scope, or evidence."
    ]
  };
}

function empty(text: string): AutoGoalDecision {
  return { shouldStart: false, score: 0, signals: [], title: makeTitle(text), objective: text, acceptanceCriteria: [] };
}

function makeTitle(text: string): string {
  const clipped = (text || "Revit goal").slice(0, 90).trim();
  return clipped.length > 0 ? clipped : "Revit goal";
}
