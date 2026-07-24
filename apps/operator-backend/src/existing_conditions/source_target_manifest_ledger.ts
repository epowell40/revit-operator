import {
  appendExistingConditionsRepairLedgerEntry,
  hashExistingConditionsLedgerValue,
  normalizeExistingConditionsLedgerSha256,
  readExistingConditionsRepairLedger,
  type ExistingConditionsRepairLedgerEntry
} from "./repair_ledger_store.js";
import type {
  CompiledSheetPixelInterpretationV1,
  SheetPixelInterpretationContextV1,
  SheetPixelInterpretationInputV1
} from "./sheet_pixel_interpretation.js";
import type { SheetTopologyDiscipline, SheetTopologyPrimitiveKind } from "./sheet_topology_compiler.js";

export type ExistingConditionsSourceTargetStatusV1 =
  | "candidate"
  | "unresolved"
  | "approved_exclusion";

export type ExistingConditionsSourceTargetDecisionV1 =
  | "native_batch"
  | "single_action"
  | "deferred"
  | "duplicate"
  | "mixed"
  | "not_applicable";

export type ExistingConditionsSourceTargetV1 = {
  target_key: string;
  source_view_key: string;
  source_frame_key: string;
  registration_context_key: string;
  source_mark_key: string;
  source_mark_keys?: string[];
  supersedes_target_keys?: string[];
  discipline: SheetTopologyDiscipline;
  source_status: ExistingConditionsSourceTargetStatusV1;
  compilation_decision: ExistingConditionsSourceTargetDecisionV1;
  primitive_kinds: SheetTopologyPrimitiveKind[];
  primitive_keys: string[];
  compiler_reason_codes: string[];
  target_scope?: "source_mark" | "primitive";
  source_mark_primitive_count?: number;
  reason_code: "compiled_candidate" | "unresolved_source_mark" | "approved_source_exclusion";
  next_repair: string;
  native_write_allowed: false;
};

export type ExistingConditionsSourceTargetManifestV1 = {
  schema_version: 1;
  package_fingerprint_sha256: string;
  source_receipt_sha256: string;
  source_receipt_schema: "operator.existing_conditions.sheet_interpretation_receipt.v1";
  package_key: string;
  source_accounting_closure: 1;
  target_count: number;
  counts: Record<ExistingConditionsSourceTargetStatusV1, number>;
  source_mark_count?: number;
  source_mark_counts?: Record<ExistingConditionsSourceTargetStatusV1, number>;
  targets: ExistingConditionsSourceTargetV1[];
  native_write_allowed: false;
};

export type ExistingConditionsSourceTargetManifestStateV1 = {
  manifest: ExistingConditionsSourceTargetManifestV1;
  sequence: number;
  event_key: string;
  entry_sha256: string;
  updated_at_ms: number;
};

const MAX_SOURCE_MARKS = 500;
const MAX_SOURCE_TARGETS = 2_000;

function opaque(prefix: string, value: unknown): string {
  return `${prefix}_${hashExistingConditionsLedgerValue(value).slice(0, 24)}`;
}

function requiredText(value: unknown, field: string, maximum = 600): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`existing_conditions_source_target_manifest_${field}_required`);
  if (normalized.length > maximum) throw new Error(`existing_conditions_source_target_manifest_${field}_too_long`);
  return normalized;
}

function opaqueKey(value: unknown, field: string): string {
  const normalized = requiredText(value, field, 96);
  if (!/^[a-z][a-z0-9_]*_[0-9a-f]{24}$/i.test(normalized)) {
    throw new Error(`existing_conditions_source_target_manifest_${field}_not_opaque`);
  }
  return normalized;
}

function decisionForPrimitiveIds(
  primitiveIds: string[],
  compiled: CompiledSheetPixelInterpretationV1
): ExistingConditionsSourceTargetDecisionV1 {
  const byPrimitive = new Map(
    compiled.compiled_topology.decisions.map(value => [value.primitive_id, value.decision] as const)
  );
  const decisions = new Set(primitiveIds.map(id => byPrimitive.get(id)).filter(Boolean));
  if (decisions.size === 0) return "not_applicable";
  if (decisions.size > 1) return "mixed";
  return [...decisions][0] as ExistingConditionsSourceTargetDecisionV1;
}

