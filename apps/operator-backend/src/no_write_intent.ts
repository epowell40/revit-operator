import { hasExplicitMutationVerb } from "./revit_mutation_intent.js";

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
  + "\\s+(?:(?:the|any)\\s+)?(?:schedule|family|model|project|document|files?|changes?|anything|it)\\s*[.!?]*\\s*$",
  "i"
);

const SCOPED_ANYTHING_ELSE_NO_WRITE = new RegExp(
  "\\b(?:do not|don't|dont|never)\\s+"
  + "(?:(?:also|otherwise)\\s+)?"
  + "(?:change|save|modify|edit|configure|reload|create|apply|commit|export|print|delete|remove|write|mutate|rename)"
  + "\\s+anything\\s+else\\b",
  "gi"
);

function hasPreviewOrGlobalNoWriteFraming(text: string): boolean {
  // A leading, sentence-level READ-ONLY declaration is an authoritative turn
  // contract even when a long planning request later names future edits.
  if (/^\s*read[ -]?only(?:\s+only)?\s*[.!:;-]/i.test(text)) return true;
  if (COORDINATED_GLOBAL_NO_WRITE.test(text)) return true;
  if (TERMINAL_DIRECT_NO_WRITE.test(text)) return true;
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

export function hasEffectiveNoWriteFraming(text: string): boolean {
  const withoutScopedConstraint = text.replace(SCOPED_ANYTHING_ELSE_NO_WRITE, " ");
  const scopedAffirmativeMutation = withoutScopedConstraint !== text
    && hasExplicitMutationVerb(withoutScopedConstraint)
    && !hasPreviewOrGlobalNoWriteFraming(withoutScopedConstraint);
  return hasPreviewOrGlobalNoWriteFraming(text) && !scopedAffirmativeMutation;
}
