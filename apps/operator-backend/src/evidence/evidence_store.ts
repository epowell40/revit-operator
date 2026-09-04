import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  parseEvidenceRetrievalSelectorV1,
  selectExactEvidenceTargetsV1
} from "@revitoperator/assignment-kernel-v2-contracts";
import { ensureWorkspaceLayout, resolveFileUnderWorkspace } from "../workspace.js";
import { atomicAppendJsonlLine } from "../persistence/jsonl.js";
import {
  EVIDENCE_REF_SCHEMA,
  EVIDENCE_RETRIEVAL_SCHEMA,
  EVIDENCE_TELEMETRY_SCHEMA,
  type EvidenceRefV1,
  type EvidenceRetrievalRequest,
  type EvidenceRetrievalResult,
  type EvidenceStoreInput,
  type EvidenceStoreResult,
  type EvidenceTelemetryEventV1
} from "./evidence_ref.js";
import { extractDeterministicEvidenceFacts, projectEvidence } from "./evidence_projection.js";
import { extractMcpStructuredPayload } from "./structured_payload.js";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,240}$/;
const STRONG_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}={0,2}\b/i,
  /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{24,}/i
] as const;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeBounded(value: unknown, max: number, field: string, required = false): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new Error(`${field} is required.`);
  if (text.length > max) throw new Error(`${field} exceeds ${max} characters.`);
  if (text && /[\u0000-\u001f]/.test(text)) throw new Error(`${field} contains control characters.`);
  return text;
}

function scopePart(value: unknown, field: string, required = false): string | null {
  const text = safeBounded(value, 240, field, required);
  if (!text) return null;
  if (!SAFE_ID.test(text)) throw new Error(`${field} must be a bounded identifier.`);
  return text;
}

