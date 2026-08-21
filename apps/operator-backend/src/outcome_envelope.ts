export type OutcomeEnvelopeClassification = {
  ok_false: boolean;
  outcome_unknown: boolean;
  reconciliation_required: boolean;
  request_dispatched_false: boolean;
  request_dispatched_true: boolean;
  classification_incomplete: boolean;
  completion_ineligible: boolean;
  blocking_no_effect: boolean;
};

const MAX_DEPTH = 8;
const MAX_NODES = 5_000;
const MAX_JSON_STRING_BYTES = 1_000_000;

/**
 * Classifies lifecycle authority fields anywhere in a bounded result envelope.
 * Tool transports may wrap results in content blocks, arrays, nested `result`
 * objects, or JSON strings; none of those wrappers may hide uncertainty or a
 * pre-dispatch rejection from settlement code.
 */
export function classifyOutcomeEnvelope(value: unknown): OutcomeEnvelopeClassification {
  const classification: OutcomeEnvelopeClassification = {
    ok_false: false,
    outcome_unknown: false,
    reconciliation_required: false,
    request_dispatched_false: false,
    request_dispatched_true: false,
    classification_incomplete: false,
    completion_ineligible: false,
    blocking_no_effect: false
  };
  const seen = new Set<object>();
  let remainingNodes = MAX_NODES;

  const visit = (candidate: unknown, depth: number): void => {
    if (candidate === null || candidate === undefined) return;
    if (remainingNodes-- <= 0) {
      classification.classification_incomplete = true;
      return;
    }
    if (depth > MAX_DEPTH) {
      const encoded = typeof candidate === "string" && (() => {
        const text = candidate.trim();
        return text.startsWith("{") || text.startsWith("[");
      })();
      if (typeof candidate === "object" || encoded) classification.classification_incomplete = true;
      return;
    }
    if (typeof candidate === "string") {
      const text = candidate.trim();
      if (text.length < 2 || (!text.startsWith("{") && !text.startsWith("["))) return;
      if (Buffer.byteLength(text, "utf8") > MAX_JSON_STRING_BYTES) {
        classification.classification_incomplete = true;
        return;
      }
      try { visit(JSON.parse(text), depth + 1); }
      catch { classification.classification_incomplete = true; }
      return;
    }
    if (typeof candidate !== "object") return;
    if (seen.has(candidate)) {
      classification.classification_incomplete = true;
      return;
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, depth + 1);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (record.ok === false) classification.ok_false = true;
    if (record.outcome_unknown === true) classification.outcome_unknown = true;
    if (record.reconciliation_required === true) classification.reconciliation_required = true;
    if (record.request_dispatched === false) classification.request_dispatched_false = true;
    if (record.request_dispatched === true) classification.request_dispatched_true = true;
    if (record.completionEligible === false || record.completion_eligible === false) {
      classification.completion_ineligible = true;
    }
    const blockingNoEffect = record.requestedEffectSatisfied === false
      || record.requested_effect_satisfied === false
      || record.requiresExplicitDiscardAndReopen === true
      || record.requires_explicit_discard_and_reopen === true
      || record.requiresExplicitUnloadAndOpen === true
      || record.requires_explicit_unload_and_open === true
      || ["already open inactive", "already loaded as link", "requires explicit action"]
        .includes(`${record.status || ""}`.trim().toLowerCase());
    if (blockingNoEffect) {
      classification.completion_ineligible = true;
      classification.blocking_no_effect = true;
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };

  visit(value, 0);
  return classification;
}

export function outcomeEnvelopeIsUnsafe(classification: OutcomeEnvelopeClassification): boolean {
  return classification.ok_false
    || classification.outcome_unknown
    || classification.reconciliation_required
    || classification.classification_incomplete;
}
