import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../contracts.js";
import { atomicAppendJsonlLine } from "../persistence/jsonl.js";
import { getRequestPrincipal } from "../request_context.js";
import { ensureWorkspaceLayout } from "../workspace.js";

export const REQUIREMENTS_SCHEMA = "revit-operator.requirement-revision.v1" as const;
export const REQUIREMENTS_RECEIPT_SCHEMA = "revit-operator.requirements-receipt.v1" as const;

export type RequirementScopeKind = "office" | "engineer" | "project" | "client";
export type RequirementStatus = "active" | "retired";
export type RequirementScopeRef = { kind: RequirementScopeKind; id: string };
export type RequirementEvidenceRef = { type: string; ref: string; note?: string };

export type RequirementRevision = {
  schema: typeof REQUIREMENTS_SCHEMA;
  event_id: string;
  requirement_id: string;
  revision: number;
  status: RequirementStatus;
  scope: RequirementScopeRef;
  key: string;
  text: string;
  tags: string[];
  effective_from: string;
  effective_until: string | null;
  supersedes_requirement_ids: string[];
  provenance: {
    source: string;
    captured_at: string;
    session_id: string | null;
    actor_id: string | null;
    evidence: RequirementEvidenceRef[];
  };
};

export type RequirementReceiptEntry = {
  requirement_id: string;
  revision: number;
  scope: RequirementScopeRef;
  key: string;
  text: string;
  reason: "highest_precedence" | "duplicate" | "lower_precedence" | "superseded";
};

export type RequirementsReceipt = {
  schema: typeof REQUIREMENTS_RECEIPT_SCHEMA;
  generated_at: string;
  status: "resolved" | "conflict" | "overflow";
  query: string;
  scope_refs: RequirementScopeRef[];
  applied: RequirementReceiptEntry[];
  suppressed: RequirementReceiptEntry[];
  conflicts: Array<{
    key: string;
    precedence: number;
    requirements: Array<Pick<RequirementReceiptEntry, "requirement_id" | "revision" | "scope" | "text">>;
  }>;
  overflow: { applied_count: number; suppressed_count: number; conflict_count: number; max_results: number } | null;
  receipt_sha256: string;
};

type RequirementWriteBase = {
  scope: RequirementScopeRef;
  key: string;
  text: string;
  tags?: string[];
  effective_from?: string | null;
  effective_until?: string | null;
  supersedes_requirement_ids?: string[];
  source?: string | null;
  session_id?: string | null;
  actor_id?: string | null;
  evidence?: RequirementEvidenceRef[];
};

const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_REQUIREMENTS = 10_000;
const MAX_TEXT_CHARS = 2_000;
const MAX_QUERY_CHARS = 1_000;
const SCOPE_PRECEDENCE: Record<RequirementScopeKind, number> = {
  engineer: 100,
  office: 200,
  client: 300,
  project: 400
};
const activePlanningLeases = new Map<string, Map<string, string>>();

function nowIso(): string {
  return new Date().toISOString();
}

function ledgerPath(): string {
  return path.join(ensureWorkspaceLayout().memory, "requirements.v1.jsonl");
}

export type RequirementsPlanningLease = { ledger_path: string; lease_path: string; token: string; receipt_sha256: string };

function planningLeaseDirectory(p = ledgerPath()): string {
  return `${p}.planning-leases`;
}

