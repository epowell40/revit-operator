import { EVIDENCE_PROJECTION_SCHEMA, type EvidenceProjectionV1, type EvidenceRefV1 } from "./evidence_ref.js";
import { extractMcpStructuredPayload, parseBoundedStructuredJson } from "./structured_payload.js";

const COUNT_KEY = /(?:^|_)(?:count|total|length|matched|created|updated|deleted|failed|succeeded)$/i;
const ACCEPTANCE_KEY = /(?:^|_)(?:id|name|number|value|status|state|result|effect_state|before_hash|after_hash|sha256|hash|level|host|side|system|orientation|circuit|category|type)$/i;
const DIAGNOSTIC_KEY = /(?:error|warning|diagnostic|failure|reason|message)/i;
const TARGET_KEY = /(?:element|target|view|sheet|room|space|system|circuit|level|host)(?:_?ids?|_?names?)?$/i;
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
  const text = boundedText(value, 180);
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
    let identityRows = 0;
    for (const valueRow of value) {
      const item = safeRecord(valueRow);
      if (!item) continue;
      const family = identityText(item.familyName ?? item.family_name ?? item.family);
      const type = identityText(item.typeName ?? item.type_name ?? item.type);
      const category = identityText(item.category ?? item.categoryName ?? item.category_name ?? item.builtInCategory);
      if (!family && !type && !category) continue;
      identityRows += 1;
      if (family || type) {
        const label = family && type ? `${family} | ${type}` : family ?? type!;
        familyType.set(label, (familyType.get(label) ?? 0) + 1);
      }
      if (category) categories.set(category, (categories.get(category) ?? 0) + 1);
    }
    if (identityRows === 0) continue;
    const declaredTotal = finiteCount(row);
    const explicitlyIncomplete = row.itemsComplete === false || row.truncated === true || row.scanCapReached === true || row.hasMore === true;
    const explicitlyComplete = row.itemsComplete === true
      || (row.truncated === false && row.scanCapReached !== true && row.hasMore !== true);
    const total = declaredTotal ?? value.length;
    const complete = !explicitlyIncomplete && explicitlyComplete && total === value.length && identityRows === value.length;
    const allFamilyType = sortedCounts(familyType);
    const allCategories = sortedCounts(categories);
    inventories.push({
      path: path === "$" ? key : `${path}.${key}`,
      rows: value.length,
      identityRows,
      total,
      complete,
      groupCount: allFamilyType.length,
      familyType: allFamilyType.slice(0, MAX_IDENTITY_GROUPS),
      categories: allCategories.slice(0, Math.max(0, MAX_IDENTITY_GROUPS - Math.min(MAX_IDENTITY_GROUPS, allFamilyType.length))),
      groupsTruncated: allFamilyType.length + allCategories.length > MAX_IDENTITY_GROUPS
    });
  }
  return inventories;
}

function pushTarget(out: string[], value: unknown): void {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    const normalized = scalar(item);
    if (normalized === undefined || normalized === null) continue;
    const text = boundedText(normalized, 120);
    if (text && !out.includes(text) && out.length < 32) out.push(text);
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
  const queue: Array<{ value: unknown; path: string; depth: number }> = [{ value: raw, path: "$", depth: 0 }];
  const rootRecord = safeRecord(raw);
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
        queue.push({ value: current.value[i], path: `${current.path}[${i}]`, depth: current.depth + 1 });
      }
      omitted ||= current.value.length > 128;
      continue;
    }
    const row = safeRecord(current.value);
    if (!row) continue;
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
      if (TARGET_KEY.test(key)) pushTarget(targets, value);
      if (/^before_?(?:sha256|hash)$/i.test(key) && typeof value === "string") beforeHash = boundedText(value, 128);
      if (/^after_?(?:sha256|hash)$/i.test(key) && typeof value === "string") afterHash = boundedText(value, 128);
      if (/^(?:effect_?)?state$/i.test(key) && (value === "none" || value === "unknown" || value === "applied")) effectState = value;
      if (valueScalar !== undefined && ACCEPTANCE_KEY.test(key) && Object.keys(facts).length < 48) facts[path] = valueScalar;
      if (valueScalar !== undefined && DIAGNOSTIC_KEY.test(key) && diagnostics.length < 12) diagnostics.push(`${path}: ${boundedText(valueScalar, 200)}`);
      if (STRUCTURED_TEXT_KEY.test(key) && !rootLooksLikeMcpEnvelope) {
        const structured = parseBoundedStructuredJson(value);
        if (structured) queue.push({ value: structured, path: `${path}.$json`, depth: current.depth + 1 });
      }
      if (value && typeof value === "object" && !rootEnvelopePayloadField) queue.push({ value, path, depth: current.depth + 1 });
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
      selector_forms: ["fields", "itemRange", "textRange", "targetSubset", "image", "MCP JSON fields: payload.<field>", "MCP JSON arrays: payload.<array>"],
      max_bytes: 1_048_576
    },
    truncated: extracted.omitted
  } satisfies Omit<EvidenceProjectionV1, "projected_bytes">;
  let candidate: Omit<EvidenceProjectionV1, "projected_bytes"> = base;
  while (projectionBytes(candidate) > maxBytes) {
    const facts = Object.entries(candidate.key_facts);
    const counts = Object.entries(candidate.key_counts);
    if (facts.length > 4) candidate = { ...candidate, key_facts: Object.fromEntries(facts.slice(0, Math.ceil(facts.length / 2))), truncated: true };
    else if (counts.length > 4) candidate = { ...candidate, key_counts: Object.fromEntries(counts.slice(0, Math.ceil(counts.length / 2))), truncated: true };
    else if (candidate.diagnostics.length > 2) candidate = { ...candidate, diagnostics: candidate.diagnostics.slice(0, 2), truncated: true };
    else if (candidate.target_scope.length > 4) candidate = { ...candidate, target_scope: candidate.target_scope.slice(0, 4), truncated: true };
    else break;
  }
  const projected_bytes = projectionBytes(candidate);
  if (projected_bytes > maxBytes) throw new Error(`Evidence projection cannot fit configured ${maxBytes}-byte item budget.`);
  return { ...candidate, projected_bytes };
}