function nextRepair(
  sourceStatus: ExistingConditionsSourceTargetStatusV1,
  decision: ExistingConditionsSourceTargetDecisionV1,
  primitiveKinds: SheetTopologyPrimitiveKind[],
  compilerReasons: string[]
): string {
  if (sourceStatus === "approved_exclusion") {
    return "No repair is due; preserve this approved source exclusion in sheet accounting.";
  }
  if (sourceStatus === "unresolved") {
    return "Acquire a focused crop or registered cross-sheet continuation for this mark, then recompile before any native action.";
  }
  if (decision === "native_batch") {
    return "Verify native type, size, system, elevation, phase, and endpoints, then dry-run only this target's reversible batch group.";
  }
  if (decision === "single_action") {
    return "Verify native context, then dry-run exactly one source-supported primitive for this target.";
  }
  if (decision === "duplicate") {
    return "Verify that the canonical target covers this duplicate mark; do not create duplicate native geometry.";
  }
  if (decision === "deferred") {
    const materialReason = compilerReasons.find(reason => reason.startsWith("material_claims_unresolved:"));
    if (materialReason) {
      const claims = materialReason.slice("material_claims_unresolved:".length).split(",").filter(Boolean).join(", ");
      return `Resolve source-supported ${claims} for this ${primitiveKinds.join("/")} target in a focused crop or registered cross-sheet view, then recompile it; do not write while deferred.`;
    }
    if (compilerReasons.includes("primitive_not_independently_reversible")) {
      if (primitiveKinds.includes("annotation")) {
        return "Bind this source annotation's legible claim to exactly one source-supported geometry or symbol target, or preserve it as unresolved evidence; do not author it as native geometry.";
      }
      return "Resolve an independently reversible native operation for this one source primitive before any dry-run or write.";
    }
    return `Add blinded calibration support for this ${primitiveKinds.join("/")} target before promotion; preserve it as deferred with no native write.`;
  }
  return "Select one primitive decision within this source target and complete its smallest verified repair before continuing.";
}

