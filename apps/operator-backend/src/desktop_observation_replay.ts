import { createHash } from 'node:crypto';

const schema = 'revit-operator.model-observation-index/v2';
const fields = ['verified_postconditions', 'inspection_read_candidates', 'pending_verification'] as const;
const notice = 'Replay only: these exact repeated fields remain literal at the indicated later tool output. '
  + 'Use the latest checks; neither a duplicate nor its hash grants freshness, verification or completion. Raw history is retained.';
type Ref = { call_id: string; output_part: number; field_sha256: string };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Lossless deduplication within the actual input, not a summary or new evidence.
 * Only three known observation-index arrays are eligible. Every distinct pending
 * check stays literal, as do budgets, failures, observations and opaque state.
 * Fresh outputs stay byte-for-byte unchanged. References always point forward
 * to literal fields, including after a subsequent replay, never to a chain.
 * Matching a schema is not evidence authentication or a grant of authority.
 */
export function packHistoricalObservationFields(history: any[], fresh: any[]) {
  const calls = new Map<string, string>();
  const candidates: { item: number; part: number; value: any; text: string }[] = [];
  const all = [...history, ...fresh];
  for (const [i, item] of all.entries()) {
    if (item?.type === 'function_call' && typeof item.call_id === 'string') {
      calls.set(item.call_id, item.name); continue;
    }
    if (item?.type !== 'function_call_output' || !Array.isArray(item.output)
        || !['native__operator_run_dynamic_revit_program', 'native__revit_call_tool',
          'operator_run_dynamic_revit_program', 'revit_call_tool'].includes(calls.get(item.call_id) ?? '')) continue;
    for (const [part, block] of item.output.entries()) {
      if (block?.type !== 'input_text' || typeof block.text !== 'string'
          || block.text.length > 32_768 || Object.keys(block).some(k => !['type', 'text'].includes(k))) continue;
      try {
        const value = JSON.parse(block.text);
        const hasMarker = value && (Object.hasOwn(value, 'replay_exact_fields') || Object.hasOwn(value, 'replay_notice'));
        if (hasMarker && (value.replay_notice !== notice || !value.replay_exact_fields
            || typeof value.replay_exact_fields !== 'object' || Array.isArray(value.replay_exact_fields)
            || Object.entries(value.replay_exact_fields).some(([key, ref]: [string, any]) =>
              !fields.includes(key as typeof fields[number]) || !ref || typeof ref !== 'object'
              || Object.keys(ref).sort().join(',') !== 'call_id,field_sha256,output_part'
              || typeof ref.call_id !== 'string' || !Number.isSafeInteger(ref.output_part) || ref.output_part < 0
              || typeof ref.field_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.field_sha256)))) continue;
        if (value?.schema === schema && typeof value === 'object' && !Array.isArray(value))
          candidates.push({ item: i, part, value, text: block.text });
      } catch { /* Unknown or malformed output is never transformed. */ }
    }
  }
  const literal = new Map<string, Ref>();
  const input = [...history]; let omittedFields = 0, bytesSaved = 0;
  for (const c of candidates.reverse()) {
    const original = all[c.item], value = { ...c.value };
    const refs: Record<string, Ref> = { ...value.replay_exact_fields };
    let changed = false;
    for (const field of fields) {
      const data = value[field];
      if (Array.isArray(data) && data.length && Buffer.byteLength(JSON.stringify(data)) >= 512) {
        const hash = digest(data), key = field + ':' + hash, later = literal.get(key);
        if (later && c.item < history.length) {
          delete value[field]; refs[field] = later; changed = true; omittedFields++;
        } else {
          literal.set(key, { call_id: original.call_id, output_part: c.part, field_sha256: hash });
        }
      } else if (data === undefined && value.replay_notice === notice) {
        const prior = refs[field];
        if (prior && typeof prior.field_sha256 === 'string') {
          const later = literal.get(field + ':' + prior.field_sha256);
          if (later && JSON.stringify(later) !== JSON.stringify(prior) && c.item < history.length) {
            refs[field] = later; changed = true;
          }
        }
      }
    }
    if (!changed) continue;
    value.replay_exact_fields = refs; value.replay_notice = notice;
    const text = JSON.stringify(value);
    const item = input[c.item];
    const output = [...item.output]; output[c.part] = { ...output[c.part], text };
    input[c.item] = { ...item, output };
    bytesSaved += Buffer.byteLength(c.text) - Buffer.byteLength(text);
  }
  return { input, omittedFields, bytesSaved };
}
