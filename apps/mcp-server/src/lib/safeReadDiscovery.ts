import fs from "node:fs";
import path from "node:path";

export const SAFE_READ_INSTANCE_SCHEMA = "revit-operator.safe-read.instance.v1";
export const SAFE_READ_PRODUCT_ID = "aafaa2c0-43f1-42a0-a6b4-d9a0c5f5ce0e";
export const SAFE_READ_EXECUTOR_ID = "revit-operator.safe-read-host.v1";
export const SAFE_READ_SHEETS_COUNT_ROUTE_ID = "safe_read.sheet_count.v1";
export const SAFE_READ_SHEETS_COUNT_PATH = "/revit/certified/sheets/count";
export const SAFE_READ_RESERVED_PATH_PREFIX = "/revit/certified";
export const SAFE_READ_MIN_PORT = 5040;
export const SAFE_READ_MAX_PORT = 5050;
const SAFE_READ_PATH_DECODE_LIMIT = 8;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BASE64URL_SECRET = /^[A-Za-z0-9_-]{43}$/;
const REVIT_YEARS = new Set([2023, 2024, 2025]);
const TOP_LEVEL_KEYS = [
  "schema", "product_id", "host_instance_id", "executor_id", "pid", "revit_year",
  "route_id", "route", "endpoint", "startup_token", "runtime_attestation_sha256",
  "runtime_tuple", "document"
] as const;
const RUNTIME_KEYS = ["host_content_sha256", "host_mvid", "revit_api_content_sha256", "revit_api_mvid", "revit_version"] as const;
const DOCUMENT_KEYS = ["project_fingerprint", "document_session_id"] as const;

export type SafeReadRuntimeTuple = Readonly<{
  host_content_sha256: string;
  host_mvid: string;
  revit_api_content_sha256: string;
  revit_api_mvid: string;
  revit_version: string;
}>;

export type SafeReadDocumentBinding = Readonly<{
  project_fingerprint: string;
  document_session_id: string;
}>;

export type SafeReadInstance = Readonly<{
  schema: typeof SAFE_READ_INSTANCE_SCHEMA;
  product_id: typeof SAFE_READ_PRODUCT_ID;
  host_instance_id: string;
  executor_id: typeof SAFE_READ_EXECUTOR_ID;
  pid: number;
  revit_year: number;
  route_id: typeof SAFE_READ_SHEETS_COUNT_ROUTE_ID;
  route: typeof SAFE_READ_SHEETS_COUNT_PATH;
  endpoint: string;
  startup_token: string;
  runtime_attestation_sha256: string;
  runtime_tuple: SafeReadRuntimeTuple;
  document: SafeReadDocumentBinding;
}>;

export class SafeReadDiscoveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SafeReadDiscoveryError";
  }
}

export type SafeReadDiscoveryOptions = Readonly<{
  instancesDirectory?: string;
  revitYear?: number;
  isPidAlive?: (pid: number) => boolean;
}>;