export function buildExistingConditionsSourceTargetManifestV1(args: {
  interpretation: SheetPixelInterpretationInputV1;
  context: SheetPixelInterpretationContextV1;
  compiled: CompiledSheetPixelInterpretationV1;
  sourceReceipt: Record<string, unknown>;
}): ExistingConditionsSourceTargetManifestV1 {
  const { interpretation, context, compiled } = args;
  if (compiled.compiled_topology.source_accounting_closure !== 1) {
    throw new Error("existing_conditions_source_target_manifest_source_accounting_incomplete");
  }
  if (interpretation.source_marks.length === 0 || interpretation.source_marks.length > MAX_SOURCE_MARKS) {
    throw new Error("existing_conditions_source_target_manifest_target_count_invalid");
  }
  const packageFingerprint = normalizeExistingConditionsLedgerSha256(
    compiled.compiled_topology.input_fingerprint_sha256,
    "source_target_manifest_package_fingerprint"
  );
  const trustedByView = new Map(context.trusted_views.map(value => [value.source_view.view_key, value] as const));
  const primitiveById = new Map(interpretation.primitives.map(value => [value.primitive_id, value] as const));
  const decisionByPrimitive = new Map(compiled.compiled_topology.decisions.map(value => [value.primitive_id, value] as const));
  const preliminaryTargets = interpretation.source_marks.flatMap(mark => {
    const trusted = trustedByView.get(mark.source_view_key);
    if (!trusted) throw new Error("existing_conditions_source_target_manifest_trusted_view_missing");
    const primitiveIds = mark.disposition.status === "candidate" ? mark.disposition.primitive_ids : [];
    const sourceStatus = mark.disposition.status;
    const targetPrimitiveIds: Array<string | null> = primitiveIds.length > 0 ? primitiveIds : [null];
    return targetPrimitiveIds.map(primitiveId => {
      const boundedPrimitiveIds = primitiveId ? [primitiveId] : [];
      const decision = decisionForPrimitiveIds(boundedPrimitiveIds, compiled);
      const primitiveKinds = [...new Set(boundedPrimitiveIds.map(id => primitiveById.get(id)?.kind).filter(Boolean))].sort() as SheetTopologyPrimitiveKind[];
      const compilerReasons = [...new Set(boundedPrimitiveIds.flatMap(id => decisionByPrimitive.get(id)?.reasons ?? []))].sort();
      const sourceMarkKey = opaque("mark", { packageFingerprint, mark: mark.source_mark_id });
      const legacySourceMarkTargetKey = opaque("target", {
        packageFingerprint,
        view: mark.source_view_key,
        mark: mark.source_mark_id
      });
      const target: ExistingConditionsSourceTargetV1 = {
        target_key: primitiveId
          ? opaque("target", { packageFingerprint, primitiveId })
          : legacySourceMarkTargetKey,
        source_view_key: opaque("view", { packageFingerprint, view: mark.source_view_key }),
        source_frame_key: opaque("frame", trusted.frame),
        registration_context_key: opaque("registration", trusted.source_view.registration_sha256),
        source_mark_key: sourceMarkKey,
        source_mark_keys: [sourceMarkKey],
        ...(primitiveId && primitiveIds.length === 1
          ? { supersedes_target_keys: [legacySourceMarkTargetKey] }
          : {}),
        discipline: trusted.source_view.discipline,
        source_status: sourceStatus,
        compilation_decision: decision,
        primitive_kinds: primitiveKinds,
        primitive_keys: boundedPrimitiveIds.map(id => opaque("primitive", { packageFingerprint, id })),
        compiler_reason_codes: compilerReasons,
        target_scope: primitiveId ? "primitive" : "source_mark",
        source_mark_primitive_count: primitiveIds.length,
        reason_code: sourceStatus === "candidate"
          ? "compiled_candidate"
          : sourceStatus === "unresolved"
            ? "unresolved_source_mark"
            : "approved_source_exclusion",
        next_repair: nextRepair(sourceStatus, decision, primitiveKinds, compilerReasons),
        native_write_allowed: false
      };
      return target;
    });
  });
  const targetByKey = new Map<string, ExistingConditionsSourceTargetV1>();
  for (const target of preliminaryTargets) {
    const existing = targetByKey.get(target.target_key);
    if (!existing) {
      targetByKey.set(target.target_key, target);
      continue;
    }
    existing.source_mark_keys = [...new Set([
      ...(existing.source_mark_keys ?? [existing.source_mark_key]),
      ...(target.source_mark_keys ?? [target.source_mark_key])
    ])].sort();
    existing.source_mark_key = existing.source_mark_keys[0]!;
    existing.source_mark_primitive_count = Math.max(
      existing.source_mark_primitive_count ?? 0,
      target.source_mark_primitive_count ?? 0
    );
    existing.supersedes_target_keys = [...new Set([
      ...(existing.supersedes_target_keys ?? []),
      ...(target.supersedes_target_keys ?? [])
    ])].sort();
  }
  const targets = [...targetByKey.values()].sort((left, right) => left.target_key.localeCompare(right.target_key));
  for (const target of targets) {
    if ((target.source_mark_keys ?? [target.source_mark_key]).length !== 1) {
      delete target.supersedes_target_keys;
    }
  }
  const manifest: ExistingConditionsSourceTargetManifestV1 = {
    schema_version: 1,
    package_fingerprint_sha256: packageFingerprint,
    source_receipt_sha256: hashExistingConditionsLedgerValue(args.sourceReceipt),
    source_receipt_schema: "operator.existing_conditions.sheet_interpretation_receipt.v1",
    package_key: opaque("package", { packageFingerprint, packageId: interpretation.package_id }),
    source_accounting_closure: 1,
    target_count: targets.length,
    counts: {
      candidate: targets.filter(value => value.source_status === "candidate").length,
      unresolved: targets.filter(value => value.source_status === "unresolved").length,
      approved_exclusion: targets.filter(value => value.source_status === "approved_exclusion").length
    },
    source_mark_count: interpretation.source_marks.length,
    source_mark_counts: {
      candidate: interpretation.source_marks.filter(mark => mark.disposition.status === "candidate").length,
      unresolved: interpretation.source_marks.filter(mark => mark.disposition.status === "unresolved").length,
      approved_exclusion: interpretation.source_marks.filter(mark => mark.disposition.status === "approved_exclusion").length
    },
    targets,
    native_write_allowed: false
  };
  return validateExistingConditionsSourceTargetManifestV1(manifest);
}

