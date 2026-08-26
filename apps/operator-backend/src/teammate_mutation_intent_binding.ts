type JsonObject = Record<string, unknown>;

export type MutationIntentBindingDecision = {
  applicable: boolean;
  authorized: boolean;
  missing_fields: string[];
  reason: string | null;
  proposed_value: string | null;
};

function objectValue(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1_000_000 || !trimmed.startsWith("{")) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function text(value: unknown, max = 20_000): string {
  return typeof value === "string" && value.length <= max ? value.trim() : "";
}

function comparable(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function textReplacementRoute(toolValue: unknown, pathValue: unknown): boolean {
  const tool = text(toolValue, 200).toLowerCase();
  const path = text(pathValue, 500).toLowerCase();
  return path === "/revit/replace-text-note"
    || tool === "revit_replace_text_note"
    || tool === "revit_replace_textnote";
}

function firstText(body: JsonObject, keys: string[]): string {
  for (const key of keys) {
    const value = text(body[key]);
    if (value) return value;
  }
  return "";
}

function replacementText(body: JsonObject): string {
  return firstText(body, ["newText", "new_text", "replacementText", "replacement_text", "replaceWith", "replace_with"]);
}

function expectedOldText(body: JsonObject): string {
  return firstText(body, ["expectedOldText", "expected_old_text", "oldText", "old_text", "searchPattern", "search_pattern"]);
}

function containsUnresolvedChoice(userText: string): boolean {
  const normalized = comparable(userText);
  return /\beither\b.{1,800}\bor\b/.test(normalized)
    || /\b(?:choose|select|pick)\b.{1,500}\b(?:between|from)\b/.test(normalized)
    || /\b(?:one of|any of)\b/.test(normalized);
}

function placeholderLike(value: string): boolean {
  const normalized = comparable(value).replace(/^["']|["']$/g, "");
  return /^(?:the\s+)?(?:(?:current|correct|approved|latest|new|updated|revised|appropriate)\s+)+(?:issue\s+)?(?:wording|text|language|note|label|name|value)$/.test(normalized)
    || /^(?:same as current|as shown|per current|tbd|to be determined)$/.test(normalized);
}

function explicitlyLiteral(userText: string, proposed: string): boolean {
  const source = comparable(userText);
  const value = comparable(proposed);
  if (!value || !source.includes(value)) return false;
  if (!/\b(?:exact|literal|verbatim)\b/.test(source)) return false;
  return source.includes(`"${value}"`) || source.includes(`'${value}'`)
    || new RegExp(`\\b(?:exact|literal|verbatim)\\b.{0,100}${escapeRegex(value)}`).test(source);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quotedOperand(userText: string, operation: "append" | "prepend"): string | null {
  const source = userText.normalize("NFKC").replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  const match = source.match(new RegExp(`\\b${operation}\\b[^\\r\\n]{0,100}?["']([^"']{1,500})["']`, "i"));
  return match?.[1] ?? null;
}

function deterministicTransformationAuthorized(userText: string, oldValue: string, proposed: string): boolean {
  if (!oldValue) return false;
  const append = quotedOperand(userText, "append");
  if (append !== null && comparable(proposed) === comparable(`${oldValue}${append}`)) return true;
  const prepend = quotedOperand(userText, "prepend");
  if (prepend !== null && comparable(proposed) === comparable(`${prepend}${oldValue}`)) return true;
  const source = comparable(userText);
  if (/\b(?:convert|change|make|transform)\b.{0,100}\b(?:upper ?case|all caps)\b/.test(source)
      && proposed === oldValue.toLocaleUpperCase("en-US")) return true;
  if (/\b(?:convert|change|make|transform)\b.{0,100}\blower ?case\b/.test(source)
      && proposed === oldValue.toLocaleLowerCase("en-US")) return true;
  return false;
}

function replacementIsAuthenticated(userText: string, proposed: string, oldValue: string): boolean {
  const source = comparable(userText);
  const value = comparable(proposed);
  if (!source || !value || containsUnresolvedChoice(userText)) return false;
  if (placeholderLike(proposed) && !explicitlyLiteral(userText, proposed)) return false;
  if (source.includes(value)) return true;
  return deterministicTransformationAuthorized(userText, oldValue, proposed);
}

export function mutationIntentBindingDecision(input: {
  tool: unknown;
  path: unknown;
  body: unknown;
  authoritative_user_text: string;
}): MutationIntentBindingDecision {
  if (!textReplacementRoute(input.tool, input.path)) {
    return { applicable: false, authorized: true, missing_fields: [], reason: null, proposed_value: null };
  }
  const body = objectValue(input.body);
  const proposed = replacementText(body);
  if (!proposed || !replacementIsAuthenticated(input.authoritative_user_text, proposed, expectedOldText(body))) {
    return {
      applicable: true,
      authorized: false,
      missing_fields: ["replacement_text"],
      reason: containsUnresolvedChoice(input.authoritative_user_text)
        ? "desired_postcondition_choice_requires_authenticated_user_input"
        : "desired_postcondition_missing_authenticated_user_input",
      proposed_value: proposed || null
    };
  }
  return { applicable: true, authorized: true, missing_fields: [], reason: null, proposed_value: proposed };
}

export function mutationIntentBlockReason(
  effect: string,
  tool: unknown,
  body: unknown,
  authoritativeUserText: string
): string | null {
  if (effect !== "preview" && effect !== "apply") return null;
  const decision = mutationIntentBindingDecision({
    tool,
    path: tool,
    body,
    authoritative_user_text: authoritativeUserText
  });
  return decision.applicable && !decision.authorized ? decision.reason : null;
}

export function missingOpaqueMutationInputs(userText: string): string[] {
  const source = comparable(userText);
  const replacementRequest = /\b(?:replace|update|correct|revise|change)\b.{0,180}\b(?:text\s*note|note|annotation|wording|text)\b/.test(source)
    || /\b(?:text\s*note|note|annotation)\b.{0,180}\b(?:replace|update|correct|revise|change)\b/.test(source);
  if (!replacementRequest) return [];
  if (containsUnresolvedChoice(userText)) return ["replacement_text"];
  const placeholder = source.match(/\b(?:with|to|using)\s+((?:(?:the\s+)?(?:current|correct|approved|latest|new|updated|revised|appropriate)\s+)+(?:issue\s+)?(?:wording|text|language|note|label|name|value))\b/);
  if (placeholder && !explicitlyLiteral(userText, placeholder[1] || "")) return ["replacement_text"];
  return [];
}