function objectField(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafeReadDiscoveryError("safe_read_discovery_invalid", `SafeRead discovery ${field} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new SafeReadDiscoveryError("safe_read_discovery_invalid", `SafeRead discovery ${field} fields are not exact.`);
  }
}

function stringField(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new SafeReadDiscoveryError("safe_read_discovery_invalid", `SafeRead discovery ${field} is invalid.`);
  }
  return value;
}

function exactEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new SafeReadDiscoveryError("safe_read_discovery_endpoint_invalid", "SafeRead endpoint is invalid.");
  const match = /^http:\/\/127\.0\.0\.1:(\d{4})\/$/.exec(value);
  const port = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(port) || port < SAFE_READ_MIN_PORT || port > SAFE_READ_MAX_PORT) {
    throw new SafeReadDiscoveryError("safe_read_discovery_endpoint_invalid", "SafeRead endpoint must be an exact bounded IPv4 loopback origin.");
  }
  return value;
}

/**
 * The certified namespace is exclusively reachable through the dedicated
 * SafeRead client. Generic bridge and courier transports must fail closed.
 */
export function isSafeReadReservedPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let candidate = value.trim();
  let converged = false;
  for (let pass = 0; pass < SAFE_READ_PATH_DECODE_LIMIT; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      throw new SafeReadDiscoveryError("safe_read_reserved_path_invalid", "Revit path contains malformed percent encoding.");
    }
    if (decoded === candidate) {
      converged = true;
      break;
    }
    candidate = decoded;
  }
  if (!converged) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      throw new SafeReadDiscoveryError("safe_read_reserved_path_invalid", "Revit path contains malformed percent encoding.");
    }
    if (decoded !== candidate) {
      throw new SafeReadDiscoveryError("safe_read_reserved_path_invalid", "Revit path percent decoding did not converge within the safety bound.");
    }
  }

  const transportPath = candidate.replace(/\\/g, "/").replace(/\/+/g, "/");
  let canonicalPath: string;
  try {
    canonicalPath = new URL(transportPath, "http://127.0.0.1/").pathname;
  } catch {
    throw new SafeReadDiscoveryError("safe_read_reserved_path_invalid", "Revit path cannot be canonicalized safely.");
  }
  canonicalPath = canonicalPath.toLowerCase();
  return canonicalPath === SAFE_READ_RESERVED_PATH_PREFIX
    || canonicalPath.startsWith(`${SAFE_READ_RESERVED_PATH_PREFIX}/`);
}

function parseInstance(value: unknown, filename: string, expectedYear?: number): SafeReadInstance {
  const record = objectField(value, "record");
  exactKeys(record, TOP_LEVEL_KEYS, "record");
  if (record.schema !== SAFE_READ_INSTANCE_SCHEMA || record.product_id !== SAFE_READ_PRODUCT_ID) {
    throw new SafeReadDiscoveryError("safe_read_discovery_schema_invalid", "SafeRead discovery identity is not supported.");
  }
  const hostInstanceId = stringField(record.host_instance_id, "host_instance_id", GUID);
  if (filename !== `${hostInstanceId}.json`) {
    throw new SafeReadDiscoveryError("safe_read_discovery_invalid", "SafeRead discovery filename does not match its host instance.");
  }
  if (record.executor_id !== SAFE_READ_EXECUTOR_ID) {
    throw new SafeReadDiscoveryError("safe_read_discovery_invalid", "SafeRead discovery executor is not supported.");
  }
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || (record.pid as number) > 0x7fffffff) {
    throw new SafeReadDiscoveryError("safe_read_discovery_pid_invalid", "SafeRead discovery pid is invalid.");
  }
  if (!Number.isInteger(record.revit_year) || !REVIT_YEARS.has(record.revit_year as number)
    || (expectedYear !== undefined && record.revit_year !== expectedYear)) {
    throw new SafeReadDiscoveryError("safe_read_discovery_year_invalid", "SafeRead discovery Revit year does not match this MCP request.");
  }
  if (record.route_id !== SAFE_READ_SHEETS_COUNT_ROUTE_ID || record.route !== SAFE_READ_SHEETS_COUNT_PATH) {
    throw new SafeReadDiscoveryError("safe_read_discovery_route_invalid", "SafeRead discovery is not bound to the certified sheet-count route.");
  }
  const runtime = objectField(record.runtime_tuple, "runtime_tuple");
  exactKeys(runtime, RUNTIME_KEYS, "runtime_tuple");
  const revitYear = record.revit_year as number;
  const revitVersion = stringField(runtime.revit_version, "runtime_tuple.revit_version", /^\d{4}(?:\.[0-9A-Za-z._-]+)?$/);
  if (revitVersion !== String(revitYear) && !revitVersion.startsWith(`${revitYear}.`)) {
    throw new SafeReadDiscoveryError("safe_read_discovery_year_invalid", "SafeRead runtime tuple Revit version does not match its year.");
  }
  const runtimeTuple: SafeReadRuntimeTuple = Object.freeze({
    host_content_sha256: stringField(runtime.host_content_sha256, "runtime_tuple.host_content_sha256", SHA256),
    host_mvid: stringField(runtime.host_mvid, "runtime_tuple.host_mvid", GUID),
    revit_api_content_sha256: stringField(runtime.revit_api_content_sha256, "runtime_tuple.revit_api_content_sha256", SHA256),
    revit_api_mvid: stringField(runtime.revit_api_mvid, "runtime_tuple.revit_api_mvid", GUID),
    revit_version: revitVersion
  });
  const rawDocument = objectField(record.document, "document");
  exactKeys(rawDocument, DOCUMENT_KEYS, "document");
  const document: SafeReadDocumentBinding = Object.freeze({
    project_fingerprint: stringField(rawDocument.project_fingerprint, "document.project_fingerprint", SHA256),
    document_session_id: stringField(rawDocument.document_session_id, "document.document_session_id", GUID)
  });
  return Object.freeze({
    schema: SAFE_READ_INSTANCE_SCHEMA,
    product_id: SAFE_READ_PRODUCT_ID,
    host_instance_id: hostInstanceId,
    executor_id: SAFE_READ_EXECUTOR_ID,
    pid: record.pid as number,
    revit_year: revitYear,
    route_id: SAFE_READ_SHEETS_COUNT_ROUTE_ID,
    route: SAFE_READ_SHEETS_COUNT_PATH,
    endpoint: exactEndpoint(record.endpoint),
    startup_token: stringField(record.startup_token, "startup_token", BASE64URL_SECRET),
    runtime_attestation_sha256: stringField(record.runtime_attestation_sha256, "runtime_attestation_sha256", SHA256),
    runtime_tuple: runtimeTuple,
    document
  });
}

function defaultInstancesDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new SafeReadDiscoveryError("safe_read_discovery_unavailable", "LOCALAPPDATA is unavailable for SafeRead discovery.");
  return path.join(localAppData, "RevitOperator", "SafeRead", "instances");
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function discoverSafeReadInstance(options: SafeReadDiscoveryOptions = {}): SafeReadInstance {
  const directory = options.instancesDirectory ?? defaultInstancesDirectory();
  let names: string[];
  try { names = fs.readdirSync(directory); } catch {
    throw new SafeReadDiscoveryError("safe_read_discovery_unavailable", "No SafeRead instance discovery directory is available.");
  }
  const candidates: SafeReadInstance[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(directory, name);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 64 * 1024) continue;
      const instance = parseInstance(JSON.parse(fs.readFileSync(filePath, "utf8")), name, options.revitYear);
      if ((options.isPidAlive ?? defaultPidAlive)(instance.pid)) candidates.push(instance);
    } catch {
      // A stale or malformed publication is never a candidate.
    }
  }
  if (candidates.length === 0) throw new SafeReadDiscoveryError("safe_read_discovery_unavailable", "No live, valid SafeRead instance was discovered.");
  if (candidates.length !== 1) throw new SafeReadDiscoveryError("safe_read_discovery_ambiguous", "SafeRead discovery found multiple live valid hosts.");
  return candidates[0]!;
}