export function validateExistingConditionsSourceTargetManifestV1(
  value: ExistingConditionsSourceTargetManifestV1
): ExistingConditionsSourceTargetManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 1) {
    throw new Error("existing_conditions_source_target_manifest_schema_invalid");
  }
  if (value.native_write_allowed !== false || value.source_accounting_closure !== 1) {
    throw new Error("existing_conditions_source_target_manifest_must_deny_native_write");
  }
  if (value.source_receipt_schema !== "operator.existing_conditions.sheet_interpretation_receipt.v1") {
    throw new Error("existing_conditions_source_target_manifest_receipt_schema_invalid");
  }
  const targetCount = Number(value.target_count);
  if (!Number.isInteger(targetCount) || !Array.isArray(value.targets) || targetCount !== value.targets.length || targetCount < 1 || targetCount > MAX_SOURCE_TARGETS) {
    throw new Error("existing_conditions_source_target_manifest_target_count_invalid");
  }
  const seen = new Set<string>();
  const statuses = new Set<ExistingConditionsSourceTargetStatusV1>(["candidate", "unresolved", "approved_exclusion"]);
  const decisions = new Set<ExistingConditionsSourceTargetDecisionV1>(["native_batch", "single_action", "deferred", "duplicate", "mixed", "not_applicable"]);
  const disciplines = new Set<SheetTopologyDiscipline>(["architectural", "mechanical", "plumbing", "electrical"]);
  const primitiveKinds = new Set<SheetTopologyPrimitiveKind>(["wall_segment", "route_segment", "opening", "point_symbol", "annotation"]);
  const sourceMarks = new Map<string, ExistingConditionsSourceTargetStatusV1>();
  for (const target of value.targets) {
    const key = opaqueKey(target.target_key, "target_key").toLowerCase();
    if (seen.has(key)) throw new Error("existing_conditions_source_target_manifest_duplicate_target_key");
    seen.add(key);
    opaqueKey(target.source_view_key, "source_view_key");
    opaqueKey(target.source_frame_key, "source_frame_key");
    opaqueKey(target.registration_context_key, "registration_context_key");
    const sourceMarkKeys = target.source_mark_keys ?? [target.source_mark_key];
    if (!Array.isArray(sourceMarkKeys) || sourceMarkKeys.length < 1 || sourceMarkKeys.length > 64) {
      throw new Error("existing_conditions_source_target_manifest_source_mark_keys_invalid");
    }
    const normalizedSourceMarkKeys = [...new Set(sourceMarkKeys.map(item => opaqueKey(item, "source_mark_key")))].sort();
    if (normalizedSourceMarkKeys.length !== sourceMarkKeys.length || !normalizedSourceMarkKeys.includes(target.source_mark_key)) {
      throw new Error("existing_conditions_source_target_manifest_source_mark_keys_invalid");
    }
    for (const sourceMarkKey of normalizedSourceMarkKeys) {
      const priorSourceStatus = sourceMarks.get(sourceMarkKey);
      if (priorSourceStatus && priorSourceStatus !== target.source_status) {
        throw new Error("existing_conditions_source_target_manifest_source_mark_status_mismatch");
      }
      sourceMarks.set(sourceMarkKey, target.source_status);
    }
    if (target.supersedes_target_keys !== undefined) {
      if (
        !Array.isArray(target.supersedes_target_keys) ||
        target.supersedes_target_keys.length !== 1 ||
        target.target_scope !== "primitive" ||
        normalizedSourceMarkKeys.length !== 1 ||
        target.source_mark_primitive_count !== 1
      ) {
        throw new Error("existing_conditions_source_target_manifest_supersedes_target_keys_invalid");
      }
      const supersededKey = opaqueKey(target.supersedes_target_keys[0], "supersedes_target_key").toLowerCase();
      if (supersededKey === key) {
        throw new Error("existing_conditions_source_target_manifest_supersedes_target_keys_invalid");
      }
    }
    if (!statuses.has(target.source_status) || !decisions.has(target.compilation_decision) || !disciplines.has(target.discipline)) {
      throw new Error("existing_conditions_source_target_manifest_target_state_invalid");
    }
    if (!Array.isArray(target.primitive_keys) || target.primitive_keys.length > 64) {
      throw new Error("existing_conditions_source_target_manifest_primitive_keys_invalid");
    }
    if (!Array.isArray(target.primitive_kinds) || target.primitive_kinds.length > 5 || target.primitive_kinds.some(kind => !primitiveKinds.has(kind))) {
      throw new Error("existing_conditions_source_target_manifest_primitive_kinds_invalid");
    }
    if (!Array.isArray(target.compiler_reason_codes) || target.compiler_reason_codes.length > 64) {
      throw new Error("existing_conditions_source_target_manifest_compiler_reason_codes_invalid");
    }
    target.compiler_reason_codes.forEach(reason => requiredText(reason, "compiler_reason_code", 160));
    target.primitive_keys.forEach(item => opaqueKey(item, "primitive_key"));
    if (target.target_scope !== undefined || target.source_mark_primitive_count !== undefined) {
      if (!Number.isInteger(target.source_mark_primitive_count) || Number(target.source_mark_primitive_count) < 0 || Number(target.source_mark_primitive_count) > 64) {
        throw new Error("existing_conditions_source_target_manifest_source_mark_primitive_count_invalid");
      }
      if (
        (target.target_scope === "primitive" && (target.source_status !== "candidate" || target.primitive_keys.length !== 1 || target.primitive_kinds.length !== 1 || Number(target.source_mark_primitive_count) < 1)) ||
        (target.target_scope === "source_mark" && (target.source_status === "candidate" || target.primitive_keys.length !== 0 || target.primitive_kinds.length !== 0 || target.source_mark_primitive_count !== 0))
      ) {
        throw new Error("existing_conditions_source_target_manifest_target_scope_invalid");
      }
    }
    const expectedReason = target.source_status === "candidate"
      ? "compiled_candidate"
      : target.source_status === "unresolved"
        ? "unresolved_source_mark"
        : "approved_source_exclusion";
    if (target.reason_code !== expectedReason) throw new Error("existing_conditions_source_target_manifest_reason_mismatch");
    requiredText(target.next_repair, "next_repair");
    if (target.native_write_allowed !== false) throw new Error("existing_conditions_source_target_manifest_target_must_deny_native_write");
  }
  const normalized: ExistingConditionsSourceTargetManifestV1 = {
    ...value,
    package_fingerprint_sha256: normalizeExistingConditionsLedgerSha256(value.package_fingerprint_sha256, "source_target_manifest_package_fingerprint"),
    source_receipt_sha256: normalizeExistingConditionsLedgerSha256(value.source_receipt_sha256, "source_target_manifest_source_receipt"),
    package_key: opaqueKey(value.package_key, "package_key"),
    targets: [...value.targets].sort((left, right) => left.target_key.localeCompare(right.target_key))
  };
  const actualCounts = {
    candidate: normalized.targets.filter(target => target.source_status === "candidate").length,
    unresolved: normalized.targets.filter(target => target.source_status === "unresolved").length,
    approved_exclusion: normalized.targets.filter(target => target.source_status === "approved_exclusion").length
  };
  if (hashExistingConditionsLedgerValue(actualCounts) !== hashExistingConditionsLedgerValue(value.counts)) {
    throw new Error("existing_conditions_source_target_manifest_counts_invalid");
  }
  if (value.source_mark_count !== undefined || value.source_mark_counts !== undefined) {
    if (!Number.isInteger(value.source_mark_count) || value.source_mark_count !== sourceMarks.size || value.source_mark_count < 1 || value.source_mark_count > MAX_SOURCE_MARKS) {
      throw new Error("existing_conditions_source_target_manifest_source_mark_count_invalid");
    }
    const actualSourceMarkCounts = {
      candidate: [...sourceMarks.values()].filter(status => status === "candidate").length,
      unresolved: [...sourceMarks.values()].filter(status => status === "unresolved").length,
      approved_exclusion: [...sourceMarks.values()].filter(status => status === "approved_exclusion").length
    };
    if (hashExistingConditionsLedgerValue(actualSourceMarkCounts) !== hashExistingConditionsLedgerValue(value.source_mark_counts)) {
      throw new Error("existing_conditions_source_target_manifest_source_mark_counts_invalid");
    }
  }
  if (/\b(?:Element|ViewRegion)\d+\b/i.test(JSON.stringify(normalized))) {
    throw new Error("existing_conditions_source_target_manifest_raw_source_id_forbidden");
  }
  return normalized;
}

