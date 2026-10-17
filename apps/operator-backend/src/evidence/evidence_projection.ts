import { EVIDENCE_PROJECTION_SCHEMA, type EvidenceProjectionV1, type EvidenceRefV1 } from "./evidence_ref.js";
import { projectToolDocumentation } from "./tool_documentation_projection.js";
import { projectConnectorGraph } from "./connector_graph_projection.js";
import { projectParameterTable } from "./parameter_table_projection.js";
import { projectScopedHelperFindings } from "./scoped_helper_projection.js";
import { viewOwnedDetailingSummaryV2 } from "../verification/view_owned_detailing_v2.js";
import { extractMcpStructuredPayload, parseBoundedStructuredJson } from "./structured_payload.js";
import {
  evidenceTargetIdentityValuesV1,
  isEvidenceTargetIdentityFieldV1
} from "@revitoperator/assignment-kernel-v2-contracts";

const COUNT_KEY = /(?:^|_)(?:count|total|length|matched|created|updated|deleted|failed|succeeded)$/i;
const ACCEPTANCE_KEY = /(?:^|_)(?:id|name|number|value|status|state|result|effect_state|before_hash|after_hash|sha256|hash|level|host|side|system|orientation|circuit|category|type|exists|is_file|size_bytes|last_write_time_utc|path)$/i;
const DIAGNOSTIC_KEY = /(?:error|warning|diagnostic|failure|reason|message)/i;
const STRUCTURED_TEXT_KEY = /^(?:text|output|result_json|structuredContent)$/i;
const IDENTITY_ARRAY_KEY = /^(?:items|elements|results)$/i;
const MAX_IDENTITY_ROWS = 20_000;
const MAX_IDENTITY_GROUPS = 18;

type IdentityInventory = {
  path: string;
  rows: number;
  identityRows: number;
  total: number;
  complete: boolean;
  groupCount: number;
  familyType: Array<[string, number]>;
  categories: Array<[string, number]>;
  groupsTruncated: boolean;
};

