import { createHash } from "node:crypto";
import type { DynamicRevitProgramRunInput } from "./dynamicRevitProgramRunner.js";

const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export type TrustedTaskFactSet = {
  schema: "revit-operator.trusted-task-facts.v1";
  verifier_identity_sha256: string;
  execution_evidence_sha256: string;
  evidence_sha256: string;
  document_fingerprint: string;
  document_session_id: string;
  document_revision: number | null;
  fields: Readonly<Record<string, string>>;
  sets: Readonly<Record<string, readonly string[]>>;
};

export type DynamicTaskPostcondition =
  | { id: string; kind: "field_hash_equals"; field: string; expected_sha256: string }
  | { id: string; kind: "set_equals"; field: string; expected: readonly string[] }
  | { id: string; kind: "set_unchanged"; field: string; baseline: readonly string[] }
  | { id: string; kind: "count_between"; field: string; minimum: number; maximum: number }
  | { id: string; kind: "fact_absent"; field: string };

export type TrustedTaskPostconditionReceipt = {
  schema: "revit-operator.trusted-task-postconditions.v1";
  postcondition_set_sha256: string;
  verifier_identity_sha256: string;
  execution_evidence_sha256: string;
  evidence_sha256: string;
  document_fingerprint: string;
  document_session_id: string;
  document_revision: number | null;
  results: ReadonlyArray<{ id: string; passed: boolean; observed_sha256: string }>;
  all_passed: boolean;
  authorization_granted: false;
  receipt_sha256: string;
};

export function evaluateTrustedTaskPostconditions(facts: TrustedTaskFactSet,
  conditions: readonly DynamicTaskPostcondition[]): Readonly<TrustedTaskPostconditionReceipt> {
  validateTrustedFacts(facts);
  if (!Array.isArray(conditions) || conditions.length < 1 || conditions.length > 128) throw new Error("Task postconditions must be a bounded non-empty list.");
  const ids = new Set<string>();
  const normalized = conditions.map(condition => {
    if (!condition || !ID.test(condition.id) || ids.has(condition.id) || !ID.test(condition.field)) throw new Error("Task postcondition identity is invalid or duplicated.");
    ids.add(condition.id);
    if (condition.kind === "field_hash_equals") {
      requireExactKeys(condition, ["expected_sha256", "field", "id", "kind"], "field-hash postcondition");
      requireHash(condition.expected_sha256, "postcondition expected hash");
      return { ...condition };
    }
    if (condition.kind === "set_equals" || condition.kind === "set_unchanged") {
      requireExactKeys(condition, [condition.kind === "set_equals" ? "expected" : "baseline", "field", "id", "kind"], "set postcondition");
      return { ...condition, [condition.kind === "set_equals" ? "expected" : "baseline"]: canonicalSet(condition.kind === "set_equals" ? condition.expected : condition.baseline) } as DynamicTaskPostcondition;
    }
    if (condition.kind === "count_between") {
      requireExactKeys(condition, ["field", "id", "kind", "maximum", "minimum"], "count postcondition");
      if (!Number.isSafeInteger(condition.minimum) || !Number.isSafeInteger(condition.maximum) || condition.minimum < 0 || condition.maximum < condition.minimum || condition.maximum > 50_000)
        throw new Error("Task postcondition count bound is invalid.");
      return { ...condition };
    }
    if (condition.kind === "fact_absent") {
      requireExactKeys(condition, ["field", "id", "kind"], "absent-fact postcondition");
      return { ...condition };
    }
    throw new Error("Task postcondition kind is unsupported.");
  });
  const conditionHash = sha256(JSON.stringify(normalized));
  const results = normalized.map(condition => {
    let passed = false; let observed: unknown;
    if (condition.kind === "field_hash_equals") { observed = facts.fields[condition.field] ?? null; passed = observed === condition.expected_sha256; }
    else if (condition.kind === "set_equals") { const values = canonicalSet(facts.sets[condition.field] ?? []); observed = values; passed = same(values, condition.expected); }
    else if (condition.kind === "set_unchanged") { const values = canonicalSet(facts.sets[condition.field] ?? []); observed = values; passed = same(values, condition.baseline); }
    else if (condition.kind === "count_between") { const count = (facts.sets[condition.field] ?? []).length; observed = count; passed = count >= condition.minimum && count <= condition.maximum; }
    else { observed = facts.fields[condition.field] ?? facts.sets[condition.field] ?? null; passed = observed === null; }
    return Object.freeze({ id: condition.id, passed, observed_sha256: sha256(JSON.stringify(observed)) });
  });
  const unsigned = {
    schema: "revit-operator.trusted-task-postconditions.v1" as const, postcondition_set_sha256: conditionHash,
    verifier_identity_sha256: facts.verifier_identity_sha256, execution_evidence_sha256: facts.execution_evidence_sha256,
    evidence_sha256: facts.evidence_sha256,
    document_fingerprint: facts.document_fingerprint, document_session_id: facts.document_session_id,
    document_revision: facts.document_revision, results: Object.freeze(results), all_passed: results.every(value => value.passed),
    authorization_granted: false as const
  };
  return Object.freeze({ ...unsigned, receipt_sha256: sha256(JSON.stringify(unsigned)) });
}

