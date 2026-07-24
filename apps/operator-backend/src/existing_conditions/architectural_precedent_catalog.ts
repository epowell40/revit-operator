import crypto from "node:crypto";
import {
  compileArchitecturalPlanGeometryPreview,
  promoteArchitecturalPlanGeometryPreview,
  type ArchitecturalMaterialAttribute,
  type ArchitecturalPlanGeometryObservation,
  type ArchitecturalPlanGeometryPreviewPackage,
  type ArchitecturalPlanGeometryPromotionGate,
  type ArchitecturalPlanGeometryResolution,
  type PromotedArchitecturalPlanGeometry
} from "./architectural_plan_geometry_preview.js";

type MaterialValue = string | number;

export type ArchitecturalPrecedentEvidence = {
  evidence_id: string;
  basis: "retained_native_exemplar" | "user_approved_project_standard";
  evidence_reference: string;
  source_document_sha256: string;
  source_scope_id: string;
  target_scope_id: string;
  retention_receipt_sha256: string;
  native_readback: true;
  source_element_ids?: number[];
  retained_outside_target: true;
};

export type ArchitecturalPrecedentSelector = {
  kind: "wall" | "door" | "window";
  classifications?: string[];
  type_marks?: string[];
  measured_width_range_ft?: [number, number];
  measured_thickness_range_ft?: [number, number];
};

export type ArchitecturalPrecedentEntry = {
  mapping_id: string;
  approved: true;
  selector: ArchitecturalPrecedentSelector;
  attributes: Partial<Record<ArchitecturalMaterialAttribute, MaterialValue>>;
  evidence_ids: string[];
};

export type ArchitecturalPrecedentCatalog = {
  schema_version: 1;
  catalog_id: string;
  project_key: string;
  evidence: ArchitecturalPrecedentEvidence[];
  entries: ArchitecturalPrecedentEntry[];
};

export type ArchitecturalPrecedentSignal = {
  observation_id: string;
  classification?: string;
  classification_evidence_sha256?: string;
  type_mark?: string;
  type_mark_evidence_sha256?: string;
};

export type ArchitecturalPrecedentMappingReceipt = {
  observation_id: string;
  mapping_id: string;
  selector: ArchitecturalPrecedentSelector;
  evidence_ids: string[];
  evidence_references: string[];
  resolved_attributes: ArchitecturalMaterialAttribute[];
};

export type ResolvedArchitecturalPrecedentMappings = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  preview_fingerprint_sha256: string;
  catalog_id: string;
  catalog_fingerprint_sha256: string;
  resolutions: ArchitecturalPlanGeometryResolution[];
  mapping_receipts: ArchitecturalPrecedentMappingReceipt[];
};

export type PromotedArchitecturalPlanGeometryWithCatalog = PromotedArchitecturalPlanGeometry & {
  precedent_catalog_id: string;
  precedent_catalog_fingerprint_sha256: string;
  precedent_mapping_receipts: ArchitecturalPrecedentMappingReceipt[];
};

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return cleanText(value).toLowerCase().replace(/[\s_-]+/g, " ");
}

function requiredText(value: unknown, label: string): string {
  const text = cleanText(value);
  if (!text) throw new Error(`${label}_is_required`);
  return text;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function positive(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed <= 0) throw new Error(`${label}_must_be_positive`);
  return parsed;
}

function sha256(value: unknown, label: string): string {
  const text = normalized(value).replace(/ /g, "");
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label}_must_be_sha256`);
  return text;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function materialAttributes(observation: ArchitecturalPlanGeometryObservation): ArchitecturalMaterialAttribute[] {
  if (observation.kind === "wall") return ["type", "thickness", "height"];
  if (observation.kind === "window") return ["family", "type", "width", "height", "sill height"];
  return ["family", "type", "width", "height"];
}

function validateMaterialValue(attribute: ArchitecturalMaterialAttribute, value: MaterialValue, label: string): MaterialValue {
  if (attribute === "family" || attribute === "type") return requiredText(value, label);
  const parsed = finite(value, label);
  if (attribute === "sill height") {
    if (parsed < 0) throw new Error(`${label}_must_be_nonnegative`);
  } else if (parsed <= 0) {
    throw new Error(`${label}_must_be_positive`);
  }
  return parsed;
}

function range(value: unknown, label: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label}_must_have_two_values`);
  const minimum = positive(value[0], `${label}_minimum`);
  const maximum = positive(value[1], `${label}_maximum`);
  if (minimum > maximum) throw new Error(`${label}_minimum_exceeds_maximum`);
  return [minimum, maximum];
}