export function beginRequirementsPlanningLease(receiptSha256: string): RequirementsPlanningLease {
  const hash = String(receiptSha256 ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("receipt_sha256 is invalid for a requirements planning lease.");
  return withRequirementsWriteLock(() => {
    const ledger_path = ledgerPath();
    const token = `reqlease_${randomUUID()}`;
    const leaseDir = planningLeaseDirectory(ledger_path);
    const lease_path = path.join(leaseDir, `${token}.json`);
    fs.mkdirSync(leaseDir, { recursive: true });
    let fd: number | null = null;
    try {
      fd = fs.openSync(lease_path, "wx");
      fs.writeFileSync(fd, JSON.stringify({ token, receipt_sha256: hash, pid: process.pid, created_at: nowIso() }) + "\n", "utf8");
      fs.fsyncSync(fd);
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
        try { fs.unlinkSync(lease_path); } catch { /* best effort */ }
      }
      throw error;
    }
    try { fs.closeSync(fd); } catch { /* best effort */ }
    const leases = activePlanningLeases.get(ledger_path) ?? new Map<string, string>();
    leases.set(token, hash);
    activePlanningLeases.set(ledger_path, leases);
    return { ledger_path, lease_path, token, receipt_sha256: hash };
  });
}

export function endRequirementsPlanningLease(lease: RequirementsPlanningLease | null | undefined): void {
  if (!lease) return;
  const leases = activePlanningLeases.get(lease.ledger_path);
  if (leases) {
    leases.delete(lease.token);
    if (leases.size === 0) activePlanningLeases.delete(lease.ledger_path);
  }
  const expectedDir = planningLeaseDirectory(lease.ledger_path);
  if (path.dirname(lease.lease_path) === expectedDir && path.basename(lease.lease_path) === `${lease.token}.json`) {
    try { fs.unlinkSync(lease.lease_path); } catch { /* a missing lease is harmless during release */ }
  }
}

function assertRequirementsWriteUnlocked(p = ledgerPath()): void {
  const leases = activePlanningLeases.get(p);
  if (leases && leases.size > 0) throw new Error("Requirements write blocked by an active planning lease; retry after the current plan finishes.");
  const leaseDir = planningLeaseDirectory(p);
  try {
    if (fs.readdirSync(leaseDir).length > 0) throw new Error("Requirements write blocked by an active planning lease; retry after the current plan finishes.");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    if (code !== "ENOENT") throw error;
  }
}

function waitMilliseconds(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function withRequirementsWriteLock<T>(fn: () => T): T {
  const p = ledgerPath();
  const lockPath = `${p}.write.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 2_000;
  let fd: number | null = null;
  while (fd === null) {
    let candidate: number | null = null;
    try {
      candidate = fs.openSync(lockPath, "wx");
      fs.writeFileSync(candidate, JSON.stringify({ pid: process.pid, created_at: nowIso() }) + "\n", "utf8");
      fs.fsyncSync(candidate);
      fd = candidate;
    } catch (error) {
      if (candidate !== null) {
        try { fs.closeSync(candidate); } catch { /* best effort */ }
        try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
      }
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
      if (code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Requirements write lock is busy or stale: ${lockPath}`);
      waitMilliseconds(25);
    }
  }
  try {
    assertRequirementsWriteUnlocked(p);
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(lockPath); } catch { /* a missing lock is harmless after the write completed */ }
  }
}

function compactText(value: unknown, max: number, label: string): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters.`);
  return text;
}

function normalizeId(value: unknown, label: string): string {
  const raw = compactText(value, 180, label);
  const clean = raw.toLowerCase().replace(/[^a-z0-9._:-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!clean) throw new Error(`${label} is invalid.`);
  return clean;
}

function normalizeRequirementId(value: unknown, label = "requirement_id"): string {
  const raw = compactText(value, 160, label);
  if (!/^req_[a-zA-Z0-9-]{8,}$/.test(raw)) throw new Error(`${label} is invalid.`);
  return raw;
}

function normalizeScope(value: unknown): RequirementScopeRef {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const kind = String(row.kind ?? "").trim().toLowerCase() as RequirementScopeKind;
  if (!(kind in SCOPE_PRECEDENCE)) throw new Error("scope.kind must be office, engineer, project, or client.");
  return { kind, id: normalizeId(row.id, "scope.id") };
}

function normalizeKey(value: unknown): string {
  const raw = compactText(value, 160, "key").toLowerCase();
  const clean = raw.replace(/[^a-z0-9_.-]+/g, ".").replace(/\.+/g, ".").replace(/^\.+|\.+$/g, "");
  if (!clean) throw new Error("key is invalid.");
  return clean;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 16) throw new Error("tags exceeds 16 entries.");
  const out = new Set<string>();
  for (const item of value) {
    out.add(normalizeId(item, "tag"));
  }
  return [...out].sort();
}

function normalizeEvidence(value: unknown): RequirementEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 8) throw new Error("evidence exceeds 8 entries.");
  const out: RequirementEvidenceRef[] = [];
  for (const item of value) {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : null;
    if (!row) throw new Error("evidence entries must be objects.");
    const type = normalizeId(row.type, "evidence.type");
    const ref = compactText(row.ref, 500, "evidence.ref");
    const noteRaw = String(row.note ?? "").replace(/\s+/g, " ").trim();
    if (noteRaw.length > 500) throw new Error("evidence.note exceeds 500 characters.");
    out.push({ type, ref, ...(noteRaw ? { note: noteRaw } : {}) });
  }
  return out;
}

function normalizeIso(value: unknown, fallback: string, label: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO-8601 date/time.`);
  return new Date(time).toISOString();
}