export type ObservationSelectorProjection = {
  element_unique_ids: readonly string[]; category_stable_ids: readonly string[]; kinds: readonly string[];
  parameter_names: readonly string[]; include_type_parameters: boolean;
};

export type TrustedObservationBaseline = {
  document_fingerprint: string; document_session_id: string; document_revision: number;
  snapshot_sha256: string; revision_sha256: string; scope_sha256: string; receipt_sha256: string;
  selector: ObservationSelectorProjection;
};

export type ObservationDeltaReceipt = {
  schema: "revit-operator.dynamic-observation-delta.v1";
  base_receipt_sha256: string; document_fingerprint: string; document_session_id: string; document_revision: number;
  snapshot_sha256: string; base_revision_sha256: string; base_scope_sha256: string; request_sha256: string;
  added: ObservationSelectorProjection; cumulative_selector_sha256: string; authorization_granted: false; delta_sha256: string;
};

export function createObservationDelta(base: TrustedObservationBaseline, requested: ObservationSelectorProjection,
  requestSha256: string): Readonly<ObservationDeltaReceipt> {
  validateBaseline(base); requireHash(requestSha256, "fact request");
  const current = normalizeSelector(base.selector); const next = normalizeSelector(requested);
  const difference = (requestedValues: readonly string[], currentValues: readonly string[]) => requestedValues.filter(value => !currentValues.includes(value));
  const added = Object.freeze({
    element_unique_ids: Object.freeze(difference(next.element_unique_ids, current.element_unique_ids)),
    category_stable_ids: Object.freeze(difference(next.category_stable_ids, current.category_stable_ids)),
    kinds: Object.freeze(difference(next.kinds, current.kinds)), parameter_names: Object.freeze(difference(next.parameter_names, current.parameter_names)),
    include_type_parameters: next.include_type_parameters && !current.include_type_parameters
  });
  const cumulative = normalizeSelector({
    element_unique_ids: [...current.element_unique_ids, ...added.element_unique_ids], category_stable_ids: [...current.category_stable_ids, ...added.category_stable_ids],
    kinds: [...current.kinds, ...added.kinds], parameter_names: [...current.parameter_names, ...added.parameter_names],
    include_type_parameters: current.include_type_parameters || added.include_type_parameters
  });
  const unsigned = {
    schema: "revit-operator.dynamic-observation-delta.v1" as const, base_receipt_sha256: base.receipt_sha256,
    document_fingerprint: base.document_fingerprint, document_session_id: base.document_session_id, document_revision: base.document_revision,
    snapshot_sha256: base.snapshot_sha256, base_revision_sha256: base.revision_sha256, base_scope_sha256: base.scope_sha256,
    request_sha256: requestSha256, added, cumulative_selector_sha256: sha256(JSON.stringify(cumulative)), authorization_granted: false as const
  };
  return Object.freeze({ ...unsigned, delta_sha256: sha256(JSON.stringify(unsigned)) });
}

