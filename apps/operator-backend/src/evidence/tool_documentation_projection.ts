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
// Registry callers can explicitly request full schemas. Keep each schema atomic
// and prioritize it ahead of prose; a partial schema is not a usable contract.
const registryFields = ["method", "path", "required_fields", "request_schema", "optional_fields", "title", "risk", "enums", "units", "notes", "description", "examples"];

/** Documentation annotations are not validation constraints. Walk only JSON
 * Schema locations: an enum/default or a property named description is data,
 * not permission to rewrite it. Unknown keywords remain byte-exact. */
function schemaWithoutAnnotations(schema: unknown, prefix: string,
  annotations: Array<{path:string;text?:string;objectSchema:boolean;requiredCount:number}>): unknown {
  if (Array.isArray(schema)) return schema.map((s,i)=>schemaWithoutAnnotations(s,`${prefix}[${i}]`,annotations));
  const node=record(schema); if (!node) return schema;
  const result:Record<string,unknown>={};
  for(const [key,value] of Object.entries(node)) {
    if(['description','title','$comment','examples'].includes(key)) {
      annotations.push({path:`${prefix}.${key}`,text:typeof value==='string'?value:undefined,objectSchema:node.type==='object',
        requiredCount:Array.isArray(node.required)?node.required.length:0});
    } else if(['properties','patternProperties','definitions','$defs','dependentSchemas'].includes(key)&&record(value)) {
      result[key]=Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([name,item])=>
        [name,schemaWithoutAnnotations(item,`${prefix}.${key}.${name}`,annotations)]));
    } else if(['items','additionalItems','additionalProperties','unevaluatedProperties','propertyNames','contains',
      'not','if','then','else','unevaluatedItems','contentSchema','allOf','anyOf','oneOf','prefixItems'].includes(key)) {
      result[key]=schemaWithoutAnnotations(value,`${prefix}.${key}`,annotations);
    } else result[key]=value;
  }
  return result;
}

/** Exact current MCP catalog descriptions have a different producer shape
 * from HTTP tool-registry docs. Only their dedicated host-owned producer may
 * use this projection. It grants no execution/native/result authority. */
function projectMcpContract(ref:EvidenceRefV1,raw:unknown,budget:number):ToolDocumentationProjection|null {
  if(ref.source!=='assignment_kernel_v2:desktop_native_tool_contract'||ref.trust_level!=='host_observed')return null;
  const payload=record(raw),tool=record(payload?.tool),schema=record(tool?.inputSchema),invocation=record(payload?.invocation);
  if(payload?.schema!=='operator.desktop-native-tool-contract.v1'||payload.completion_eligible!==false
    ||payload.authorizationGranted!==false||!tool||typeof tool.name!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,255}$/.test(tool.name)
    ||typeof tool.description!=='string'||!schema||schema.type!=='object'||!record(schema.properties)
    ||schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.some(v=>typeof v!=='string'))
    ||!invocation||invocation.tool!=='native__invoke'||invocation.name!==tool.name)return null;
  const annotations:Array<{path:string;text?:string;objectSchema:boolean;requiredCount:number}>=[];
  const requestSchema=schemaWithoutAnnotations(schema,'payload.tool.inputSchema',annotations);
  const selected:Record<string,unknown>={name:tool.name,invocation:payload.invocation,
    request_schema:requestSchema,schema_annotations_omitted:annotations.length>0,parameter_guidance:[]};
  const result:ToolDocumentationProjection={kind:'tool',completion_eligible:false,tools:[selected],returned_tools:1,total_tools:1,
    omitted_paths:['payload.tool.description',...annotations.map(a=>a.path),
      ...Object.keys(tool).filter(k=>!['name','inputSchema','description'].includes(k)).map(k=>'payload.tool.'+k)],complete:false};
  if(bytes(result)>budget) {
    // Never present half a schema as a whole contract. Identity and explicit
    // missing paths remain useful under tighter caller budgets.
    delete selected.request_schema;
    result.omitted_paths=result.omitted_paths.filter(p=>!p.startsWith('payload.tool.inputSchema.'));
    result.omitted_paths.push('payload.tool.inputSchema');
  }
  if(bytes(result)>budget)return null;
  // Prefer small entry objects before multi-field recovery protocols, then
  // concise instructions before verbose SDK examples.
  // Every excerpt is a complete original annotation, never generated guidance.
  for(const annotation of annotations.filter(a=>a.text&&a.path.endsWith('.description'))
    .sort((a,b)=>Number(b.objectSchema)-Number(a.objectSchema)||a.requiredCount-b.requiredCount||a.text!.length-b.text!.length)) {
    const candidate={...result,tools:[{...selected,parameter_guidance:[...(selected.parameter_guidance as unknown[]),
      {path:annotation.path,text:annotation.text}]}],omitted_paths:result.omitted_paths.filter(p=>p!==annotation.path)};
    if(bytes(candidate)<=budget){selected.parameter_guidance=(candidate.tools[0] as any).parameter_guidance;result.omitted_paths=candidate.omitted_paths;}
  }
  return result;
}