function normalizeUntil(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  return raw ? normalizeIso(raw, "", "effective_until") : null;
}

function normalizeSupersedes(value: unknown, ownId?: string): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 24) throw new Error("supersedes_requirement_ids exceeds 24 entries.");
  const out = new Set<string>();
  for (const item of value.slice(0, 24)) {
    const id = normalizeRequirementId(item, "supersedes_requirement_id");
    if (id !== ownId) out.add(id);
  }
  return [...out].sort();
}

function parseRevision(value: unknown): RequirementRevision | null {
  try {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (row.schema !== REQUIREMENTS_SCHEMA) return null;
    const status = row.status === "retired" ? "retired" : row.status === "active" ? "active" : null;
    if (!status) return null;
    const provenance = row.provenance && typeof row.provenance === "object" ? row.provenance as Record<string, unknown> : {};
    const revision = Number(row.revision);
    if (!Number.isInteger(revision) || revision < 1) return null;
    return {
      schema: REQUIREMENTS_SCHEMA,
      event_id: compactText(row.event_id, 160, "event_id"),
      requirement_id: normalizeRequirementId(row.requirement_id),
      revision,
      status,
      scope: normalizeScope(row.scope),
      key: normalizeKey(row.key),
      text: compactText(row.text, MAX_TEXT_CHARS, "text"),
      tags: normalizeTags(row.tags),
      effective_from: normalizeIso(row.effective_from, nowIso(), "effective_from"),
      effective_until: normalizeUntil(row.effective_until),
      supersedes_requirement_ids: normalizeSupersedes(row.supersedes_requirement_ids, String(row.requirement_id ?? "")),
      provenance: {
        source: compactText(provenance.source, 120, "provenance.source"),
        captured_at: normalizeIso(provenance.captured_at, nowIso(), "provenance.captured_at"),
        session_id: String(provenance.session_id ?? "").trim().slice(0, 180) || null,
        actor_id: String(provenance.actor_id ?? "").trim().slice(0, 180) || null,
        evidence: normalizeEvidence(provenance.evidence)
      }
    };
  } catch {
    return null;
  }
}

