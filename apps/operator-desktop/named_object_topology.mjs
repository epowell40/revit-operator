// Shared whole-request routing grammar; a miss selects the ordinary owner.
// This never grants execution authority.
export function namedObjectTopologyIdentity(userText) {
  if (typeof userText !== "string") return null;
  const text = userText.trim();
  if (!text || text.length > 4000) return null;
  // Negative write constraints are common in read-only requests and must not be
  // mistaken for requested mutations. Any remaining write verb fails closed.
  const mutationCheck = text.replace(
    /\b(?:do\s+not|don't|dont|without)\s+(?:change|modify|edit|update|delete|remove|create|add|move|write)(?:\s+(?:anything|the\s+model|the\s+revit\s+model))?/gi,
    ""
  );
  if (/\b(?:please\s+)?(?:change|modify|edit|update|delete|remove|create|add|move|replace|resize|reroute|write)\b/i.test(mutationCheck)) return null;
  if (/^\s*(?:please\s+)?(?:connect|disconnect)\b/i.test(mutationCheck) || /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:connect|disconnect)\b/i.test(mutationCheck)) return null;

  const patterns = [
    /\bwhat\s+(?:is|are)\s+(?:the\s+)?(.{2,128}?)\s+connected\s+to\b/i,
    /\bwhat\s+(?:does|do)\s+(?:the\s+)?(.{2,128}?)\s+connect\s+to\b/i,
    /\b(?:which|what)\s+(?:pipe\s+|duct\s+|mep\s+|electrical\s+|mechanical\s+)?systems?\s+(?:is|are)\s+(?:the\s+)?(.{2,128}?)\s+connected\s+to\b/i,
    /\b(?:show|summarize|inspect|trace)\s+(?:the\s+)?(.{2,128}?)\s+(?:connectors?|connections?|topology)\b/i,
    /\b(?:are|is)\s+(?:any\s+)?(?:the\s+)?(.{2,128}?)\s+(?:unconnected|disconnected)\b/i
  ];
  const question = text.replace(/^(?:please\s+|(?:can|could|would)\s+you\s+(?:please\s+)?)/i, "");
  const match = patterns.map(pattern => pattern.exec(question)).find(candidate => candidate !== null && candidate.index === 0);
  if (!match) return null;
  // This shortcut owns the whole assignment. A matching inspection phrase
  // inside construction instructions must not discard the rest of the work.
  // Accept only a complete topology question plus narrow reporting/read-only
  // clauses; unfamiliar wording belongs to the ordinary owner, not a guessed
  // read-only workflow. This is routing, never execution authorization.
  const suffix = question.slice(match[0].length).trim();
  const clauses = suffix.split(/[.!?]+/).map(clause => clause.trim()).filter(Boolean);
  if (clauses.some(clause => !/^(?:do\s+not|don't|dont)\s+(?:change|modify|edit|update|delete|remove|create|add|move|write)\s+(?:anything|the\s+(?:revit\s+)?model)$/i.test(clause)
    && !/^summarize\s+the\s+(?:(?:pipe|duct|mep|electrical|mechanical)\s+)?systems?(?:\s+and\s+flag\s+any\s+that\s+(?:aren't|are\s+not)\s+connected)?$/i.test(clause))) return null;
  const identity = (match[1] ?? "")
    .replace(/^\s*(?:all|each|every|any)\s+/i, "")
    .replace(/[\s,;:.!?]+$/g, "")
    .trim();
  if (identity.length < 2 || identity.length > 128 || /^(?:it|they|them|these|those|this|that|anything|everything|something)$/i.test(identity)) return null;
  if (/[.!?;\r\n]/.test(identity) || /\b(?:and|then|also)\b/i.test(identity)) return null;

  return identity.toLocaleLowerCase();
}