export function verifyObservationDelta(base: TrustedObservationBaseline, delta: ObservationDeltaReceipt,
  observed: Omit<TrustedObservationBaseline, "selector"> & { selector: ObservationSelectorProjection }): void {
  validateBaseline(base); validateBaseline(observed); requireHash(delta.delta_sha256, "delta");
  const { delta_sha256: claimed, ...unsigned } = delta;
  if (sha256(JSON.stringify(unsigned)) !== claimed || delta.schema !== "revit-operator.dynamic-observation-delta.v1" || delta.authorization_granted !== false ||
    delta.base_receipt_sha256 !== base.receipt_sha256 || delta.document_fingerprint !== base.document_fingerprint ||
    delta.document_session_id !== base.document_session_id || delta.document_revision !== base.document_revision || delta.snapshot_sha256 !== base.snapshot_sha256 ||
    delta.base_revision_sha256 !== base.revision_sha256 || delta.base_scope_sha256 !== base.scope_sha256)
    throw new Error("Observation delta provenance is invalid or stale.");
  if (observed.document_fingerprint !== base.document_fingerprint || observed.document_session_id !== base.document_session_id ||
    observed.document_revision !== base.document_revision || observed.snapshot_sha256 !== base.snapshot_sha256)
    throw new Error("Observation delta cannot merge across a document, session, revision, or snapshot boundary.");
  if (sha256(JSON.stringify(normalizeSelector(observed.selector))) !== delta.cumulative_selector_sha256)
    throw new Error("Observed delta does not cover the exact cumulative selector.");
}

export type DynamicExecutionRunReceipt = {
  run_id: string; execution_status: "completed" | "needs_facts" | "failed"; requested_mode: "preview" | "apply";
  verification: { evidence_sha256: string; deterministic_replay_verified: boolean };
  continuation?: { fact_request: Record<string, unknown> };
  diagnostics: ReadonlyArray<{ code: string; retryable: boolean }>;
  iteration: { progress: { classification: string }; iteration_sha256: string };
  checkpoint: null | { run_id: string; checkpoint_sha256: string; evidence_sha256: string; task_session_id: string; checkpoint_index: number };
};

export type DynamicCodeSessionStep = {
  step_id: string; source: string; input: Omit<DynamicRevitProgramRunInput, "source" | "mode" | "resume" | "continue_from_checkpoint">;
  postconditions: readonly DynamicTaskPostcondition[]; mutates: boolean;
};

export type ProviderRepairDecision = { action: "repair"; source: string } | { action: "retry" } | { action: "stop"; reason: string };
export type DynamicMutationAuthorityReceipt = { schema: "revit-operator.dynamic-mutation-authority.v1"; task_id: string; step_id: string;
  source_sha256: string; authorization_granted: true; expires_unix_seconds: number; receipt_sha256: string };
export type DynamicTaskFinalizationReceipt = { schema: "revit-operator.dynamic-task-finalization.v1"; task_id: string;
  final_checkpoint_sha256: string | null; disposition: "accepted_state" | "discarded_working_copy" | "verified_compensation";
  evidence_sha256: string; authorization_granted: false; receipt_sha256: string };

export type DynamicCodeSessionHooks = {
  execute(input: DynamicRevitProgramRunInput): Promise<DynamicExecutionRunReceipt>;
  observe(run: DynamicExecutionRunReceipt, step: DynamicCodeSessionStep): Promise<TrustedTaskFactSet>;
  expandFacts(args: { run: DynamicExecutionRunReceipt; step: DynamicCodeSessionStep; source: string }): Promise<{
    input: DynamicRevitProgramRunInput; base: TrustedObservationBaseline; delta: ObservationDeltaReceipt;
    observed: TrustedObservationBaseline;
  }>;
  repair(args: { run: DynamicExecutionRunReceipt; step: DynamicCodeSessionStep; source: string }): Promise<ProviderRepairDecision>;
  authorize(args: { task_id: string; step: DynamicCodeSessionStep; source_sha256: string }): Promise<DynamicMutationAuthorityReceipt>;
  finalize(args: { task_id: string; final_checkpoint_sha256: string | null; completed_steps: ReadonlyArray<Readonly<Record<string, unknown>>> }): Promise<DynamicTaskFinalizationReceipt>;
};

