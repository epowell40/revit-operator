import { hasExplicitMutationVerb } from "./revit_mutation_intent.js";

// An explicit model-preservation sentence is a turn constraint, including
// ordinary wording such as "Do not make model changes yet."
export const MODEL_CHANGE_PROHIBITION = /\b(?:do not|don't|dont|never)\s+(?:make|perform|apply|commit)\s+(?:any\s+)?(?:(?:further|additional)\s+)?(?:(?:revit|model|project|document)\s+(?:changes?|edits?|modifications?)|(?:changes?|edits?|modifications?)\s+to\s+(?:the\s+)?(?:revit\s+)?(?:model|project|document))\b/i;

function withoutScopedFurtherChanges(text: string): string {
  const match = new RegExp(MODEL_CHANGE_PROHIBITION.source + "[.!?]*\\s*$", "i").exec(text);
  if (!match || !/\b(?:further|additional)\b/i.test(match[0])) return text;
  const preceding = text.slice(0, match.index);
  const leadingAction = /^\s*(?:please\s+)?([a-z]+(?:\s+(?:up|in|out|off|on))?)\b/i.exec(preceding)?.[1] ?? "";
  // A terminal scope limit preserves an affirmative edit earlier in this
  // turn. A leading prohibition or navigation-only request stays read-only.
  // A noun or an edit mentioned inside an inspection/explanation is not an
  // affirmative command. Keep the exception limited to a leading edit.
  return hasExplicitMutationVerb(leadingAction) && !hasPreviewOrGlobalNoWriteFraming(preceding)
    ? preceding : text;
}

/** A disabled request option is not an instruction to run a preview. */
export function previewIntentText(text: string): string {
  return text.replace(/\bdry[- _]?run(?=["']?\s*[:=]\s*false\b)/gi, "disabled_option");
}

export const COORDINATED_GLOBAL_NO_WRITE = new RegExp(
  "\\b(?:do not|don't|dont|never)\\s+"
  + "(?:(?:actually|ever|otherwise)\\s+|(?:attempt|try)\\s+to\\s+)?"
  + "(?:change|save|modify|edit|create|apply|commit|export|print|delete|remove|write|mutate)"
  + "(?:\\s*,?\\s*(?:(?:or|and)\\s+)?(?:(?:actually|ever|otherwise)\\s+)?(?:change|save|modify|edit|create|apply|commit|export|print|delete|remove|write|mutate)){1,6}"
  + "\\s+(?:the\\s+)?(?:revit\\s+)?(?:model|project|document|anything|it)\\b",
  "i"
);

const TERMINAL_DIRECT_NO_WRITE = new RegExp(
  "\\b(?:do not|don't|dont|never)\\s+"
  + "(?:(?:actually|ever|otherwise)\\s+|(?:attempt|try)\\s+to\\s+)?"
  + "(?:change|save|modify|edit|configure|reload|create|apply|commit|export|print|delete|remove|write|mutate)"
  + "(?:\\s*(?:,|or|and)\\s*(?:(?:actually|ever|otherwise)\\s+)?(?:change|save|modify|edit|configure|reload|create|apply|commit|export|print|delete|remove|write|mutate)){0,6}"
  + "\\s+(?:(?:the|any)\\s+)?(?:schedule|family|model|project|document|files?|changes?|add[- ]?in|code|anything|it)\\s*[.!?]*\\s*$",
  "i"
);

const SCOPED_ANYTHING_ELSE_NO_WRITE = new RegExp(
  "\\b(?:do not|don't|dont|never)\\s+"
  + "(?:(?:also|otherwise)\\s+)?"
  + "(?:change|save|modify|edit|configure|reload|create|apply|commit|export|print|delete|remove|write|mutate|rename)"
  + "\\s+anything\\s+else\\b",
  "gi"
);

export function hasAuthoritativeLeadingNoWriteFraming(text: string): boolean {
  // A leading, sentence-level READ-ONLY declaration is an authoritative turn
  // contract even when a long planning request later names future edits.
  if (/^\s*read[ -]?only(?:\s+only)?\s*[.!:;-]/i.test(text)) return true;
  return /^\s*read[ -]?only\b[^.!?\n]{0,160}\b(?:investigation|inspection|analysis|discovery|audit|review|plan|planning|report)\b[^.!?\n]{0,80}\bonly\b\s*[.!:;-]/i.test(text);
}

function hasPreviewOrGlobalNoWriteFraming(text: string): boolean {
  if (hasDeferredProposalOnlyFraming(text)) return true;
  if (hasAuthoritativeLeadingNoWriteFraming(text)) return true;
  if (MODEL_CHANGE_PROHIBITION.test(text)) return true;
  if (/\bwithout\s+(?:changing|modifying|editing|saving)\s+(?:the\s+)?(?:revit\s+)?(?:model|project|document)\b/i.test(text)) return true;
  if (/\b(?:do not|don't|dont|never)\s+(?:change|modify|edit|delete|remove|write)\s+(?:any\s+)?(?:elements|parameters)\b/i.test(text)) return true;
  if (/\b(?:make|perform|apply|commit)\s+no\s+(?:(?:revit|model|project|document)\s+)?(?:changes?|edits?|modifications?)\b/i.test(text)) return true;
  const withoutRepeatedEdit = text.replace(/\b(?:do not|don't|dont|never)\s+repeat\s+(?:the\s+)?(?:edit|change|mutation)\b/gi, " ");
  if (withoutRepeatedEdit !== text && !hasExplicitMutationVerb(withoutRepeatedEdit)) return true;
  if (COORDINATED_GLOBAL_NO_WRITE.test(text)) return true;
  if (TERMINAL_DIRECT_NO_WRITE.test(text)) return true;
  if (hasNoncommittingChangePreviewRequest(text)) return true;
  if (/\bleave\s+(?:it|them|(?:the|this|current|selected)\s+(?:model|project|document|element|device|branch|accessory|pipe|duct))\s+(?:unchanged|in place)\b/i.test(text)) return true;
  if (/\bread[ -]?only\b[^.!?\n]{0,60}\b(?:plan|preview|analysis|inspection|report)\b/i.test(text)
      || /\b(?:plan|preview|analysis|inspection|report)\b[^.!?\n]{0,60}\bread[ -]?only\b/i.test(text)
      || /\b(?:preview|analysis)\s+only\b/i.test(text)) return true;
  if (/\b(?:preview|preflight|dry[ -]?run)\b/i.test(text)
      && /\b(?:do not|don't|dont|never)\s+(?:(?:actually|ever)\s+)?(?:apply|commit|write|modify|change|edit|save|execute|make)\b|\bwithout\s+(?:applying|committing|writing|modifying|changing|editing|saving|executing|making)\b/i.test(text)) return true;
  if (/\b(?:preview|preflight|dry[ -]?run)\b/i.test(text)
      && /\bwithout\s+(?:creating|writing|saving|exporting|printing)\b[^.!?;\n]{0,50}\bfiles?\b|\b(?:do not|don't|dont|never)\s+(?:export|print|write|save|create)\b[^.!?;\n]{0,35}\b(?:files?|outputs?|pdfs?)\b|\b(?:do not|don't|dont|never)\s+send\b[^.!?;\n]{0,30}\bphysical\s+prints?\b/i.test(text)) return true;
  if (/\b(?:preview|preflight|dry[ -]?run)\b/i.test(text)
      && /\b(?:do not|don't|dont|never)\s+create\s+(?:(?:the|an?|any)\s+)?(?:copy|file|output|sheet|view|schedule|element|template|family|type|model\s+change)\b/i.test(text)) return true;
  if (/\bwithout\s+(?:making|applying|committing|saving)\s+(?:any\s+)?changes?\b/i.test(text)) return true;
  if (/\bbefore\b[^.!?\n]{0,100}\b(?:delet|remov|chang|modif|edit|apply|commit|writ|creat|renam|print)/i.test(text)) return true;
  return /\b(?:do not|don't|dont|never)\s+(?:(?:actually|ever)\s+|(?:attempt|try)\s+to\s+)?(?:change|modify|edit|delete|remove|apply|commit|write|create|rename|print|mutate)\b[^.!?;\n]{0,40}\b(?:the\s+)?(?:model|project|document|anything|it|the\s+change)\b/i.test(text);
}

/** Planning a proposed result before a deferred drawing/placement stage is read work. */
export function hasDeferredProposalOnlyFraming(text: string): boolean {
  const deferred = /\b(?:do not|don't|dont|never)\s+(?:draw|place|create|build|tag|route|connect|modify|edit)\b[^.!?;\n]{0,180}\b(?:yet|for now)\b/i.exec(text);
  if (!deferred) return false;
  const proposal = text.slice(0, deferred.index);
  if (!/\b(?:prepare|outline|develop|describe|review|assess)\b[^.!?;\n]{0,100}\b(?:proposed|proposal|plan|options)\b/i.test(proposal)) return false;
  // A separately requested present edit keeps its existing authority. A
  // scoped instruction to defer a different edit is not a global read limit.
  return !/(?:^|[.!?;]\s*|\b(?:then|and|also)\s+)(?:please\s+)?(?:draw|place|create|delete|remove|move|modify|edit|set|update|rename|tag|route|connect)\b/i.test(proposal);
}

/** A requested what-if demonstration is noncommitting, unlike an instruction to delete. */
export function hasNoncommittingChangePreviewRequest(text: string): boolean {
  return /\bshow\s+(?:me\s+)?what\s+would\b[^.!?;\n]{0,180}\bif\s+(?:we|you|I)\s+(?:delet|remov|mov|chang|replac|disconnect)\w*\b/i.test(text)
    && !/(?:^|[.!?;]\s*|\bthen\s+)(?:apply|commit|delete|remove|move|change|replace|do it)\b/i.test(text);
}

export function hasEffectiveNoWriteFraming(text: string): boolean {
  text = withoutScopedFurtherChanges(text);
  const withoutScopedConstraint = text.replace(SCOPED_ANYTHING_ELSE_NO_WRITE, " ");
  const scopedAffirmativeMutation = withoutScopedConstraint !== text
    && hasExplicitMutationVerb(withoutScopedConstraint)
    && !hasPreviewOrGlobalNoWriteFraming(withoutScopedConstraint);
  return hasPreviewOrGlobalNoWriteFraming(text) && !scopedAffirmativeMutation;
}