function boundedText(value: unknown, max = 240): string {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function scalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedText(value);
  return undefined;
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function identityText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function finiteCount(row: Record<string, unknown>): number | null {
  for (const key of ["count", "total", "totalMatches", "returned"]) {
    const value = row[key];
    if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  }
  return null;
}

function sortedCounts(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function identityInventories(row: Record<string, unknown>, path: string): IdentityInventory[] {
  const inventories: IdentityInventory[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (!IDENTITY_ARRAY_KEY.test(key) || !Array.isArray(value) || value.length === 0 || value.length > MAX_IDENTITY_ROWS) continue;
    const familyType = new Map<string, number>();
    const categories = new Map<string, number>();
    const elementIdentities = new Set<string>();
    let duplicateIdentity = false;
    let identityRows = 0;
    for (const valueRow of value) {
      const item = safeRecord(valueRow);
      if (!item) continue;
      const id = item.elementId ?? item.element_id ?? item.id ?? item.uniqueId;
      if ((typeof id === "string" && id.trim()) || (typeof id === "number" && Number.isSafeInteger(id))) {
        const identity = String(id).trim();
        duplicateIdentity ||= elementIdentities.has(identity);
        elementIdentities.add(identity);
      }
      const family = identityText(item.familyName ?? item.family_name ?? item.family);
      const type = identityText(item.typeName ?? item.type_name ?? item.type);
      const category = identityText(item.category ?? item.categoryName ?? item.category_name ?? item.builtInCategory);
      if (!family && !type && !category) continue;
      identityRows += 1;
      if (family || type) {
        // Group by the exact tuple. Truncation and delimiter collisions must
        // never combine distinct families or types into one count.
        const identity = JSON.stringify([family, type]);
        familyType.set(identity, (familyType.get(identity) ?? 0) + 1);
      }
      if (category) categories.set(category, (categories.get(category) ?? 0) + 1);
    }
    if (identityRows === 0) continue;
    const declaredTotal = finiteCount(row);
    const explicitlyIncomplete = row.itemsComplete === false || row.truncated === true || row.scanCapReached === true || row.hasMore === true;
    const explicitlyComplete = row.itemsComplete === true
      || (row.truncated === false && row.scanCapReached !== true && row.hasMore !== true);
    const total = declaredTotal ?? value.length;
    const complete = !duplicateIdentity && !explicitlyIncomplete && explicitlyComplete && total === value.length && identityRows === value.length;
    const allFamilyType = sortedCounts(familyType).map(([identity, count]): [string, number] => {
      const [family, type] = JSON.parse(identity) as [string | null, string | null];
      return [family && type ? `${family} | ${type}` : family ?? type!, count];
    });
    const labels = new Map<string, number>();
    for (const [label] of allFamilyType) labels.set(label, (labels.get(label) ?? 0) + 1);
    const presentableFamilyType = allFamilyType.filter(([label]) => `inventory.family_type::${label}`.length <= 240 && labels.get(label) === 1);
    const allCategories = sortedCounts(categories);
    const presentableCategories = allCategories.filter(([label]) => label.length <= 220);
    inventories.push({
      path: path === "$" ? key : `${path}.${key}`,
      rows: value.length,
      identityRows,
      total,
      complete,
      groupCount: allFamilyType.length,
      familyType: presentableFamilyType.slice(0, MAX_IDENTITY_GROUPS),
      categories: presentableCategories.slice(0, Math.max(0, MAX_IDENTITY_GROUPS - Math.min(MAX_IDENTITY_GROUPS, presentableFamilyType.length))),
      groupsTruncated: allFamilyType.length + allCategories.length > MAX_IDENTITY_GROUPS
        || presentableFamilyType.length !== allFamilyType.length || presentableCategories.length !== allCategories.length
    });
  }
  return inventories;
}

function pushTarget(out: string[], value: unknown): void {
  for (const identity of evidenceTargetIdentityValuesV1(value)) {
    const text = boundedText(identity, 120);
    if (!out.includes(text) && out.length < 32) out.push(text);
  }
}

export function extractDeterministicEvidenceFacts(raw: unknown): {
  counts: Record<string, number>;
  facts: Record<string, string | number | boolean | null>;
  targets: string[];
  diagnostics: string[];
  beforeHash: string | null;
  afterHash: string | null;
  effectState: "none" | "unknown" | "applied" | null;
  omitted: boolean;
} {
  const counts: Record<string, number> = {};
  const facts: Record<string, string | number | boolean | null> = {};
  const targets: string[] = [];
  const diagnostics: string[] = [];
  let visited = 0;
  let omitted = false;
  let beforeHash: string | null = null;
  let afterHash: string | null = null;
  let effectState: "none" | "unknown" | "applied" | null = null;
  let bestInventory: IdentityInventory | null = null;
  const queue: Array<{ value: unknown; path: string; depth: number; diagnosticArray?: boolean }> = [{ value: raw, path: "$", depth: 0 }];
  function pushDiagnostic(path: string, value: unknown): void {
    const text = scalar(value);
    if (text === undefined) return;
    if (diagnostics.length >= 12) { omitted = true; return; }
    omitted ||= typeof value === "string" && value.trim().length > 200;
    diagnostics.push(`${path}: ${boundedText(text, 200)}`);
  }
  const rootRecord = safeRecord(raw);
  // Dynamic runtime receipts are embedded JSON strings, not ordinary nested
  // objects. Preserve their reported settlement before bulky worker/snapshot
  // data consumes the fact budget. This projection never authenticates them or
  // promotes the evidence reference's trust level.
  const dynamicEvidence = safeRecord(rootRecord?.evidence);
  for (const [field, schema] of [["previewReceipt", "dynamic-revit-preview-receipt/v0"],
    ["applyReceipt", "dynamic-revit-apply-receipt/v1"]] as const) {
    const receipt = typeof dynamicEvidence?.[field] === "string"
      ? safeRecord(parseBoundedStructuredJson(dynamicEvidence[field]))
      : safeRecord(dynamicEvidence?.[field]);
    if (receipt?.schema !== schema) continue;
    for (const key of ["schema", "ok", "outcome", "rollback_status", "rollback_truth",
      "preview_id", "graph_hash", "document_fingerprint", "document_session_id", "retry_permitted"]) {
      const value = scalar(receipt[key]);
      if (value !== undefined) facts[`evidence.${field}.${key}`] = value;
    }
    const idsKey = field === "applyReceipt" ? "changed_element_ids" : "projected_changed_element_ids";
    if (Array.isArray(receipt[idsKey])) counts[`evidence.${field}.${idsKey}.length`] = receipt[idsKey].length;
    if (Number.isSafeInteger(receipt.operation_count)) counts[`evidence.${field}.operation_count`] = receipt.operation_count as number;
  }
  const rootLooksLikeMcpEnvelope = Boolean(rootRecord && (Array.isArray(rootRecord.content)
    || Object.prototype.hasOwnProperty.call(rootRecord, "structuredContent")));
  const structuredPayload = rootLooksLikeMcpEnvelope ? extractMcpStructuredPayload(raw) : null;
  if (structuredPayload) queue.push({ value: structuredPayload.payload, path: "payload", depth: 1 });
  const seen = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (++visited > 1_500) { omitted = true; break; }
    if (current.value && typeof current.value === "object") {
      if (seen.has(current.value as object)) { omitted = true; continue; }
      seen.add(current.value as object);
    }
    if (Array.isArray(current.value)) {
      if (Object.keys(counts).length < 24) counts[`${current.path}.length`] = current.value.length;
      if (current.depth >= 5) { omitted ||= current.value.length > 0; continue; }
      for (let i = 0; i < Math.min(current.value.length, 128); i++) {
        queue.push({ value: current.value[i], path: `${current.path}[${i}]`, depth: current.depth + 1,
          diagnosticArray: current.diagnosticArray });
      }
      omitted ||= current.value.length > 128;
      continue;
    }
    const row = safeRecord(current.value);
    if (!row) {
      // Warning/error arrays commonly contain scalar messages. Keep their
      // bounded text in model feedback; ordinary arrays and unrelated fields
      // remain unselected. Presentation does not authenticate the message.
      if (current.diagnosticArray) pushDiagnostic(current.path, current.value);
      continue;
    }
    if (!(rootLooksLikeMcpEnvelope && current.path === "$")) {
      for (const inventory of identityInventories(row, current.path)) {
        if (!bestInventory || inventory.identityRows > bestInventory.identityRows
          || (inventory.identityRows === bestInventory.identityRows && inventory.rows > bestInventory.rows)
          || (inventory.identityRows === bestInventory.identityRows && inventory.rows === bestInventory.rows
            && inventory.path.localeCompare(bestInventory.path) < 0)) bestInventory = inventory;
      }
    }
    if (current.depth >= 5) { omitted ||= Object.keys(row).length > 0; continue; }
    for (const [key, value] of Object.entries(row)) {
      const path = current.path === "$" ? key : `${current.path}.${key}`;
      const rootEnvelopePayloadField = rootLooksLikeMcpEnvelope && current.path === "$"
        && value !== null && typeof value === "object";
      const valueScalar = scalar(value);
      if (COUNT_KEY.test(key) && typeof value === "number" && Number.isFinite(value) && Object.keys(counts).length < 24) counts[path] = value;
      if (isEvidenceTargetIdentityFieldV1(key)) pushTarget(targets, value);
      if (/^before_?(?:sha256|hash)$/i.test(key) && typeof value === "string") beforeHash = boundedText(value, 128);
      if (/^after_?(?:sha256|hash)$/i.test(key) && typeof value === "string") afterHash = boundedText(value, 128);
      if (/^(?:effect_?)?state$/i.test(key) && (value === "none" || value === "unknown" || value === "applied")) effectState = value;
      if (valueScalar !== undefined && ACCEPTANCE_KEY.test(key) && Object.keys(facts).length < 48) facts[path] = valueScalar;
      if (valueScalar !== undefined && DIAGNOSTIC_KEY.test(key)) pushDiagnostic(path, value);
      if (STRUCTURED_TEXT_KEY.test(key) && !rootLooksLikeMcpEnvelope) {
        const structured = parseBoundedStructuredJson(value);
        if (structured) queue.push({ value: structured, path: `${path}.$json`, depth: current.depth + 1 });
      }
      if (value && typeof value === "object" && !rootEnvelopePayloadField) queue.push({ value, path, depth: current.depth + 1,
        diagnosticArray: Array.isArray(value) && DIAGNOSTIC_KEY.test(key) });
    }
  }
  if (bestInventory) {
    counts["inventory.total"] = bestInventory.total;
    counts["inventory.identity_rows"] = bestInventory.identityRows;
    counts["inventory.group_count"] = bestInventory.groupCount;
    for (const [label, count] of bestInventory.familyType) counts[`inventory.family_type::${label}`] = count;
    for (const [label, count] of bestInventory.categories) counts[`inventory.category::${label}`] = count;
    facts["inventory.complete"] = bestInventory.complete;
    facts["inventory.source_path"] = bestInventory.path;
    facts["inventory.grouping"] = "family_name + type_name";
    facts["inventory.groups_truncated"] = bestInventory.groupsTruncated;
    omitted ||= bestInventory.groupsTruncated;
  }
  const prioritizedCounts = Object.fromEntries([
    ...Object.entries(counts).filter(([key]) => key.startsWith("inventory.")),
    ...Object.entries(counts).filter(([key]) => !key.startsWith("inventory."))
  ]);
  const prioritizedFacts = Object.fromEntries([
    ...Object.entries(facts).filter(([key]) => key.startsWith("inventory.")),
    ...Object.entries(facts).filter(([key]) => !key.startsWith("inventory."))
  ]);
  return { counts: prioritizedCounts, facts: prioritizedFacts, targets, diagnostics, beforeHash, afterHash, effectState, omitted };
}

function projectionBytes(value: Omit<EvidenceProjectionV1, "projected_bytes">): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") + 24;
}