export async function coordinateDynamicCodeSession(taskId: string, steps: readonly DynamicCodeSessionStep[], hooks: DynamicCodeSessionHooks,
  nowUnixSeconds = () => Math.floor(Date.now() / 1000)) {
  if (!ID.test(taskId) || !Array.isArray(steps) || steps.length < 1 || steps.length > 64 || new Set(steps.map(value => value.step_id)).size !== steps.length)
    throw new Error("Dynamic code session task or step plan is invalid.");
  let checkpoint: DynamicExecutionRunReceipt["checkpoint"] = null;
  const completed: Array<Record<string, unknown>> = [];
  for (const step of steps) {
    if (!ID.test(step.step_id) || typeof step.source !== "string" || step.source.length < 1 || step.source.length > 128_000) throw new Error("Dynamic code session step is invalid.");
    let source = step.source; let attempts = 0; let previewReceipt: DynamicExecutionRunReceipt | null = null;
    let nextInput: DynamicRevitProgramRunInput | null = null;
    while (true) {
      if (++attempts > 5) throw new Error("Dynamic code session exceeded the per-step iteration bound.");
      const previewInput: DynamicRevitProgramRunInput = nextInput ?? { ...step.input, source, mode: "preview",
        ...(checkpoint ? { continue_from_checkpoint: { prior_run_id: checkpoint.run_id, prior_evidence_sha256: checkpoint.evidence_sha256,
          prior_checkpoint_sha256: checkpoint.checkpoint_sha256 } } : {}) };
      nextInput = null;
      const run = await hooks.execute(previewInput); validateRun(run, "preview"); previewReceipt = run;
      if (run.execution_status === "needs_facts") {
        const expanded = await hooks.expandFacts({ run, step, source });
        if (!expanded.input.resume || expanded.input.resume.mode !== "facts" || expanded.input.source !== source || expanded.input.mode !== "preview")
          throw new Error("Fact expansion did not preserve source, mode, and exact continuation semantics.");
        verifyObservationDelta(expanded.base, expanded.delta, expanded.observed);
        nextInput = expanded.input;
        continue;
      }
      if (previewReceipt.execution_status === "completed") break;
      if (previewReceipt.execution_status !== "failed" || !previewReceipt.diagnostics.some(value => value.retryable)) throw new Error("Dynamic code preview ended in a terminal safe blocker.");
      if (previewReceipt.iteration.progress.classification === "no_progress" && attempts > 1) throw new Error("Dynamic code session stopped after verified no progress.");
      const decision = await hooks.repair({ run: previewReceipt, step, source });
      if (decision.action === "stop") throw new Error("Provider stopped dynamic code repair: " + decision.reason);
      if (decision.action === "retry") {
        nextInput = { ...step.input, source, mode: "preview", resume: {
          prior_run_id: previewReceipt.run_id, prior_evidence_sha256: previewReceipt.verification.evidence_sha256, mode: "retry"
        } };
        continue;
      }
      if (decision.source === source || decision.source.length < 1 || decision.source.length > 128_000) throw new Error("Provider repair did not produce distinct bounded source.");
      source = decision.source;
      nextInput = { ...step.input, source, mode: "preview", resume: {
        prior_run_id: previewReceipt.run_id, prior_evidence_sha256: previewReceipt.verification.evidence_sha256, mode: "repair"
      } };
    }
    const previewFacts = await hooks.observe(previewReceipt, step);
    if (previewFacts.execution_evidence_sha256 !== previewReceipt.verification.evidence_sha256)
      throw new Error("Trusted preview facts are not bound to the exact execution evidence.");
    const previewPostconditions = evaluateTrustedTaskPostconditions(previewFacts, step.postconditions);
    if (!previewPostconditions.all_passed) throw new Error("Trusted preview postconditions failed.");
    let finalRun = previewReceipt; let authority: DynamicMutationAuthorityReceipt | null = null;
    if (step.mutates) {
      const sourceHash = sourceIdentity(source);
      authority = await hooks.authorize({ task_id: taskId, step: { ...step, source }, source_sha256: sourceHash });
      validateAuthority(authority, taskId, step.step_id, sourceHash, nowUnixSeconds());
      const applyInput: DynamicRevitProgramRunInput = { ...step.input, source, mode: "apply",
        ...(checkpoint ? { continue_from_checkpoint: { prior_run_id: checkpoint.run_id, prior_evidence_sha256: checkpoint.evidence_sha256,
          prior_checkpoint_sha256: checkpoint.checkpoint_sha256 } } : {}) };
      finalRun = await hooks.execute(applyInput); validateRun(finalRun, "apply");
      if (finalRun.execution_status !== "completed" || finalRun.checkpoint === null) throw new Error("Authorized dynamic apply did not produce a verified committed checkpoint.");
      const applyFacts = await hooks.observe(finalRun, step);
      if (applyFacts.execution_evidence_sha256 !== finalRun.verification.evidence_sha256)
        throw new Error("Trusted apply facts are not bound to the exact execution evidence.");
      const applyPostconditions = evaluateTrustedTaskPostconditions(applyFacts, step.postconditions);
      if (!applyPostconditions.all_passed || applyPostconditions.postcondition_set_sha256 !== previewPostconditions.postcondition_set_sha256 ||
        applyPostconditions.document_fingerprint !== previewPostconditions.document_fingerprint || applyPostconditions.document_session_id !== previewPostconditions.document_session_id)
        throw new Error("Trusted apply postconditions failed or diverged from preview.");
      checkpoint = finalRun.checkpoint;
      completed.push(Object.freeze({ step_id: step.step_id, attempts, source_sha256: sourceHash, preview_run_id: previewReceipt.run_id,
        apply_run_id: finalRun.run_id, checkpoint_sha256: checkpoint.checkpoint_sha256, mutation_authority_sha256: authority.receipt_sha256,
        preview_postconditions_sha256: previewPostconditions.receipt_sha256, apply_postconditions_sha256: applyPostconditions.receipt_sha256 }));
    } else completed.push(Object.freeze({ step_id: step.step_id, attempts, source_sha256: sourceIdentity(source), preview_run_id: previewReceipt.run_id,
      preview_postconditions_sha256: previewPostconditions.receipt_sha256 }));
  }
  const finalCheckpoint = checkpoint?.checkpoint_sha256 ?? null;
  const finalization = await hooks.finalize({ task_id: taskId, final_checkpoint_sha256: finalCheckpoint, completed_steps: Object.freeze(completed) });
  validateFinalization(finalization, taskId, finalCheckpoint);
  const unsigned = { schema: "revit-operator.dynamic-code-session.v1", task_id: taskId, steps: Object.freeze(completed),
    final_checkpoint_sha256: finalCheckpoint, finalization_receipt_sha256: finalization.receipt_sha256,
    final_disposition: finalization.disposition, outcome: "completed_verified" as const, authorization_granted: false as const };
  return Object.freeze({ ...unsigned, session_sha256: sha256(JSON.stringify(unsigned)) });
}

