// Node-only durable producer/consumer handoff. This is execution evidence,
// never permission to dispatch an operation. The backend owns the signing key
// and passes it only to its MCP child, not to model tool arguments.
import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const SCHEMA = "revit-operator.assignment-completion-outbox/v2";
const LIMIT = 64 * 1024 * 1024;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function requireValue(condition, code) {
  if (!condition) throw new Error(`assignment_completion_outbox_${code}`);
}
function identity(lease) {
  const binding = lease?.binding;
  requireValue(binding && ["assignment_id", "run_id", "session_id", "principal_id"].every(key => typeof binding[key] === "string" && binding[key].length > 0)
    && Number.isSafeInteger(binding.generation) && binding.generation > 0
    && typeof lease.operation_id === "string" && lease.operation_id.length > 0
    && typeof lease.request_identity?.request_signature === "string", "identity_invalid");
  return JSON.parse(JSON.stringify({ binding, operation_id: lease.operation_id, request_identity: lease.request_identity }));
}
function directory(workspace) { return path.join(workspace, "runtime", "assignment-completions-v2"); }
function recordPath(workspace, lease) {
  return path.join(directory(workspace), `${createHash("sha256").update(canonical(identity(lease))).digest("hex")}.json`);
}
function keyBytes(key) {
  requireValue(typeof key === "string" && /^[a-f0-9]{64}$/.test(key), "key_invalid");
  return Buffer.from(key, "hex");
}
function signature(key, payload) { return createHmac("sha256", keyBytes(key)).update(canonical(payload)).digest("hex"); }

/** Existing keys are never silently replaced. A lost/corrupt key fails closed. */
export function completionOutboxKeyV2(workspace) {
  const root = directory(workspace);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "producer.key");
  try {
    const key = fs.readFileSync(file, "utf8").trim();
    keyBytes(key);
    return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const key = randomBytes(32).toString("hex");
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, key); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return key;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = fs.readFileSync(file, "utf8").trim();
    keyBytes(existing);
    return existing;
  }
}

export function readCompletionOutboxV2(workspace, key, lease) {
  const file = recordPath(workspace, lease);
  let raw;
  try {
    requireValue(fs.statSync(file).size <= LIMIT, "record_too_large");
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const record = JSON.parse(raw);
  requireValue(record.schema === SCHEMA && /^[a-f0-9]{64}$/.test(record.signature), "record_invalid");
  requireValue(timingSafeEqual(Buffer.from(record.signature, "hex"), Buffer.from(signature(key, record.payload), "hex")), "signature_invalid");
  requireValue(canonical(record.payload.identity) === canonical(identity(lease)), "binding_mismatch");
  const result = record.payload.envelope?.structuredContent?.operation_result_v2;
  requireValue(result && canonical(identity(result)) === canonical(identity(lease)), "result_mismatch");
  return record.payload.envelope;
}

/** Flush before publishing the filename. Never replace a retained result. */
export function retainCompletionOutboxV2(workspace, key, lease, envelope) {
  const structured = envelope?.structuredContent;
  requireValue(structured?.schema === "revit-operator.assignment-kernel-mcp-result/v2", "envelope_invalid");
  requireValue(canonical(identity(structured.operation_result_v2)) === canonical(identity(lease)), "result_mismatch");
  const retainedEnvelope = JSON.parse(JSON.stringify({ content: [], structuredContent: structured }));
  const payload = { identity: identity(lease), envelope: retainedEnvelope };
  const text = JSON.stringify({ schema: SCHEMA, payload, signature: signature(key, payload) });
  requireValue(Buffer.byteLength(text) <= LIMIT, "record_too_large");
  const root = directory(workspace);
  fs.mkdirSync(root, { recursive: true });
  const file = recordPath(workspace, lease);
  const pending = path.join(root, `${randomUUID()}.pending`);
  const fd = fs.openSync(pending, "wx", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    try { fs.linkSync(pending, file); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = readCompletionOutboxV2(workspace, key, lease);
      requireValue(canonical(previous) === canonical(retainedEnvelope), "result_conflict");
    }
  } finally { fs.unlinkSync(pending); }
}
