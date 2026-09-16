import type { EvidenceRefV1 } from "./evidence_ref.js";
import { extractMcpStructuredPayload } from "./structured_payload.js";

export type ToolDocumentationProjection = {
  kind: "tool" | "catalog";
  completion_eligible: false;
  tools: Array<Record<string, unknown>>;
  returned_tools: number;
  total_tools: number;
  omitted_paths: string[];
  complete: boolean;
};

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const fields = ["method", "path", "title", "risk", "required_fields", "request_schema", "optional_fields", "enums", "units", "notes", "description", "examples"];

/** A navigation aid from the exact retained tool documentation, never a native
 * task result. Omitted fields remain explicit and independently retrievable. */
export function projectToolDocumentation(ref: EvidenceRefV1, raw: unknown, budget: number): ToolDocumentationProjection | null {
  const catalog = ref.source === "assignment_kernel_v2:revit_search_tools";
  if ((!catalog && ref.source !== "assignment_kernel_v2:revit_tool_doc") || ref.trust_level !== "host_observed" || budget < 512) return null;
  const outer = record(raw);
  if (!outer || outer.isError === true) return null;
  const payload = record(Array.isArray(outer.content) || "structuredContent" in outer ? extractMcpStructuredPayload(raw)?.payload : raw);
  if (!payload) return null;
  const rows = catalog ? payload.matches : [payload];
  if (!Array.isArray(rows) || rows.length > 100 || (catalog ? payload.source !== "/revit/tool-registry" : payload.version !== "operator.tool_doc.v1")) return null;
  if (rows.some(value => {
    const tool = record(value);
    return !tool || !["GET", "POST"].includes(String(tool.method)) || typeof tool.path !== "string"
      || !/^\/revit\/[a-z0-9/-]+$/.test(tool.path) || !Array.isArray(tool.required_fields)
      || tool.required_fields.some(v => typeof v !== "string");
  })) return null;
  const result: ToolDocumentationProjection = { kind: catalog ? "catalog" : "tool", completion_eligible: false,
    tools: [], returned_tools: 0, total_tools: rows.length, omitted_paths: [], complete: false };
  for (let index = 0; index < rows.length; index++) {
    const tool = record(rows[index])!;
    const prefix = catalog ? `payload.matches[${index}]` : "payload";
    const selected: Record<string, unknown> = { method: tool.method, path: tool.path, required_fields: tool.required_fields };
    const omitted: string[] = Object.keys(tool).filter(field => !fields.includes(field)).map(field => `${prefix}.${field}`);
    for (const field of fields.filter(key => !(key in selected))) {
      if (!(field in tool)) { omitted.push(`${prefix}.${field}`); continue; }
      // Search returns tool identity and input names first; exact schemas are
      // fetched with tool_doc instead of flooding the catalog with each schema.
      if (catalog && ["request_schema", "examples", "notes", "enums", "units", "description"].includes(field)) {
        omitted.push(`${prefix}.${field}`); continue;
      }
      const candidate = { ...result, tools: [...result.tools, { ...selected, [field]: tool[field] }],
        returned_tools: result.tools.length + 1, omitted_paths: [...result.omitted_paths, ...omitted] };
      // Reserve space for omission paths that are added below.
      if (bytes(candidate) + 512 <= budget) selected[field] = tool[field];
      else omitted.push(`${prefix}.${field}`);
    }
    const candidate = { ...result, tools: [...result.tools, selected], returned_tools: result.tools.length + 1,
      omitted_paths: [...result.omitted_paths, ...omitted] };
    if (bytes(candidate) + 128 > budget) { result.omitted_paths.push(`${prefix} and later rows`); break; }
    Object.assign(result, candidate);
  }
  result.complete = result.returned_tools === rows.length && result.omitted_paths.length === 0;
  return result.tools.length > 0 && bytes(result) <= budget ? result : null;
}