function validateCatalog(
  catalog: ArchitecturalPrecedentCatalog,
  input: ArchitecturalPlanGeometryPreviewPackage
): { catalogId: string; evidenceById: Map<string, ArchitecturalPrecedentEvidence> } {
  const targetScopeId = input.scope_id;
  const visiblePrecedentModelHashes = new Set(input.visible_evidence
    .filter((entry) => {
      const role = normalized(entry.role);
      return role.includes("redacted model") || role.includes("precedent source model");
    })
    .map((entry) => normalized(entry.sha256).replace(/ /g, "")));
  const visibleRetentionReceiptHashes = new Set(input.visible_evidence
    .filter((entry) => normalized(entry.role).includes("precedent retention receipt"))
    .map((entry) => normalized(entry.sha256).replace(/ /g, "")));
  if (catalog.schema_version !== 1) throw new Error("unsupported_architectural_precedent_catalog_schema_version");
  const catalogId = requiredText(catalog.catalog_id, "architectural_precedent_catalog_id");
  requiredText(catalog.project_key, "architectural_precedent_project_key");
  if (!Array.isArray(catalog.evidence) || catalog.evidence.length === 0) {
    throw new Error("architectural_precedent_evidence_is_required");
  }
  const evidenceById = new Map<string, ArchitecturalPrecedentEvidence>();
  for (const evidence of catalog.evidence) {
    const evidenceId = requiredText(evidence.evidence_id, "architectural_precedent_evidence_id");
    if (evidenceById.has(evidenceId)) throw new Error(`duplicate_architectural_precedent_evidence:${evidenceId}`);
    if (!["retained_native_exemplar", "user_approved_project_standard"].includes(evidence.basis)) {
      throw new Error(`${evidenceId}_architectural_precedent_basis_is_invalid`);
    }
    requiredText(evidence.evidence_reference, `${evidenceId}_evidence_reference`);
    const sourceDocumentHash = sha256(evidence.source_document_sha256, `${evidenceId}_source_document_sha256`);
    if (sourceDocumentHash === normalized(input.source_evidence_sha256).replace(/ /g, "")) {
      throw new Error(`${evidenceId}_source_pdf_cannot_be_native_precedent`);
    }
    if (!visiblePrecedentModelHashes.has(sourceDocumentHash)) {
      throw new Error(`${evidenceId}_precedent_source_model_is_not_visible_evidence`);
    }
    const sourceScopeId = requiredText(evidence.source_scope_id, `${evidenceId}_source_scope_id`);
    if (sourceScopeId === targetScopeId) throw new Error(`${evidenceId}_uses_target_scope_as_precedent`);
    if (requiredText(evidence.target_scope_id, `${evidenceId}_target_scope_id`) !== targetScopeId) {
      throw new Error(`${evidenceId}_retention_receipt_target_scope_mismatch`);
    }
    const retentionReceiptHash = sha256(evidence.retention_receipt_sha256, `${evidenceId}_retention_receipt_sha256`);
    if (!visibleRetentionReceiptHashes.has(retentionReceiptHash)) {
      throw new Error(`${evidenceId}_retention_receipt_is_not_visible_evidence`);
    }
    if (evidence.native_readback !== true) throw new Error(`${evidenceId}_retention_receipt_requires_native_readback`);
    if (evidence.retained_outside_target !== true) throw new Error(`${evidenceId}_must_be_retained_outside_target`);
    if (evidence.basis === "retained_native_exemplar") {
      if (!Array.isArray(evidence.source_element_ids) || evidence.source_element_ids.length === 0) {
        throw new Error(`${evidenceId}_retained_exemplar_ids_are_required`);
      }
      for (const id of evidence.source_element_ids) {
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${evidenceId}_source_element_ids_must_be_positive_integers`);
      }
    }
    evidenceById.set(evidenceId, evidence);
  }
  if (!Array.isArray(catalog.entries) || catalog.entries.length === 0) {
    throw new Error("architectural_precedent_entries_are_required");
  }
  const mappingIds = new Set<string>();
  for (const entry of catalog.entries) {
    const mappingId = requiredText(entry.mapping_id, "architectural_precedent_mapping_id");
    if (mappingIds.has(mappingId)) throw new Error(`duplicate_architectural_precedent_mapping:${mappingId}`);
    mappingIds.add(mappingId);
    if (entry.approved !== true) throw new Error(`${mappingId}_must_be_explicitly_approved`);
    if (!entry.selector || !["wall", "door", "window"].includes(entry.selector.kind)) {
      throw new Error(`${mappingId}_selector_kind_is_invalid`);
    }
    const hasDiscriminator = (entry.selector.classifications?.length ?? 0) > 0 ||
      (entry.selector.type_marks?.length ?? 0) > 0 ||
      entry.selector.measured_width_range_ft !== undefined ||
      entry.selector.measured_thickness_range_ft !== undefined;
    if (!hasDiscriminator) throw new Error(`${mappingId}_selector_requires_plan_visible_discriminator`);
    if (entry.selector.measured_width_range_ft !== undefined) {
      range(entry.selector.measured_width_range_ft, `${mappingId}_measured_width_range_ft`);
      if (entry.selector.kind === "wall") throw new Error(`${mappingId}_wall_selector_cannot_use_measured_width`);
    }
    if (entry.selector.measured_thickness_range_ft !== undefined) {
      range(entry.selector.measured_thickness_range_ft, `${mappingId}_measured_thickness_range_ft`);
      if (entry.selector.kind !== "wall") throw new Error(`${mappingId}_opening_selector_cannot_use_measured_thickness`);
    }
    const applicable = new Set<ArchitecturalMaterialAttribute>(entry.selector.kind === "wall"
      ? ["type", "thickness", "height"]
      : entry.selector.kind === "window"
        ? ["family", "type", "width", "height", "sill height"]
        : ["family", "type", "width", "height"]);
    const attributeEntries = Object.entries(entry.attributes) as Array<[ArchitecturalMaterialAttribute, MaterialValue]>;
    if (attributeEntries.length === 0) throw new Error(`${mappingId}_attributes_are_required`);
    for (const [attribute, value] of attributeEntries) {
      if (!applicable.has(attribute)) throw new Error(`${mappingId}_attribute_is_not_applicable:${attribute}`);
      validateMaterialValue(attribute, value, `${mappingId}_${normalized(attribute).replace(/ /g, "_")}`);
    }
    if (!Array.isArray(entry.evidence_ids) || entry.evidence_ids.length === 0) {
      throw new Error(`${mappingId}_evidence_ids_are_required`);
    }
    for (const evidenceId of entry.evidence_ids) {
      if (!evidenceById.has(evidenceId)) throw new Error(`${mappingId}_references_unknown_evidence:${evidenceId}`);
    }
  }
  return { catalogId, evidenceById };
}

function sameValue(a: MaterialValue, b: MaterialValue): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-6;
  return normalized(a) === normalized(b);
}

function selectorMatches(
  observation: ArchitecturalPlanGeometryObservation,
  signal: ArchitecturalPrecedentSignal | undefined,
  selector: ArchitecturalPrecedentSelector,
  classificationEvidenceHashes: Set<string>,
  typeMarkEvidenceHashes: Set<string>
): boolean {
  if (observation.kind !== selector.kind) return false;
  if ((selector.classifications?.length ?? 0) > 0) {
    if (!signal?.classification || !signal.classification_evidence_sha256) return false;
    const evidenceHash = sha256(signal.classification_evidence_sha256, `${observation.observation_id}_classification_evidence_sha256`);
    if (!classificationEvidenceHashes.has(evidenceHash)) return false;
    if (!selector.classifications!.map(normalized).includes(normalized(signal.classification))) return false;
  }
  if ((selector.type_marks?.length ?? 0) > 0) {
    if (!signal?.type_mark || !signal.type_mark_evidence_sha256) return false;
    const evidenceHash = sha256(signal.type_mark_evidence_sha256, `${observation.observation_id}_type_mark_evidence_sha256`);
    if (!typeMarkEvidenceHashes.has(evidenceHash)) return false;
    if (!selector.type_marks!.map(normalized).includes(normalized(signal.type_mark))) return false;
  }
  if (selector.measured_width_range_ft) {
    if (observation.kind === "wall") return false;
    const measured = observation.measured_width_ft;
    if (measured === undefined) return false;
    const [minimum, maximum] = selector.measured_width_range_ft;
    if (measured < minimum || measured > maximum) return false;
  }
  if (selector.measured_thickness_range_ft) {
    if (observation.kind !== "wall") return false;
    const measured = observation.measured_thickness_ft;
    if (measured === undefined) return false;
    const [minimum, maximum] = selector.measured_thickness_range_ft;
    if (measured < minimum || measured > maximum) return false;
  }
  return true;
}

export function resolveArchitecturalPrecedentMappings(
  input: ArchitecturalPlanGeometryPreviewPackage,
  catalog: ArchitecturalPrecedentCatalog,
  signals: ArchitecturalPrecedentSignal[]
): ResolvedArchitecturalPrecedentMappings {
  const preview = compileArchitecturalPlanGeometryPreview(input);
  if (preview.status !== "preview_ready") throw new Error(`architectural_preview_is_not_mappable:${preview.status}`);
  const { catalogId, evidenceById } = validateCatalog(catalog, input);
  if (!Array.isArray(signals)) throw new Error("architectural_precedent_signals_must_be_array");
  const signalByObservation = new Map<string, ArchitecturalPrecedentSignal>();
  for (const signal of signals) {
    const observationId = requiredText(signal.observation_id, "architectural_precedent_signal_observation_id");
    if (!input.observations.some((entry) => entry.observation_id === observationId)) {
      throw new Error(`architectural_precedent_signal_references_unknown_observation:${observationId}`);
    }
    if (signalByObservation.has(observationId)) throw new Error(`duplicate_architectural_precedent_signal:${observationId}`);
    signalByObservation.set(observationId, signal);
  }
  const classificationEvidenceHashes = new Set(input.visible_evidence
    .filter((entry) => normalized(entry.role).includes("classification"))
    .map((entry) => normalized(entry.sha256).replace(/ /g, "")));
  const typeMarkEvidenceHashes = new Set(input.visible_evidence
    .filter((entry) => normalized(entry.role).includes("type mark") || normalized(entry.role).includes("classification"))
    .map((entry) => normalized(entry.sha256).replace(/ /g, "")));

  const resolutions: ArchitecturalPlanGeometryResolution[] = [];
  const mappingReceipts: ArchitecturalPrecedentMappingReceipt[] = [];
  for (let index = 0; index < input.observations.length; index += 1) {
    const observation = input.observations[index]!;
    const previewElement = preview.preview_elements[index]!;
    const unresolved = new Set(previewElement.unresolved_attributes);
    if (unresolved.size === 0) continue;
    const candidates = catalog.entries.filter((entry) => {
      if (!selectorMatches(
        observation,
        signalByObservation.get(observation.observation_id),
        entry.selector,
        classificationEvidenceHashes,
        typeMarkEvidenceHashes
      )) return false;
      for (const attribute of unresolved) {
        if (entry.attributes[attribute] === undefined) return false;
      }
      for (const attribute of materialAttributes(observation)) {
        const sourceValue = previewElement.resolved_attributes[attribute];
        const precedentValue = entry.attributes[attribute];
        if (sourceValue !== undefined && precedentValue !== undefined && !sameValue(sourceValue, precedentValue)) return false;
      }
      return true;
    });
    if (candidates.length === 0) throw new Error(`${observation.observation_id}_has_no_matching_approved_precedent`);
    if (candidates.length > 1) {
      throw new Error(`${observation.observation_id}_architectural_precedent_is_ambiguous:${candidates.map((entry) => entry.mapping_id).join(",")}`);
    }
    const selected = candidates[0]!;
    const evidence = selected.evidence_ids.map((id) => evidenceById.get(id)!);
    const evidenceReference = `architectural_precedent_catalog:${catalogId}:${selected.mapping_id}:${selected.evidence_ids.join("+")}`;
    const attributes = [...unresolved].map((attribute) => ({
      attribute,
      value: validateMaterialValue(attribute, selected.attributes[attribute]!, `${selected.mapping_id}_${attribute}`),
      basis: "project_precedent" as const,
      evidence_reference: evidenceReference
    }));
    resolutions.push({ observation_id: observation.observation_id, attributes });
    mappingReceipts.push({
      observation_id: observation.observation_id,
      mapping_id: selected.mapping_id,
      selector: selected.selector,
      evidence_ids: [...selected.evidence_ids],
      evidence_references: evidence.map((entry) => entry.evidence_reference),
      resolved_attributes: attributes.map((entry) => entry.attribute)
    });
  }
  return {
    schema_version: 1,
    fixture_id: input.fixture_id,
    scope_id: input.scope_id,
    preview_fingerprint_sha256: preview.input_fingerprint_sha256,
    catalog_id: catalogId,
    catalog_fingerprint_sha256: fingerprint(catalog),
    resolutions,
    mapping_receipts: mappingReceipts
  };
}

export function promoteArchitecturalPlanGeometryWithCatalog(
  input: ArchitecturalPlanGeometryPreviewPackage,
  catalog: ArchitecturalPrecedentCatalog,
  signals: ArchitecturalPrecedentSignal[],
  gate: ArchitecturalPlanGeometryPromotionGate
): PromotedArchitecturalPlanGeometryWithCatalog {
  const mapped = resolveArchitecturalPrecedentMappings(input, catalog, signals);
  const promoted = promoteArchitecturalPlanGeometryPreview(input, mapped.resolutions, gate);
  return {
    ...promoted,
    precedent_catalog_id: mapped.catalog_id,
    precedent_catalog_fingerprint_sha256: mapped.catalog_fingerprint_sha256,
    precedent_mapping_receipts: mapped.mapping_receipts
  };
}