function completeElementIdInventory(raw: unknown): Record<string, unknown> | null {
  const row = safeRecord(raw);
  if (!row || row.status !== "Ok" || !safeRecord(row.scope)
      || !Array.isArray(row.elementIds) || row.elementIds.length > 5000
      || row.count !== row.elementIds.length || row.truncated !== false
      || row.scanCapReached !== false || row.identityExpansionScanCapReached !== false
      || row.elementIds.some(id => !Number.isSafeInteger(id) || id <= 0)
      || new Set(row.elementIds).size !== row.elementIds.length) return null;
  // This is an exact ID-list presentation, not full element detail or proof of
  // project-wide coverage. Retain every native scope/filter fact so a bounded
  // view, text, or family query cannot be mistaken for a whole-model inventory.
  const { items, elementIds, canonical_attempt_settlement, ...scopeAndFilters } = row;
  return { ...scopeAndFilters, schema: "revit-operator.element-id-inventory-summary/v1",
    elementIds, ids_complete: true, items_omitted: true };
}

export function projectEvidence(ref: EvidenceRefV1, raw: unknown, maxBytes = 8_192): EvidenceProjectionV1 {
  const extracted = extractDeterministicEvidenceFacts(raw);
  const base = {
    schema: EVIDENCE_PROJECTION_SCHEMA,
    evidence_id: ref.evidence_id,
    content_hash: ref.content_hash,
    byte_count: ref.byte_count,
    media_type: ref.media_type,
    source: ref.source,
    trust_level: ref.trust_level,
    effect_state: extracted.effectState,
    assignment_id: ref.assignment_id,
    run_id: ref.run_id,
    attempt_id: ref.attempt_id,
    generation: ref.generation,
    target_scope: [...new Set([...ref.target_scope, ...extracted.targets])].slice(0, 32),
    key_counts: extracted.counts,
    key_facts: { ...ref.key_typed_facts, ...extracted.facts },
    before_hash: extracted.beforeHash,
    after_hash: extracted.afterHash,
    diagnostics: extracted.diagnostics,
    artifact_ref: ref.evidence_id,
    verification_relevance: ref.verification_relevance,
    additional_evidence: true,
    retrieval: {
      tool_name: "operator_retrieve_evidence",
      selector_forms: [
        "EXACTLY ONE selector is required",
        "fields",
        "itemRange (optional fields selects columns per row; row_index, values, missing_fields; complete remains artifact-wide; pagination.source_rows_exhausted=true means no more source rows)",
        "textRange",
        "targetSubset (exact reviewed target identities only)",
        "image",
        "JSON payload fields: payload.<field>",
        "JSON payload arrays: payload.<array>",
        "inventory.* summary fields; pages: pagination.next_start; absent fields: missing_fields"
      ],
      max_bytes: 1_048_576
    },
    truncated: extracted.omitted
  } satisfies Omit<EvidenceProjectionV1, "projected_bytes">;
  let candidate: Omit<EvidenceProjectionV1, "projected_bytes"> = base;
  const documentationBase = { ...base, key_counts: {}, key_facts: {}, target_scope: [], effect_state: null };
  const documentation = projectToolDocumentation(ref, raw, maxBytes - projectionBytes(documentationBase) - 64);
  if (documentation) candidate = { ...documentationBase, tool_documentation: documentation, truncated: !documentation.complete };
  // Connector coverage replaces generic inventory heuristics in this recognized
  // presentation. Reserve the complete outer projection within the same budget.
  const connectorBase = { ...base, key_counts: {}, key_facts: {}, target_scope: ref.target_scope };
  const connectorGraph = projectConnectorGraph(ref, raw, maxBytes - projectionBytes(connectorBase) - 32);
  if (connectorGraph) {
    const expanded = { ...connectorBase, connector_graph: connectorGraph, truncated: !connectorGraph.lists_complete || !connectorGraph.coverage.rows_complete };
    candidate = projectionBytes(expanded) <= maxBytes ? expanded : { ...base,
      diagnostics: ["connector_graph omitted: item byte budget; raw connector rows remain retrievable", ...base.diagnostics], truncated: true };
  }
  const helperBase = { ...base, key_counts: {}, key_facts: {}, diagnostics: [], target_scope: ref.target_scope,
    effect_state: null, before_hash: null, after_hash: null };
  const helperFindings = projectScopedHelperFindings(ref, raw, maxBytes - projectionBytes(helperBase) - 64);
  if (helperFindings) candidate = { ...helperBase, helper_findings: helperFindings, truncated: true };
  while (projectionBytes(candidate) > maxBytes) {
    const facts = Object.entries(candidate.key_facts);
    const counts = Object.entries(candidate.key_counts);
    if (facts.length > 4) candidate = { ...candidate, key_facts: Object.fromEntries(facts.slice(0, Math.ceil(facts.length / 2))), truncated: true };
    else if (counts.length > 4) candidate = { ...candidate, key_counts: Object.fromEntries(counts.slice(0, Math.ceil(counts.length / 2))), truncated: true };
    else if (candidate.diagnostics.length > 2) candidate = { ...candidate, diagnostics: candidate.diagnostics.slice(0, 2), truncated: true };
    else if (candidate.target_scope.length > 4) candidate = { ...candidate, target_scope: candidate.target_scope.slice(0, 4), truncated: true };
    else break;
  }
  // Avoid a second model round trip merely to expand a small native result.
  // StoreEvidence has already screened and persisted these exact bytes. Never
  // inline untrusted input or an ambiguous MCP envelope, and never truncate a
  // payload into something that could be mistaken for a complete result.
  if (ref.trust_level === "authoritative_native" || ref.trust_level === "authoritative_readback") {
    const row = safeRecord(raw);
    const isEnvelope = row && (Array.isArray(row.content) || Object.prototype.hasOwnProperty.call(row, "structuredContent"));
    const payload = isEnvelope ? extractMcpStructuredPayload(raw)?.payload : row;
    if (payload !== undefined && payload !== null) {
      // V2 sends retained native evidence, replacing MCP presentation text.
      // Build the complete detailing summary here using the verifier's admission
      // rules; never substitute partial counts for a complete comparison.
      const detailing = viewOwnedDetailingSummaryV2(payload);
      const expanded = detailing
        ? { ...base, key_counts: {}, key_facts: {}, target_scope: ref.target_scope,
            inline_payload: detailing, truncated: false }
        : { ...candidate, inline_payload: payload };
      if (projectionBytes(expanded) <= maxBytes) candidate = expanded;
      else if (!detailing) {
        // Extracted scalar facts repeat the payload and can crowd out its exact
        // nested values. Prefer the complete screened native result when it
        // fits without those duplicates. Keep identity and receipt
        // metadata; this changes presentation, never evidence authority.
        const complete = { ...base, key_counts: {}, key_facts: {},
          inline_payload: payload, truncated: false };
        if (projectionBytes(complete) <= maxBytes) candidate = complete;
        else {
          // Generic scalar facts are not a complete presentation of nested
          // native values, even when the traversal itself stayed within bounds.
          candidate = { ...candidate, truncated: true };
          const parameterBase = { ...base, key_counts: {}, key_facts: {}, target_scope: ref.target_scope };
          const table = projectParameterTable(payload, maxBytes - projectionBytes(parameterBase) - 32);
          if (table) {
            const compact = { ...parameterBase, inline_payload: table,
              truncated: (table.coverage as { page_rows_complete: boolean }).page_rows_complete !== true };
            if (projectionBytes(compact) <= maxBytes) candidate = compact;
          }
          const inventory = completeElementIdInventory(payload);
          if (inventory) {
            const compact = { ...base, key_counts: {}, key_facts: {}, target_scope: ref.target_scope,
              inline_payload: inventory, truncated: true };
            if (projectionBytes(compact) <= maxBytes) candidate = compact;
          }
        }
      }
    }
  }
  const projected_bytes = projectionBytes(candidate);
  if (projected_bytes > maxBytes) throw new Error(`Evidence projection cannot fit configured ${maxBytes}-byte item budget.`);
  return { ...candidate, projected_bytes };
}
