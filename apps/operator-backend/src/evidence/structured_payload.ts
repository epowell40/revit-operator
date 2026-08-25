import { isDeepStrictEqual } from "node:util";

const MAX_STRUCTURED_TEXT_BYTES = 4 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseBoundedStructuredJson(value: unknown): unknown | null {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("[")) || Buffer.byteLength(text, "utf8") > MAX_STRUCTURED_TEXT_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function extractMcpStructuredPayload(value: unknown): { payload: unknown; source_path: string } | null {
  const row = record(value);
  if (!row || row.isError === true) return null;
  const candidates: Array<{ payload: unknown; source_path: string }> = [];
  if (Object.prototype.hasOwnProperty.call(row, "structuredContent")) {
    const payload = parseBoundedStructuredJson(row.structuredContent);
    if (payload) candidates.push({ payload, source_path: "structuredContent" });
  }
  if (Array.isArray(row.content)) {
    const textItems = row.content
      .map((item, index) => ({ item: record(item), index }))
      .filter(candidate => candidate.item?.type === "text" && typeof candidate.item.text === "string");
    if (textItems.length > 1) return null;
    if (textItems.length === 1) {
      const payload = parseBoundedStructuredJson(textItems[0]!.item!.text);
      if (payload) candidates.push({ payload, source_path: `content[${textItems[0]!.index}].text` });
    }
  }
  if (candidates.length === 0) return null;
  if (!candidates.every(candidate => isDeepStrictEqual(candidate.payload, candidates[0]!.payload))) return null;
  return candidates[0]!;
}