function validateRun(run: DynamicExecutionRunReceipt, mode: "preview" | "apply") {
  if (!run || !/^dynamic-[a-f0-9]{32}$/.test(run.run_id) || run.requested_mode !== mode || !["completed", "needs_facts", "failed"].includes(run.execution_status) ||
    !HASH.test(run.verification?.evidence_sha256) || !HASH.test(run.iteration?.iteration_sha256) ||
    (run.execution_status !== "failed" && run.verification.deterministic_replay_verified !== true) ||
    (run.execution_status === "failed" && (!Array.isArray(run.diagnostics) || run.diagnostics.length < 1)))
    throw new Error("Dynamic execution run receipt is not trusted or deterministic.");
}
function validateAuthority(value: DynamicMutationAuthorityReceipt, task: string, step: string, source: string, now: number) {
  const { receipt_sha256: claimed, ...unsigned } = value;
  if (value.schema !== "revit-operator.dynamic-mutation-authority.v1" || value.task_id !== task || value.step_id !== step || value.source_sha256 !== source ||
    value.authorization_granted !== true || !Number.isSafeInteger(value.expires_unix_seconds) || value.expires_unix_seconds <= now ||
    !HASH.test(claimed) || sha256(JSON.stringify(unsigned)) !== claimed) throw new Error("Dynamic mutation authority is invalid, expired, or substituted.");
}
function validateFinalization(value: DynamicTaskFinalizationReceipt, task: string, checkpoint: string | null) {
  const { receipt_sha256: claimed, ...unsigned } = value;
  if (value.schema !== "revit-operator.dynamic-task-finalization.v1" || value.task_id !== task || value.final_checkpoint_sha256 !== checkpoint ||
    !["accepted_state", "discarded_working_copy", "verified_compensation"].includes(value.disposition) || value.authorization_granted !== false ||
    !HASH.test(value.evidence_sha256) || !HASH.test(claimed) || sha256(JSON.stringify(unsigned)) !== claimed)
    throw new Error("Dynamic task finalization is invalid or not bound to the final checkpoint.");
}
function validateTrustedFacts(value: TrustedTaskFactSet) {
  if (!value || value.schema !== "revit-operator.trusted-task-facts.v1") throw new Error("Trusted task facts schema is invalid.");
  requireExactKeys(value, ["document_fingerprint", "document_revision", "document_session_id", "evidence_sha256", "execution_evidence_sha256", "fields", "schema", "sets", "verifier_identity_sha256"], "trusted task facts");
  requireHash(value.verifier_identity_sha256, "verifier"); requireHash(value.execution_evidence_sha256, "execution evidence");
  requireHash(value.evidence_sha256, "evidence"); requireHash(value.document_fingerprint, "document");
  if (!ID.test(value.document_session_id) || value.document_revision !== null && (!Number.isSafeInteger(value.document_revision) || value.document_revision < 0)) throw new Error("Trusted task document binding is invalid.");
  if (!value.fields || typeof value.fields !== "object" || Array.isArray(value.fields) || Object.keys(value.fields).length > 256 ||
    !value.sets || typeof value.sets !== "object" || Array.isArray(value.sets) || Object.keys(value.sets).length > 256)
    throw new Error("Trusted task facts exceed bounded field or set counts.");
  for (const [key, hash] of Object.entries(value.fields)) { if (!ID.test(key)) throw new Error("Trusted fact field is invalid."); requireHash(hash, "trusted fact"); }
  for (const [key, values] of Object.entries(value.sets)) { if (!ID.test(key)) throw new Error("Trusted fact set is invalid."); canonicalSet(values); }
}
function validateBaseline(value: TrustedObservationBaseline) {
  requireHash(value.document_fingerprint, "observation document"); requireHash(value.snapshot_sha256, "observation snapshot");
  requireHash(value.revision_sha256, "observation revision"); requireHash(value.scope_sha256, "observation scope"); requireHash(value.receipt_sha256, "observation receipt");
  if (!ID.test(value.document_session_id) || !Number.isSafeInteger(value.document_revision) || value.document_revision < 0) throw new Error("Observation baseline binding is invalid.");
  normalizeSelector(value.selector);
}
function normalizeSelector(value: ObservationSelectorProjection): ObservationSelectorProjection {
  if (!value || typeof value.include_type_parameters !== "boolean") throw new Error("Observation selector projection is invalid.");
  return Object.freeze({ element_unique_ids: Object.freeze(canonicalSet(value.element_unique_ids)), category_stable_ids: Object.freeze(canonicalSet(value.category_stable_ids)),
    kinds: Object.freeze(canonicalSet(value.kinds)), parameter_names: Object.freeze(canonicalSet(value.parameter_names)), include_type_parameters: value.include_type_parameters });
}
function canonicalSet(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 4096 || values.some(value => typeof value !== "string" || value.length < 1 || value.length > 256 || value.includes("\0")))
    throw new Error("Bounded canonical set is invalid.");
  const result = [...new Set(values)].sort(); if (result.length !== values.length) throw new Error("Canonical set contains duplicates."); return result;
}
function same(left: readonly string[], right: readonly string[]) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function requireExactKeys(value: object, expected: readonly string[], name: string) {
  const actual = Object.keys(value).sort(); const required = [...expected].sort();
  if (!same(actual, required)) throw new Error(`${name} has an invalid exact shape.`);
}
function requireHash(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${name} hash is invalid.`); }
function sha256(value: string) { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
function sourceIdentity(source: string) { return sha256(source.replaceAll("\r\n", "\n").replaceAll("\r", "\n")); }
