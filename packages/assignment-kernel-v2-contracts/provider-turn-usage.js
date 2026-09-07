export const PROVIDER_TURN_USAGE_V1_SCHEMA = "revit-operator.provider-turn-usage/v1";
export const PROVIDER_USAGE_COVERAGE_V1_SCHEMA = "revit-operator.provider-usage-coverage/v1";
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const id = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
export function parseProviderTurnUsageV1(value) {
  const row = object(value);
  if (row.schema !== PROVIDER_TURN_USAGE_V1_SCHEMA || !id(row.session_id) || !id(row.message_id)
      || !["not_started", "completed", "interrupted", "failed"].includes(row.disposition)
      || !Array.isArray(row.raw_response_ids) || row.raw_response_ids.length > 1000
      || row.raw_response_ids.some(value => !id(value)) || new Set(row.raw_response_ids).size !== row.raw_response_ids.length)
    throw new Error("provider_turn_usage_invalid");
  if (row.disposition === "not_started") {
    if (row.thread_id !== null || row.turn_id !== null || row.raw_response_ids.length !== 0) throw new Error("provider_turn_usage_invalid_not_started");
  } else if (!id(row.thread_id) || !id(row.turn_id)) throw new Error("provider_turn_usage_identity_missing");
  return { schema: PROVIDER_TURN_USAGE_V1_SCHEMA, session_id: row.session_id, message_id: row.message_id,
    thread_id: row.thread_id, turn_id: row.turn_id, disposition: row.disposition, raw_response_ids: [...row.raw_response_ids] };
}

/** A request attempt is recorded before transport; a missing response must remain visible. */
export function buildProviderUsageCoverageV1(attemptValues, receiptValues) {
  const attempts = Array.isArray(attemptValues) ? attemptValues : [];
  const receipts = Array.isArray(receiptValues) ? receiptValues.slice(0, 1000).map(object) : [];
  const keys = new Set(), covered = new Set();
  let complete = attempts.length > 0 && attempts.length <= 1000
    && Array.isArray(receiptValues) && receiptValues.length <= 1000;
  const rows = attempts.slice(0, 1000).map(value => {
    const row = object(value);
    const key = JSON.stringify([row.session_id, row.message_id]);
    let usage = null, valid = id(row.session_id) && id(row.message_id) && !keys.has(key) && row.conflicted !== true;
    keys.add(key);
    try { usage = parseProviderTurnUsageV1(row.provider_turn_usage); } catch { valid = false; }
    if (usage && (usage.session_id !== row.session_id || usage.message_id !== row.message_id)) valid = false;
    const missing = [];
    if (usage && usage.disposition !== "not_started") {
      if (usage.raw_response_ids.length === 0) valid = false;
      for (const responseId of usage.raw_response_ids) {
        if (covered.has(responseId)) valid = false;
        covered.add(responseId);
        if (!receipts.some(receipt => receipt.provider === "openai" && receipt.route === "codex_agent"
          && receipt.call_id === responseId && receipt.turn_id === usage.turn_id)) missing.push(responseId);
      }
      if (missing.length > 0) valid = false;
    }
    complete = complete && valid;
    return { session_id: id(row.session_id) ? row.session_id : null, message_id: id(row.message_id) ? row.message_id : null,
      provider_turn_usage: usage, conflicted: row.conflicted === true, complete: valid, missing_raw_response_ids: missing };
  });
  const unassigned = receipts.filter(receipt => receipt.route === "codex_agent" && !covered.has(receipt.call_id)).map(receipt => receipt.call_id);
  if (unassigned.length > 0) complete = false;
  return { schema: PROVIDER_USAGE_COVERAGE_V1_SCHEMA, request_count: attempts.length, attempts: rows,
    unassigned_raw_response_ids: unassigned, complete,
    no_provider_invocation: complete && rows.every(row => row.provider_turn_usage?.disposition === "not_started") && receipts.length === 0 };
}

/** The host owns request attempts. Response metadata can only settle an existing exact attempt. */
export function createProviderUsageLedgerV1() {
  const attempts = new Map();
  let overflow = false;
  const key = (sessionId, messageId) => JSON.stringify([sessionId, messageId]);
  return {
    begin(sessionId, messageId) {
      if (!id(sessionId) || !id(messageId)) { overflow = true; return; }
      const identity = key(sessionId, messageId);
      if (attempts.has(identity)) return;
      if (attempts.size >= 1000) { overflow = true; return; }
      attempts.set(identity, { session_id: sessionId, message_id: messageId, provider_turn_usage: null, conflicted: false });
    },
    observe(sessionId, messageId, response) {
      const row = attempts.get(key(sessionId, messageId));
      if (!row || object(response).provider_turn_usage === undefined) return;
      let usage;
      try { usage = parseProviderTurnUsageV1(response.provider_turn_usage); }
      catch { row.conflicted = true; return; }
      if (usage.session_id !== sessionId || usage.message_id !== messageId
        || (row.provider_turn_usage && JSON.stringify(row.provider_turn_usage) !== JSON.stringify(usage))) {
        row.conflicted = true; return;
      }
      row.provider_turn_usage = usage;
    },
    snapshot(receipts) {
      const result = buildProviderUsageCoverageV1([...attempts.values()], receipts);
      return { ...result, overflow, complete: !overflow && result.complete,
        no_provider_invocation: !overflow && result.no_provider_invocation };
    }
  };
}