function rawBytes(raw: EvidenceStoreInput["raw"], mediaType?: string): Buffer {
  if (Buffer.isBuffer(raw)) return Buffer.from(raw);
  if (typeof raw === "string") return Buffer.from(raw, "utf8");
  try {
    const serialized = JSON.stringify(raw);
    if (serialized === undefined) throw new Error("Evidence is not serializable.");
    return Buffer.from(serialized, "utf8");
  } catch (error) {
    throw new Error(`Evidence is not serializable${mediaType ? ` as ${mediaType}` : ""}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseRaw(bytes: Buffer, mediaType: string): unknown {
  if (/(?:^|\+|\/)json(?:$|;)/i.test(mediaType)) return JSON.parse(bytes.toString("utf8"));
  if (/^text\//i.test(mediaType)) return bytes.toString("utf8");
  return null;
}

function assertSecretFree(bytes: Buffer, mediaType: string): void {
  if (!/(?:json|text|xml|javascript|csv|yaml|form)/i.test(mediaType)) return;
  const text = bytes.toString("utf8");
  for (const pattern of STRONG_SECRET_PATTERNS) {
    if (pattern.test(text)) throw new Error("Evidence rejected by secret screening; secret-like bytes were not persisted.");
  }
}

/**
 * Performs the same serialization and secret screening used by storeEvidence
 * without writing any bytes. Durable workflows use this before journaling a
 * recoverable evidence payload so rejected secret-like material never enters
 * the Assignment journal.
 */
export function assertEvidenceStoreInputSafe(input: EvidenceStoreInput): void {
  scopePart(input.scope.session_id, "scope.session_id", true);
  scopePart(input.scope.assignment_id, "scope.assignment_id");
  scopePart(input.scope.run_id, "scope.run_id");
  scopePart(input.scope.attempt_id, "scope.attempt_id");
  if (input.scope.generation != null && (!Number.isSafeInteger(input.scope.generation) || input.scope.generation < 0)) {
    throw new Error("scope.generation must be a non-negative integer.");
  }
  safeBounded(input.source, 240, "source", true);
  const mediaType = safeBounded(input.media_type || (Buffer.isBuffer(input.raw) ? "application/octet-stream" : typeof input.raw === "string" ? "text/plain; charset=utf-8" : "application/json"), 160, "media_type", true).toLowerCase();
  assertSecretFree(rawBytes(input.raw, mediaType), mediaType);
}

function writeImmutable(filePath: string, bytes: Buffer): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tempPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      try { fs.fsyncSync(fd); } catch {}
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tempPath, filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = fs.readFileSync(filePath);
      if (!existing.equals(bytes)) throw new Error("Immutable evidence object collision.");
      return false;
    }
  } catch (error) {
    throw error;
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
  }
}

function atomicWriteNewJson(filePath: string, value: unknown): boolean {
  const bytes = Buffer.from(JSON.stringify(value, null, 2), "utf8");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, bytes, { flag: "wx", mode: 0o600 });
    try {
      // A hard link publishes the fully written temp inode without replacing
      // an already-settled immutable ref (rename replaces on Windows).
      fs.linkSync(tempPath, filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (existing?.content_hash !== (value as any)?.content_hash) throw new Error("Immutable evidence reference collision.");
      return false;
    }
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
  }
}

function evidencePaths(hash: string, evidenceId?: string): { object: string; ref?: string; relativeObject: string } {
  const layout = ensureWorkspaceLayout();
  const relativeObject = path.posix.join("evidence", "objects", "sha256", hash.slice(0, 2), `${hash}.bin`);
  const object = resolveFileUnderWorkspace(relativeObject);
  const ref = evidenceId ? resolveFileUnderWorkspace(path.posix.join("evidence", "refs", `${evidenceId}.json`)) : undefined;
  assertEvidencePathSafe(layout.evidence, object);
  if (ref) assertEvidencePathSafe(layout.evidence, ref);
  return {
    object,
    ...(ref ? { ref } : {}),
    relativeObject
  };
}

function assertEvidencePathSafe(evidenceRoot: string, candidate: string): void {
  const root = path.resolve(evidenceRoot);
  const target = path.resolve(candidate);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Workspace evidence root is not a regular directory.");
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Evidence path escaped the Workspace evidence root.");
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Evidence path contains a symbolic link.");
    if (current !== target && !stat.isDirectory()) throw new Error("Evidence path contains a non-directory ancestor.");
    if (current === target && !stat.isFile()) throw new Error("Evidence target is not a regular file.");
  }
}

function refIdentity(input: EvidenceStoreInput, hash: string, mediaType: string): string {
  const identity = JSON.stringify({
    hash,
    source: input.source,
    media_type: mediaType,
    trust_level: input.trust_level,
    target_scope: [...new Set(input.target_scope ?? [])].sort(),
    verification_relevance: input.verification_relevance ?? "supporting",
    relationships: [...(input.relationships ?? [])]
      .map(relationship => ({ evidence_id: relationship.evidence_id, relation: relationship.relation }))
      .sort((left, right) => `${left.evidence_id}:${left.relation}`.localeCompare(`${right.evidence_id}:${right.relation}`)),
    session_id: input.scope.session_id,
    assignment_id: input.scope.assignment_id ?? null,
    run_id: input.scope.run_id ?? null,
    attempt_id: input.scope.attempt_id ?? null,
    generation: input.scope.generation ?? null
  });
  return `ev1_${createHash("sha256").update(identity).digest("base64url").slice(0, 32)}`;
}

export function appendEvidenceTelemetry(event: Omit<EvidenceTelemetryEventV1, "schema" | "recorded_at_utc">): void {
  const layout = ensureWorkspaceLayout();
  const telemetryPath = resolveFileUnderWorkspace(path.posix.join("evidence", "telemetry.jsonl"));
  assertEvidencePathSafe(layout.evidence, telemetryPath);
  atomicAppendJsonlLine(telemetryPath, {
    schema: EVIDENCE_TELEMETRY_SCHEMA,
    recorded_at_utc: new Date().toISOString(),
    ...event
  } satisfies EvidenceTelemetryEventV1);
}

export function readEvidenceTelemetrySummary(filter: { session_id?: string; assignment_id?: string | null } = {}): {
  event_count: number;
  raw_evidence_bytes_produced: number;
  unique_evidence_bytes_stored: number;
  projected_bytes_sent: number;
  duplicate_bytes_avoided: number;
  evidence_items_expanded: number;
  budget_events: number;
  estimated_model_tokens_avoided: number;
  largest_evidence_producers: Array<{ source: string; raw_bytes: number; projected_bytes: number }>;
} {
  const telemetryPath = resolveFileUnderWorkspace(path.posix.join("evidence", "telemetry.jsonl"));
  assertEvidencePathSafe(ensureWorkspaceLayout().evidence, telemetryPath);
  const events: EvidenceTelemetryEventV1[] = [];
  if (fs.existsSync(telemetryPath)) {
    for (const line of fs.readFileSync(telemetryPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as EvidenceTelemetryEventV1;
        if (event.schema !== EVIDENCE_TELEMETRY_SCHEMA) continue;
        if (filter.session_id && event.session_id !== filter.session_id) continue;
        if (Object.prototype.hasOwnProperty.call(filter, "assignment_id") && event.assignment_id !== filter.assignment_id) continue;
        events.push(event);
      } catch {}
    }
  }
  const bySource = new Map<string, { raw_bytes: number; projected_bytes: number }>();
  for (const event of events) {
    const current = bySource.get(event.source) ?? { raw_bytes: 0, projected_bytes: 0 };
    current.raw_bytes += event.raw_evidence_bytes_produced;
    current.projected_bytes += event.projected_bytes_sent;
    bySource.set(event.source, current);
  }
  const sum = (key: keyof EvidenceTelemetryEventV1): number => events.reduce((total, event) => total + (typeof event[key] === "number" ? event[key] as number : 0), 0);
  return {
    event_count: events.length,
    raw_evidence_bytes_produced: sum("raw_evidence_bytes_produced"),
    unique_evidence_bytes_stored: sum("unique_evidence_bytes_stored"),
    projected_bytes_sent: sum("projected_bytes_sent"),
    duplicate_bytes_avoided: sum("duplicate_bytes_avoided"),
    evidence_items_expanded: sum("evidence_items_expanded"),
    budget_events: sum("budget_events"),
    estimated_model_tokens_avoided: sum("estimated_model_tokens_avoided"),
    largest_evidence_producers: [...bySource.entries()]
      .map(([source, value]) => ({ source, ...value }))
      .sort((a, b) => b.raw_bytes - a.raw_bytes || b.projected_bytes - a.projected_bytes || a.source.localeCompare(b.source))
      .slice(0, 20)
  };
}

export function storeEvidence(input: EvidenceStoreInput, projectionMaxBytes = 8_192): EvidenceStoreResult {
  const sessionId = scopePart(input.scope.session_id, "scope.session_id", true)!;
  const assignmentId = scopePart(input.scope.assignment_id, "scope.assignment_id");
  const runId = scopePart(input.scope.run_id, "scope.run_id");
  const attemptId = scopePart(input.scope.attempt_id, "scope.attempt_id");
  if (input.scope.generation != null && (!Number.isSafeInteger(input.scope.generation) || input.scope.generation < 0)) throw new Error("scope.generation must be a non-negative integer.");
  const source = safeBounded(input.source, 240, "source", true);
  const mediaType = safeBounded(input.media_type || (Buffer.isBuffer(input.raw) ? "application/octet-stream" : typeof input.raw === "string" ? "text/plain; charset=utf-8" : "application/json"), 160, "media_type", true).toLowerCase();
  const bytes = rawBytes(input.raw, mediaType);
  assertSecretFree(bytes, mediaType);
  const hash = sha256(bytes);
  const evidenceId = refIdentity(input, hash, mediaType);
  const paths = evidencePaths(hash, evidenceId);
  const objectCreated = writeImmutable(paths.object, bytes);
  const parsed = parseRaw(bytes, mediaType);
  const extracted = extractDeterministicEvidenceFacts(parsed);
  const summary = safeBounded(input.bounded_summary || `${source} evidence (${bytes.length} bytes, sha256:${hash.slice(0, 12)}).`, 600, "bounded_summary", true);
  const ref: EvidenceRefV1 = {
    schema: EVIDENCE_REF_SCHEMA,
    evidence_id: evidenceId,
    content_hash: `sha256:${hash}`,
    byte_count: bytes.length,
    media_type: mediaType,
    source,
    trust_level: input.trust_level,
    assignment_id: assignmentId,
    run_id: runId,
    attempt_id: attemptId,
    generation: input.scope.generation ?? null,
    session_id: sessionId,
    target_scope: [...new Set([...(input.target_scope ?? []), ...extracted.targets].map(value => safeBounded(value, 160, "target_scope")))].filter(Boolean).slice(0, 64),
    bounded_summary: summary,
    key_typed_facts: Object.fromEntries(Object.entries(extracted.facts).slice(0, 48)),
    artifact_location: paths.relativeObject,
    redaction_status: /(?:json|text|xml|javascript|csv|yaml|form)/i.test(mediaType) ? "screened" : "not_needed",
    secret_screening_status: "passed",
    created_at_utc: new Date().toISOString(),
    verification_relevance: input.verification_relevance ?? "supporting",
    relationships: (input.relationships ?? []).slice(0, 64)
  };
  atomicWriteNewJson(paths.ref!, ref);
  const settledRef = readRef(evidenceId);
  const projection = projectEvidence(settledRef, parsed, projectionMaxBytes);
  appendEvidenceTelemetry({
    session_id: sessionId,
    assignment_id: assignmentId,
    model_call_id: null,
    source,
    raw_evidence_bytes_produced: bytes.length,
    unique_evidence_bytes_stored: objectCreated ? bytes.length : 0,
    projected_bytes_sent: 0,
    duplicate_bytes_avoided: objectCreated ? 0 : bytes.length,
    evidence_items_expanded: 0,
    budget_events: projection.truncated ? 1 : 0,
    estimated_model_tokens_avoided: null
  });
  return { ref: settledRef, projection, stored_unique_bytes: objectCreated ? bytes.length : 0, duplicate_bytes_avoided: objectCreated ? 0 : bytes.length };
}

function readRef(evidenceId: string): EvidenceRefV1 {
  if (!/^ev1_[A-Za-z0-9_-]{32}$/.test(evidenceId)) throw new Error("Invalid evidence_id.");
  const refPath = resolveFileUnderWorkspace(path.posix.join("evidence", "refs", `${evidenceId}.json`));
  if (!fs.existsSync(refPath)) throw new Error("Evidence not found.");
  assertEvidencePathSafe(ensureWorkspaceLayout().evidence, refPath);
  const ref = JSON.parse(fs.readFileSync(refPath, "utf8")) as EvidenceRefV1;
  if (ref.schema !== EVIDENCE_REF_SCHEMA || ref.evidence_id !== evidenceId) throw new Error("Invalid evidence reference.");
  return ref;
}

function assertScope(ref: EvidenceRefV1, request: EvidenceRetrievalRequest): void {
  const sessionId = scopePart(request.scope.session_id, "scope.session_id", true);
  const assignmentId = scopePart(request.scope.assignment_id, "scope.assignment_id");
  if (ref.session_id !== sessionId) throw new Error("Evidence is outside the requested session scope.");
  if (ref.assignment_id !== assignmentId) throw new Error("Evidence is outside the requested Assignment scope.");
  if (request.scope.run_id != null && ref.run_id !== scopePart(request.scope.run_id, "scope.run_id")) throw new Error("Evidence is outside the requested run scope.");
  if (request.scope.attempt_id != null && ref.attempt_id !== scopePart(request.scope.attempt_id, "scope.attempt_id")) throw new Error("Evidence is outside the requested attempt scope.");
  if (request.scope.generation != null && ref.generation !== request.scope.generation) throw new Error("Evidence is outside the requested Assignment generation.");
}

function readSettledEvidenceBytes(ref: EvidenceRefV1): Buffer {
  const layout = ensureWorkspaceLayout();
  const objectPath = resolveFileUnderWorkspace(ref.artifact_location);
  assertEvidencePathSafe(layout.evidence, objectPath);
  const bytes = fs.readFileSync(objectPath);
  if (`sha256:${sha256(bytes)}` !== ref.content_hash || bytes.length !== ref.byte_count) throw new Error("Evidence content hash verification failed.");
  return bytes;
}

function selectPath(root: unknown, dottedPath: string): unknown {
  if (!dottedPath || dottedPath === "$" || dottedPath.includes("..") || /[\\/\u0000]/.test(dottedPath)) throw new Error("Invalid typed field path.");
  const segments = dottedPath.replace(/^\$\.?/, "").split(".");
  if (segments.some(segment => !segment || segment === "__proto__" || segment === "constructor" || segment === "prototype")) {
    throw new Error("Invalid typed field path.");
  }
  let value: unknown = root;
  for (let index = 0; index < segments.length;) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    let matchedKey: string | null = null;
    let nextIndex = index;
    // Projections flatten object paths with dots. A trusted result can also
    // contain a literal dotted key (for example the `payload.items` key in an
    // evidence-retrieval selection), so prefer the longest exact own-property
    // match at each level. This keeps every advertised projection selector
    // retrievable without interpreting code or weakening scope/hash checks.
    for (let end = segments.length; end > index; end -= 1) {
      const candidate = segments.slice(index, end).join(".");
      if (!Object.prototype.hasOwnProperty.call(row, candidate)) continue;
      matchedKey = candidate;
      nextIndex = end;
      break;
    }
    if (!matchedKey) return null;
    value = row[matchedKey];
    index = nextIndex;
  }
  return value;
}

function retrievalRoot(value: unknown): unknown {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!row) return value;
  const looksLikeMcpEnvelope = Array.isArray(row.content)
    || Object.prototype.hasOwnProperty.call(row, "structuredContent");
  if (!looksLikeMcpEnvelope) {
    if (Object.prototype.hasOwnProperty.call(row, "payload")) return value;
    // OperationResultV2 persists the normalized semantic payload itself rather
    // than the original MCP envelope. Keep direct root selectors available for
    // historical callers while exposing the same payload.<field> contract that
    // projections advertise for MCP-carried JSON.
    return { ...row, payload: row };
  }
  const structured = extractMcpStructuredPayload(value);
  const { payload: _untrustedPayload, ...envelope } = row;
  return structured ? { ...envelope, payload: structured.payload } : envelope;
}

export function retrieveEvidence(request: EvidenceRetrievalRequest): EvidenceRetrievalResult {
  const purpose = safeBounded(request.purpose, 300, "purpose", true);
  if (/^(?:all|all evidence|everything|dump all evidence)$/i.test(purpose)) throw new Error("Focused evidence retrieval purpose is required.");
  const selector = parseEvidenceRetrievalSelectorV1(request);
  const maxBytes = Math.max(64, Math.min(Number.isSafeInteger(request.max_bytes) ? request.max_bytes! : 16_384, 1_048_576));
  const ref = readRef(request.evidence_id);
  assertScope(ref, request);
  const bytes = readSettledEvidenceBytes(ref);
  let selection: unknown;
  let complete = false;
  const parsed = parseRaw(bytes, ref.media_type);
  const selectable = retrievalRoot(parsed);
  if (selector.kind === "image") {
    if (!ref.media_type.startsWith("image/")) throw new Error("Selected evidence is not an image.");
    if (bytes.length > maxBytes) throw new Error("Selected image exceeds the authorized retrieval byte limit.");
    selection = { media_type: ref.media_type, data_base64: bytes.toString("base64") };
    complete = true;
  } else if (selector.kind === "text_range") {
    const start = selector.text_range.start;
    const length = Math.min(selector.text_range.length, maxBytes);
    selection = bytes.subarray(start, Math.min(bytes.length, start + length)).toString("utf8");
    complete = start === 0 && length >= bytes.length;
  } else if (selector.kind === "item_range") {
    const array = selectPath(selectable, selector.item_range.path);
    if (!Array.isArray(array)) throw new Error("item_range.path must select an array.");
    const start = selector.item_range.start;
    const count = selector.item_range.count;
    selection = array.slice(start, start + count);
    complete = start === 0 && count >= array.length;
  } else if (selector.kind === "fields") {
    selection = Object.fromEntries(selector.fields.map(field => [field, selectPath(selectable, field)]));
  } else {
    const selectableRecord = selectable && typeof selectable === "object" && !Array.isArray(selectable)
      ? selectable as Record<string, unknown>
      : null;
    const semanticPayload = selectableRecord && Object.prototype.hasOwnProperty.call(selectableRecord, "payload")
      ? selectableRecord.payload
      : selectable;
    selection = selectExactEvidenceTargetsV1(semanticPayload, selector.target_subset).selection;
  }
  const selectedBytes = Buffer.byteLength(JSON.stringify(selection), "utf8");
  if (selectedBytes > maxBytes) throw new Error(`Focused evidence selection exceeds ${maxBytes}-byte limit.`);
  appendEvidenceTelemetry({
    session_id: ref.session_id,
    assignment_id: ref.assignment_id,
    model_call_id: null,
    source: `retrieval:${ref.source}`,
    raw_evidence_bytes_produced: 0,
    unique_evidence_bytes_stored: 0,
    projected_bytes_sent: selectedBytes,
    duplicate_bytes_avoided: 0,
    evidence_items_expanded: 1,
    budget_events: 0,
    estimated_model_tokens_avoided: null
  });
  return { schema: EVIDENCE_RETRIEVAL_SCHEMA, evidence_ref: ref, selection, returned_bytes: selectedBytes, complete };
}

export function readAuthoritativeEvidence(ref: EvidenceRefV1, scope: EvidenceRetrievalRequest["scope"]): Buffer {
  const canonical = readRef(ref.evidence_id);
  assertScope(canonical, { evidence_id: canonical.evidence_id, scope, purpose: "authoritative verifier read", text_range: { start: 0, length: 1 } });
  return readSettledEvidenceBytes(canonical);
}

export function readEvidenceRef(evidenceId: string): EvidenceRefV1 {
  return readRef(evidenceId);
}

export function hydratePersistedToolOutputRecord(record: Record<string, unknown>): Record<string, unknown> {
  try {
    if (record.kind === "revit.result") {
      const toolResult = record.tool_result && typeof record.tool_result === "object" ? record.tool_result as Record<string, unknown> : null;
      const refs = Array.isArray(toolResult?.evidence_refs) ? toolResult.evidence_refs : [];
      const primary = refs.find(value => value && typeof value === "object" && (value as any).media_type?.includes("json")) as EvidenceRefV1 | undefined;
      if (primary) {
        const canonical = readRef(primary.evidence_id);
        const hydrated = JSON.parse(readAuthoritativeEvidence(canonical, {
          session_id: canonical.session_id,
          assignment_id: canonical.assignment_id,
          run_id: canonical.run_id,
          attempt_id: canonical.attempt_id,
          generation: canonical.generation
        }).toString("utf8"));
        return { ...record, tool_result: { ...hydrated, evidence_refs: refs, evidence_projections: toolResult?.evidence_projections ?? [] } };
      }
    }
    if (record.kind === "mcp.tool_result" && record.result === undefined) {
      const refs = Array.isArray(record.evidence_refs) ? record.evidence_refs : [];
      const primary = refs.find(value => value && typeof value === "object" && (value as any).media_type?.includes("json")) as EvidenceRefV1 | undefined;
      if (primary) {
        const canonical = readRef(primary.evidence_id);
        const result = JSON.parse(readAuthoritativeEvidence(canonical, {
          session_id: canonical.session_id,
          assignment_id: canonical.assignment_id,
          run_id: canonical.run_id,
          attempt_id: canonical.attempt_id,
          generation: canonical.generation
        }).toString("utf8"));
        return { ...record, result };
      }
    }
  } catch {
    // Historical/corrupt evidence remains visible as its immutable reference;
    // readers must not invent raw evidence when hash verification fails.
  }
  return record;
}