function readAllRevisions(): RequirementRevision[] {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return [];
  const stat = fs.statSync(p);
  if (!stat.isFile()) throw new Error("Requirements ledger path is not a file.");
  if (stat.size > MAX_LEDGER_BYTES) throw new Error(`Requirements ledger exceeds ${MAX_LEDGER_BYTES} bytes; compact or archive it before writing.`);
  const revisions: RequirementRevision[] = [];
  let lineNumber = 0;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    lineNumber++;
    if (!line.trim()) continue;
    try {
      const parsed = parseRevision(JSON.parse(line));
      if (!parsed) throw new Error("unsupported or malformed requirement revision");
      revisions.push(parsed);
    } catch (error) {
      throw new Error(`Requirements ledger is malformed at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (revisions.length > MAX_REQUIREMENTS * 20) throw new Error("Requirements ledger contains too many revision rows.");
  revisions.sort((a, b) => a.requirement_id.localeCompare(b.requirement_id) || a.revision - b.revision || a.event_id.localeCompare(b.event_id));
  return revisions;
}

function latestMap(): Map<string, RequirementRevision> {
  const out = new Map<string, RequirementRevision>();
  for (const row of readAllRevisions()) {
    const existing = out.get(row.requirement_id);
    if (!existing || row.revision > existing.revision || (row.revision === existing.revision && row.event_id > existing.event_id)) out.set(row.requirement_id, row);
  }
  return out;
}

function appendRevision(row: RequirementRevision): string {
  const p = ledgerPath();
  const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
  const rowBytes = Buffer.byteLength(JSON.stringify(row) + "\n", "utf8");
  if (size + rowBytes > MAX_LEDGER_BYTES) throw new Error(`Requirements ledger would exceed ${MAX_LEDGER_BYTES} bytes; write refused.`);
  atomicAppendJsonlLine(p, row);
  return p;
}

function validateSupersessionLinks(requirement: RequirementRevision, current: Map<string, RequirementRevision>): void {
  for (const id of requirement.supersedes_requirement_ids) {
    const target = current.get(id);
    if (!target) throw new Error(`Superseded requirement not found: ${id}`);
    if (target.status !== "active") throw new Error(`Superseded requirement is not active: ${id}`);
    if (target.key !== requirement.key || target.scope.kind !== requirement.scope.kind || target.scope.id !== requirement.scope.id) {
      throw new Error(`Supersession must keep the same scope and key: ${id}`);
    }
  }
}

function buildRevision(args: RequirementWriteBase & { requirement_id: string; revision: number; status: RequirementStatus; captured_at?: string }): RequirementRevision {
  const capturedAt = normalizeIso(args.captured_at, nowIso(), "captured_at");
  const effectiveFrom = normalizeIso(args.effective_from, capturedAt, "effective_from");
  const effectiveUntil = normalizeUntil(args.effective_until);
  if (effectiveUntil && effectiveUntil <= effectiveFrom) throw new Error("effective_until must be after effective_from.");
  return {
    schema: REQUIREMENTS_SCHEMA,
    event_id: `reqevt_${randomUUID()}`,
    requirement_id: normalizeRequirementId(args.requirement_id),
    revision: args.revision,
    status: args.status,
    scope: normalizeScope(args.scope),
    key: normalizeKey(args.key),
    text: compactText(args.text, MAX_TEXT_CHARS, "text"),
    tags: normalizeTags(args.tags),
    effective_from: effectiveFrom,
    effective_until: effectiveUntil,
    supersedes_requirement_ids: normalizeSupersedes(args.supersedes_requirement_ids, args.requirement_id),
    provenance: {
      source: compactText(args.source ?? "manual", 120, "source"),
      captured_at: capturedAt,
      session_id: String(args.session_id ?? "").trim().slice(0, 180) || null,
      actor_id: String(getRequestPrincipal()?.user_id ?? args.actor_id ?? "").trim().slice(0, 180) || null,
      evidence: normalizeEvidence(args.evidence)
    }
  };
}

export function createRequirement(args: RequirementWriteBase): { ok: true; requirement: RequirementRevision; ledger_path: string } {
  assertRequirementsWriteUnlocked();
  return withRequirementsWriteLock(() => {
    const current = latestMap();
    if (current.size >= MAX_REQUIREMENTS) throw new Error(`Requirement limit of ${MAX_REQUIREMENTS} reached.`);
    const requirementId = `req_${randomUUID()}`;
    const requirement = buildRevision({ ...args, requirement_id: requirementId, revision: 1, status: "active" });
    validateSupersessionLinks(requirement, current);
    return { ok: true, requirement, ledger_path: appendRevision(requirement) };
  });
}

export function reviseRequirement(args: RequirementWriteBase & { requirement_id: string; expected_revision: number }): { ok: true; requirement: RequirementRevision; ledger_path: string } {
  assertRequirementsWriteUnlocked();
  return withRequirementsWriteLock(() => {
    const id = normalizeRequirementId(args.requirement_id);
    const currentMap = latestMap();
    const current = currentMap.get(id);
    if (!current) throw new Error(`Requirement not found: ${id}`);
    if (current.revision !== args.expected_revision) throw new Error(`Revision conflict for ${id}: expected ${args.expected_revision}, actual ${current.revision}.`);
    if (current.status !== "active") throw new Error(`Requirement ${id} is retired and cannot be revised.`);
    const requirement = buildRevision({ ...args, requirement_id: id, revision: current.revision + 1, status: "active" });
    validateSupersessionLinks(requirement, currentMap);
    return { ok: true, requirement, ledger_path: appendRevision(requirement) };
  });
}

export function retireRequirement(args: { requirement_id: string; expected_revision: number; source?: string | null; session_id?: string | null; actor_id?: string | null; evidence?: RequirementEvidenceRef[] }): { ok: true; requirement: RequirementRevision; ledger_path: string } {
  assertRequirementsWriteUnlocked();
  return withRequirementsWriteLock(() => {
    const id = normalizeRequirementId(args.requirement_id);
    const current = latestMap().get(id);
    if (!current) throw new Error(`Requirement not found: ${id}`);
    if (current.revision !== args.expected_revision) throw new Error(`Revision conflict for ${id}: expected ${args.expected_revision}, actual ${current.revision}.`);
    if (current.status === "retired") throw new Error(`Requirement ${id} is already retired.`);
    const requirement = buildRevision({
      ...current,
      source: args.source ?? "manual.retire",
      session_id: args.session_id ?? current.provenance.session_id,
      actor_id: args.actor_id ?? current.provenance.actor_id,
      evidence: args.evidence ?? current.provenance.evidence,
      requirement_id: id,
      revision: current.revision + 1,
      status: "retired"
    });
    return { ok: true, requirement, ledger_path: appendRevision(requirement) };
  });
}

export function listRequirements(args: { scope?: RequirementScopeRef; status?: RequirementStatus | "all"; limit?: number } = {}): RequirementRevision[] {
  const scope = args.scope ? normalizeScope(args.scope) : null;
  const status = args.status ?? "active";
  const limit = Math.max(1, Math.min(500, Math.floor(args.limit ?? 200)));
  return [...latestMap().values()]
    .filter(row => !scope || (row.scope.kind === scope.kind && row.scope.id === scope.id))
    .filter(row => status === "all" || row.status === status)
    .sort((a, b) => a.scope.kind.localeCompare(b.scope.kind) || a.scope.id.localeCompare(b.scope.id) || a.key.localeCompare(b.key) || a.requirement_id.localeCompare(b.requirement_id))
    .slice(0, limit);
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/g).filter(part => part.length >= 2));
}

function scopeKey(scope: RequirementScopeRef): string {
  return `${scope.kind}:${scope.id}`;
}

function receiptEntry(row: RequirementRevision, reason: RequirementReceiptEntry["reason"]): RequirementReceiptEntry {
  return { requirement_id: row.requirement_id, revision: row.revision, scope: row.scope, key: row.key, text: row.text, reason };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function resolveRequirements(args: { scope_refs: RequirementScopeRef[]; query?: string; at?: string; max_results?: number }): RequirementsReceipt {
  const generatedAt = nowIso();
  const at = normalizeIso(args.at, generatedAt, "at");
  const query = String(args.query ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
  const queryTokens = tokenize(query);
  const scopes = [...new Map((Array.isArray(args.scope_refs) ? args.scope_refs : []).map(normalizeScope).map(scope => [scopeKey(scope), scope])).values()]
    .sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
  const allowedScopes = new Set(scopes.map(scopeKey));
  const maxResults = Math.max(1, Math.min(200, Math.floor(args.max_results ?? 80)));

  let active = [...latestMap().values()].filter(row =>
    row.status === "active" &&
    allowedScopes.has(scopeKey(row.scope)) &&
    row.effective_from <= at &&
    (!row.effective_until || row.effective_until > at)
  );
  active.sort((a, b) => a.key.localeCompare(b.key) || b.revision - a.revision || a.requirement_id.localeCompare(b.requirement_id));

  const explicitlySuperseded = new Set(active.flatMap(row => row.supersedes_requirement_ids));
  const suppressed: RequirementReceiptEntry[] = [];
  let remaining = active.filter(row => {
    if (!explicitlySuperseded.has(row.requirement_id)) return true;
    suppressed.push(receiptEntry(row, "superseded"));
    return false;
  });
  if (queryTokens.size > 0) {
    remaining = remaining.filter(row => {
      const tokens = tokenize(`${row.key} ${row.text} ${row.tags.join(" ")}`);
      for (const token of queryTokens) if (tokens.has(token)) return true;
      return false;
    });
  }

  const byKey = new Map<string, RequirementRevision[]>();
  for (const row of remaining) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
  const applied: RequirementReceiptEntry[] = [];
  const conflicts: RequirementsReceipt["conflicts"] = [];

  for (const key of [...byKey.keys()].sort()) {
    const rows = byKey.get(key)!;
    const topPrecedence = Math.max(...rows.map(row => SCOPE_PRECEDENCE[row.scope.kind]));
    const top = rows.filter(row => SCOPE_PRECEDENCE[row.scope.kind] === topPrecedence);
    const texts = new Map<string, RequirementRevision[]>();
    for (const row of top) {
      const normalizedText = row.text.toLowerCase().replace(/\s+/g, " ").trim();
      texts.set(normalizedText, [...(texts.get(normalizedText) ?? []), row]);
    }
    if (texts.size > 1) {
      conflicts.push({
        key,
        precedence: topPrecedence,
        requirements: top
          .sort((a, b) => a.requirement_id.localeCompare(b.requirement_id))
          .map(row => ({ requirement_id: row.requirement_id, revision: row.revision, scope: row.scope, text: row.text }))
      });
      for (const row of rows.filter(row => SCOPE_PRECEDENCE[row.scope.kind] < topPrecedence)) suppressed.push(receiptEntry(row, "lower_precedence"));
      continue;
    }
    const winner = [...top].sort((a, b) => a.requirement_id.localeCompare(b.requirement_id))[0]!;
    applied.push(receiptEntry(winner, "highest_precedence"));
    for (const row of rows) {
      if (row.requirement_id === winner.requirement_id) continue;
      suppressed.push(receiptEntry(row, SCOPE_PRECEDENCE[row.scope.kind] < topPrecedence ? "lower_precedence" : "duplicate"));
    }
  }

  const sortedSuppressed = suppressed.sort((a, b) => a.key.localeCompare(b.key) || a.requirement_id.localeCompare(b.requirement_id));
  const overflow = applied.length > maxResults || sortedSuppressed.length > maxResults || conflicts.length > maxResults
    ? { applied_count: applied.length, suppressed_count: sortedSuppressed.length, conflict_count: conflicts.length, max_results: maxResults }
    : null;
  const boundedApplied = applied.slice(0, maxResults);
  const boundedSuppressed = sortedSuppressed.slice(0, maxResults);
  const boundedConflicts = conflicts.slice(0, maxResults);
  const status: RequirementsReceipt["status"] = overflow ? "overflow" : boundedConflicts.length > 0 ? "conflict" : "resolved";
  const hashInput = { status, query, scope_refs: scopes, applied: boundedApplied, suppressed: boundedSuppressed, conflicts: boundedConflicts, overflow };
  return {
    schema: REQUIREMENTS_RECEIPT_SCHEMA,
    generated_at: generatedAt,
    status,
    query,
    scope_refs: scopes,
    applied: boundedApplied,
    suppressed: boundedSuppressed,
    conflicts: boundedConflicts,
    overflow,
    receipt_sha256: stableHash(hashInput)
  };
}

function contextObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function deriveRequirementScopesForChat(req: Pick<ChatRequest, "context">): RequirementScopeRef[] {
  const context = contextObject(req.context);
  const requirements = contextObject(context.requirements);
  const explicit = Array.isArray(requirements.scopes) ? requirements.scopes : [];
  const scopes: RequirementScopeRef[] = [];
  for (const row of explicit) {
    try { scopes.push(normalizeScope(row)); } catch { /* explicit malformed scopes are ignored */ }
  }

  const principal = getRequestPrincipal();
  scopes.push({ kind: "engineer", id: normalizeId(principal?.user_id || "local", "engineer scope") });

  const revit = contextObject(context.revit);
  const document = contextObject(revit.document);
  const readiness = contextObject(revit.readiness);
  const documentPath = String(document.path ?? readiness.active_document_path ?? "").trim();
  const documentTitle = String(document.title ?? readiness.active_document_name ?? "").trim();
  const projectBasis = documentPath || documentTitle;
  if (projectBasis) {
    const normalized = projectBasis.replace(/\\/g, "/").toLowerCase();
    scopes.push({ kind: "project", id: `revit_${stableHash(normalized).slice(0, 16)}` });
  }
  for (const kind of ["office", "client"] as const) {
    const id = String(requirements[`${kind}_id`] ?? "").trim();
    if (id) scopes.push({ kind, id: normalizeId(id, `${kind}_id`) });
  }
  return [...new Map(scopes.map(scope => [scopeKey(scope), scope])).values()].sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
}

export function resolveRequirementsForChat(req: Pick<ChatRequest, "context" | "user_text">): RequirementsReceipt {
  const context = contextObject(req.context);
  const ui = contextObject(context.ui);
  const query = String(req.user_text ?? "").trim() || String(ui.authoritative_user_text ?? "").trim();
  return resolveRequirements({
    scope_refs: deriveRequirementScopesForChat(req),
    query,
    max_results: 40
  });
}

export function formatRequirementsForPrompt(receipt: RequirementsReceipt): string {
  if (receipt.applied.length === 0 && receipt.conflicts.length === 0) return "";
  const lines = [
    "DURABLE REQUIREMENTS (deterministically resolved; cite exact [R#] IDs in plans):",
    `receipt_sha256=${receipt.receipt_sha256} status=${receipt.status}`
  ];
  if (receipt.status === "overflow") lines.push(`[OVERFLOW] ${JSON.stringify(receipt.overflow)} — do not plan; narrow the query or scope.`);
  receipt.applied.forEach((row, index) => lines.push(`[R${index + 1}] id=${row.requirement_id} rev=${row.revision} scope=${scopeKey(row.scope)} key=${row.key} ${row.text}`));
  for (const conflict of receipt.conflicts) {
    lines.push(`[CONFLICT key=${conflict.key}] ${conflict.requirements.map(row => `${row.requirement_id}@${row.revision}`).join(", ")} — do not choose; ask for resolution.`);
  }
  lines.push("Return the receipt hash with any proposed plan; never silently override a conflict.");
  return lines.join("\n");
}

export function formatRequirementsForUser(rows: RequirementRevision[]): string {
  if (rows.length === 0) return "No durable requirements found.";
  return [
    `Durable requirements (${rows.length})`,
    ...rows.map(row => `- ${row.requirement_id}@${row.revision} [${scopeKey(row.scope)}] [${row.key}] ${row.status}: ${row.text}`)
  ].join("\n");
}

export function requirementScopePrecedence(kind: RequirementScopeKind): number {
  return SCOPE_PRECEDENCE[kind];
}

export function requirementsContractVersion(): string {
  return OPERATOR_BACKEND_CONTRACT_VERSION;
}