export function recordExistingConditionsSourceTargetManifestV1(args: {
  sessionId: string;
  manifest: ExistingConditionsSourceTargetManifestV1;
}): ExistingConditionsRepairLedgerEntry {
  const manifest = validateExistingConditionsSourceTargetManifestV1(args.manifest);
  const actionable = manifest.targets.find(target => target.source_status !== "approved_exclusion");
  return appendExistingConditionsRepairLedgerEntry({
    sessionId: args.sessionId,
    workflowFingerprintSha256: manifest.package_fingerprint_sha256,
    workflowSha256: hashExistingConditionsLedgerValue(manifest),
    event: "source_target_manifest_registered",
    status: actionable ? "follow_up" : "accepted",
    acceptedProgress: true,
    payload: { source_target_manifest: manifest },
    nextRepair: actionable?.next_repair ?? null
  });
}

export function latestExistingConditionsSourceTargetManifestV1(
  sessionId: string
): ExistingConditionsSourceTargetManifestStateV1 | null {
  const entry = readExistingConditionsRepairLedger(sessionId)
    .filter(candidate => candidate.event === "source_target_manifest_registered")
    .at(-1);
  if (!entry) return null;
  return {
    manifest: validateExistingConditionsSourceTargetManifestV1(
      entry.payload.source_target_manifest as ExistingConditionsSourceTargetManifestV1
    ),
    sequence: entry.sequence,
    event_key: entry.event_key,
    entry_sha256: entry.entry_sha256,
    updated_at_ms: Date.parse(entry.ts) || Date.now()
  };
}