/** A navigation aid from the exact retained tool documentation, never a native
 * task result. Omitted fields remain explicit and independently retrievable. */
export function projectToolDocumentation(ref: EvidenceRefV1, raw: unknown, budget: number): ToolDocumentationProjection | null {
  if(ref.source==='assignment_kernel_v2:desktop_native_tool_contract')return projectMcpContract(ref,raw,budget);
  const search = ref.source === "assignment_kernel_v2:revit_search_tools";
  const registry = ref.source === "assignment_kernel_v2:revit_tool_registry";
  const catalog = search || registry;
  if ((!catalog && ref.source !== "assignment_kernel_v2:revit_tool_doc") || ref.trust_level !== "host_observed" || budget < 512) return null;
  const outer = record(raw);
  if (!outer || outer.isError === true) return null;
  const payload = record(Array.isArray(outer.content) || "structuredContent" in outer ? extractMcpStructuredPayload(raw)?.payload : raw);
  if (!payload) return null;
  const rows = registry ? payload.items : search ? payload.matches : [payload];
  if (!Array.isArray(rows) || rows.length > 100 || (registry ? payload.version !== "operator.tool_registry.v1"
    : search ? payload.source !== "/revit/tool-registry" : payload.version !== "operator.tool_doc.v1")) return null;
  if (rows.some(value => {
    const tool = record(value);
    return !tool || !["GET", "POST"].includes(String(tool.method)) || typeof tool.path !== "string"
      || !/^\/revit\/[a-z0-9/-]+$/.test(tool.path) || (Object.hasOwn(tool, "required_fields")
        && (!Array.isArray(tool.required_fields) || tool.required_fields.some(v => typeof v !== "string")));
  })) return null;
  const result: ToolDocumentationProjection = { kind: catalog ? "catalog" : "tool", completion_eligible: false,
    tools: [], returned_tools: 0, total_tools: rows.length, omitted_paths: [], complete: false };
  for (let index = 0; index < rows.length; index++) {
    const tool = record(rows[index])!;
    const prefix = registry ? `payload.items[${index}]` : search ? `payload.matches[${index}]` : "payload";
    const selected: Record<string, unknown> = { method: tool.method, path: tool.path,
      ...(Object.hasOwn(tool, "required_fields") ? { required_fields: tool.required_fields } : {}) };
    const omitted: string[] = Object.keys(tool).filter(field => !fields.includes(field)).map(field => `${prefix}.${field}`);
    for (const field of (registry ? registryFields : fields).filter(key => !(key in selected))) {
      if (!(field in tool)) { omitted.push(`${prefix}.${field}`); continue; }
      // Preserve ranked identities and input names before spending remaining
      // search space on atomic schemas below. Prose stays independently readable.
      if (search && ["request_schema", "examples", "notes", "enums", "units", "description"].includes(field)) {
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
  if (search) {
    // includeSchemas callers already paid to retrieve these exact contracts.
    // Enrich only after the existing catalog has been packed, so a large schema
    // cannot displace another ranked tool. Never truncate or synthesize a schema.
    for (let index = 0; index < result.tools.length; index++) {
      const schema = record(record(rows[index])!.request_schema);
      if (!schema) continue;
      const candidate = { ...result,
        tools: result.tools.map((tool, i) => i === index ? { ...tool, request_schema: schema } : tool),
        omitted_paths: result.omitted_paths.filter(p => p !== `payload.matches[${index}].request_schema`) };
      if (bytes(candidate) <= budget) Object.assign(result, candidate);
    }
  }
  result.complete = result.returned_tools === rows.length && result.omitted_paths.length === 0;
  return (result.tools.length > 0 || (registry && rows.length === 0)) && bytes(result) <= budget ? result : null;
}
