import { hasExplicitMutationVerb } from "../revit_mutation_intent.js";
import { isAffirmativeDocumentLifecycleMutation, isExplicitNoWriteRequest } from "../teammate_loop_runtime.js";
import { hasAuthoritativeLeadingNoWriteFraming } from "../no_write_intent.js";

const MULTI_ACTION = /\b(all|these|every|batch|several|multiple|set of|clean up|fix up|pick up|update this area)\b/i;
const UNCERTAIN_PATH = /\b(figure out|determine|resolve|where marked|where shown|as marked|redline|markup|make sure|verify|iterate|try|adjust)\b/i;
const SPATIAL = /\b(room|wall|sheet|view|redline|markup|receptacle|outlet|device|tag|near|adjacent|along|align|move|rotate|place|add)\b/i;
const VISUAL = /\b(redline|markup|screenshot|capture|image|pdf|shown|marked|visual)\b/i;
const OUTCOME = /\b(make sure|so it works|complete|finish|clean up|pick up|apply|update|fix|add|place|put|fill|enter|write|copy|move|align|rotate|resize|change|adjust|modify|edit|replace|delete|remove|rename|restore|revert|reset|clear|set|assign|match|hide|unhide|turn (?:on|off)|print)\b/i;
const SINGLE_COMMAND = /\b(select|what is|change this one|open sheet|open view|show me|list|find)\b/i;
const LIVE_MODEL_OBJECT = /\b(revit|project|model|sheet|view|schedule|family|type|element|room|space|wall|door|window|duct|pipe|terminal|air device|device|equipment|fixture|tag|parameter|selection)\b/i;
const LIVE_MODEL_OPERATION = /\b(count|how many|break down|breakdown|list|find|show|open|inspect|check|query|report|select|capture|export|print|create|duplicate|add|place|put|fill|enter|write|copy|move|align|rotate|resize|change|adjust|modify|update|edit|replace|delete|remove|rename|restore|revert|reset|clear|set|assign|match|hide|unhide|turn (?:on|off)|verify)\b/i;
const PREVIEW_REQUEST = /\b(preview|preflight|dry[- ]?run|show me (?:the )?change|do not commit|don't commit)\b/i;
const EXECUTABLE_PREVIEW = /\b(?:execute|perform|run|simulate)\b[^.!?]{0,80}\b(?:preview|preflight|dry[- ]?run|rollback)\b|\b(?:executable|transaction(?:al)?|rollback)\s+(?:change\s+)?preview\b|\bshow me (?:the )?change\b/i;
const APPLY_BEYOND_PREVIEW = /\b(?:(?:do not|don't|dont|never)\s+(?:(?:just|only)\s+)?(?:stop|end|finish|halt|remain|return)\b[^.!?;\n]{0,40}\b(?:preview|preflight|dry[- ]?run)|(?:do not|don't|dont|never)\s+(?:just\s+|only\s+)?(?:preview|preflight|dry[- ]?run)\b|(?:not|rather than)\s+(?:just\s+|only\s+)?(?:a\s+)?(?:preview|preflight|dry[- ]?run)\b|(?:proceed|continue|go)\s+beyond\s+(?:the\s+)?(?:preview|preflight|dry[- ]?run)\b)/i;
const APPLY_AFTER_PREFLIGHT = /\b(?:then\s+|and\s+then\s+)?(?:apply|commit|execute|perform|proceed(?:\s+with)?)\b/i;

export type AutoGoalDecision = {
  shouldStart: boolean;
  score: number;
  signals: string[];
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  requestedEffect: "read" | "preview" | "apply";
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
  const explicitMutation = hasExplicitMutationVerb(text);
  const liveModelRequest = LIVE_MODEL_OBJECT.test(text) && (LIVE_MODEL_OPERATION.test(text) || explicitMutation);
  if (liveModelRequest) signals.push("live Revit model work");

  let score = signals.length;
  if (SINGLE_COMMAND.test(text) && score < 3 && !liveModelRequest) score -= 2;
  const shouldStart = liveModelRequest || score >= 2;
  const documentLifecycleMutation = isAffirmativeDocumentLifecycleMutation(text);
  const authoritativeLeadingNoWrite = hasAuthoritativeLeadingNoWriteFraming(text);
  const informationalReadOnlyPlan = isExplicitNoWriteRequest(text)
    && /\b(?:read[- ]only|discovery only|inspection only)\b/i.test(text)
    && /\b(?:plan|steps?|guidance|instructions?|recommendations?)\b/i.test(text)
    && !EXECUTABLE_PREVIEW.test(text);
  const explicitNoWrite = isExplicitNoWriteRequest(text);
  const appliesAfterPreflight = APPLY_AFTER_PREFLIGHT.test(text) && !explicitNoWrite;
  const requestedEffect = PREVIEW_REQUEST.test(text) && !informationalReadOnlyPlan
    && !APPLY_BEYOND_PREVIEW.test(text) && !appliesAfterPreflight
    ? "preview"
    : (documentLifecycleMutation && !authoritativeLeadingNoWrite) || (explicitMutation && !explicitNoWrite)
      ? "apply"
      : "read";
  return {
    shouldStart,
    score,
    signals,
    title: makeTitle(text),
    objective: text,
    requestedEffect,
    acceptanceCriteria: liveModelRequest
      ? [
          "The requested Revit work is completed or a concrete blocker is reported.",
          "The reported result is grounded in successful live Revit tool evidence from this assignment."
        ]
      : [
          "The requested Revit outcome is completed or a concrete blocker is reported.",
          "Actions are verified with native Revit context, coordinates, exported evidence, or tool validation.",
          "Any retries are bounded and each retry changes placement, orientation, scope, or evidence."
        ]
  };
}

function empty(text: string): AutoGoalDecision {
  return { shouldStart: false, score: 0, signals: [], title: makeTitle(text), objective: text, acceptanceCriteria: [], requestedEffect: "read" };
}

function makeTitle(text: string): string {
  const clipped = (text || "Revit goal").slice(0, 90).trim();
  return clipped.length > 0 ? clipped : "Revit goal";
}
