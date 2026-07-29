import fs from "node:fs";
import path from "node:path";

/**
 * Standalone SafeRead discovery contract.  The native microhost publishes this
 * file after it has bound a loopback listener.  This package deliberately does
 * not import backend/native types: the discovery record is the only public
 * seam available to the standalone MCP package.
 *
 * The microhost, not MCP, owns the frozen backend preauthorization/capability
 * nonce/final-receipt protocol.  MCP only presents this validated host tuple to
 * the fixed route; see safeReadClient.ts for the integration boundary.
 */
export const SAFE_READ_INSTANCE_SCHEMA = "revit-operator.safe-read-instance.v1";
export const SAFE_READ_ATTESTATION_SCHEMA = "revit-operator.safe-read-attestation.v1";
export const SAFE_READ_SHEETS_COUNT_ROUTE_ID = "revit_count_sheets_certified.v1";
export const SAFE_READ_SHEETS_COUNT_PATH = "/revit/certified/sheets/count";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const OPAQUE_TOKEN = /^[^\u0000-\u001F\u007F]{1,512}$/;

export type SafeReadRuntimeTuple = Readonly<{
  host_content_sha256: string;
  host_mvid: string;
  revit_api_content_sha256: string;
  revit_api_mvid: string;
  revit_version: string;
}>;

export type SafeReadInstance = Readonly<{
  schema: typeof SAFE_READ_INSTANCE_SCHEMA;
  host_instance_id: string;
  executor_id: string;
  pid: number;
  revit_year: number;
  route_id: typeof SAFE_READ_SHEETS_COUNT_ROUTE_ID;
  route: typeof SAFE_READ_SHEETS_COUNT_PATH;
  endpoint: string;
  startup_token: string;
  runtime_attestation_sha256: string;
  runtime_tuple: SafeReadRuntimeTuple;
  document: Readonly<{ project_fingerprint: string; document_session_id: string }>;
  attestation: Readonly<{
    schema: typeof SAFE_READ_ATTESTATION_SCHEMA;
    host_instance_id: string;
    route_id: typeof SAFE_READ_SHEETS_COUNT_ROUTE_ID;
    document_session_id: string;
    runtime_attestation_sha256: string;
  }>;
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

function stringField(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    throw new SafeReadDiscoveryError("safe_read_discovery_invalid", `SafeRead discovery ${field} is invalid.`);
  }
  return value;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafeReadDiscoveryError("safe_read_discovery_invalid", `SafeRead discovery ${field} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function assertLoopbackEndpoint(raw: string): string {
  let endpoint: URL;
  try { endpoint = new URL(raw); } catch {
    throw new SafeReadDiscoveryError("safe_read_discovery_endpoint_invalid", "SafeRead endpoint is not a URL.");
  }
  if (endpoint.protocol !== "http:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new SafeReadDiscoveryError("safe_read_discovery_endpoint_invalid", "SafeRead endpoint must be an origin-only HTTP loopback URL.");
  }
  // Do not resolve names such as localhost: only numeric loopback endpoints
  // prevent hosts-file/DNS rebinding from changing the selected executor.
  if (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "[::1]") {
    throw new SafeReadDiscoveryError("safe_read_discovery_endpoint_invalid", "SafeRead endpoint must use a numeric loopback address.");
  }
  if (!endpoint.port || !/^\d+$/.test(endpoint.port) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535) {
    throw new SafeReadDiscoveryError("safe_read_discovery_endpoint_invalid", "SafeRead endpoint port is invalid.");
  }
  return endpoint.origin;
}

function parseInstance(value: unknown, expectedYear?: number): SafeReadInstance {
  const record = objectField(value, "record");
  if (record.schema !== SAFE_READ_INSTANCE_SCHEMA) {
    throw new SafeReadDiscoveryError("safe_read_discovery_schema_invalid", "SafeRead discovery schema is not supported.");
  }
  const hostInstanceId = stringField(record.host_instance_id, "host_instance_id", GUID);
  const executorId = stringField(record.executor_id, "executor_id", SAFE_ID);
  const pid = record.pid;
  if (!Number.isInteger(pid) || (pid as number) < 1) throw new SafeReadDiscoveryError("safe_read_discovery_pid_invalid", "SafeRead discovery pid is invalid.");
  const revitYear = record.revit_year;
  if (!Number.isInteger(revitYear) || (revitYear as number) < 2000 || (revitYear as number) > 3000 || (expectedYear !== undefined && revitYear !== expectedYear)) {
    throw new SafeReadDiscoveryError("safe_read_discovery_year_invalid", "SafeRead discovery Revit year does not match this MCP host.");
  }
  if (record.route_id !== SAFE_READ_SHEETS_COUNT_ROUTE_ID || record.route !== SAFE_READ_SHEETS_COUNT_PATH) {
    throw new SafeReadDiscoveryError("safe_read_discovery_route_invalid", "SafeRead discovery is not bound to the certified sheet-count route.");
  }
  const runtimeTuple = objectField(record.runtime_tuple, "runtime_tuple");
  const tuple: SafeReadRuntimeTuple = {
    host_content_sha256: stringField(runtimeTuple.host_content_sha256, "runtime_tuple.host_content_sha256", SHA256),
    host_mvid: stringField(runtimeTuple.host_mvid, "runtime_tuple.host_mvid", GUID),
    revit_api_content_sha256: stringField(runtimeTuple.revit_api_content_sha256, "runtime_tuple.revit_api_content_sha256", SHA256),
    revit_api_mvid: stringField(runtimeTuple.revit_api_mvid, "runtime_tuple.revit_api_mvid", GUID),
    revit_version: stringField(runtimeTuple.revit_version, "runtime_tuple.revit_version", SAFE_ID)
  };
  const document = objectField(record.document, "document");
  const documentSessionId = stringField(document.document_session_id, "document.document_session_id", GUID);
  const projectFingerprint = stringField(document.project_fingerprint, "document.project_fingerprint", SHA256);
  const runtimeAttestation = stringField(record.runtime_attestation_sha256, "runtime_attestation_sha256", SHA256);
  const attestation = objectField(record.attestation, "attestation");
  if (attestation.schema !== SAFE_READ_ATTESTATION_SCHEMA
    || attestation.host_instance_id !== hostInstanceId
    || attestation.route_id !== SAFE_READ_SHEETS_COUNT_ROUTE_ID
    || attestation.document_session_id !== documentSessionId
    || attestation.runtime_attestation_sha256 !== runtimeAttestation) {
    throw new SafeReadDiscoveryError("safe_read_discovery_attestation_invalid", "SafeRead discovery attestation does not bind the host, document, and fixed route.");
  }
  return Object.freeze({
    schema: SAFE_READ_INSTANCE_SCHEMA,
    host_instance_id: hostInstanceId,
    executor_id: executorId,
    pid: pid as number,
    revit_year: revitYear as number,
    route_id: SAFE_READ_SHEETS_COUNT_ROUTE_ID,
    route: SAFE_READ_SHEETS_COUNT_PATH,
    endpoint: assertLoopbackEndpoint(stringField(record.endpoint, "endpoint")),
    // This intentionally remains opaque and is never returned in errors/logs.
    startup_token: stringField(record.startup_token, "startup_token", OPAQUE_TOKEN),
    runtime_attestation_sha256: runtimeAttestation,
    runtime_tuple: tuple,
    document: Object.freeze({ project_fingerprint: projectFingerprint, document_session_id: documentSessionId }),
    attestation: Object.freeze({
      schema: SAFE_READ_ATTESTATION_SCHEMA,
      host_instance_id: hostInstanceId,
      route_id: SAFE_READ_SHEETS_COUNT_ROUTE_ID,
      document_session_id: documentSessionId,
      runtime_attestation_sha256: runtimeAttestation
    })
  });
}

function defaultInstancesDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new SafeReadDiscoveryError("safe_read_discovery_unavailable", "LOCALAPPDATA is unavailable for SafeRead discovery.");
  return path.join(localAppData, "RevitOperator", "SafeRead", "instances");
}

function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
    let stat: fs.Stats;
    try { stat = fs.lstatSync(filePath); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { continue; }
    try {
      const instance = parseInstance(parsed, options.revitYear);
      if ((options.isPidAlive ?? defaultPidAlive)(instance.pid)) candidates.push(instance);
    } catch {
      // A malformed/stale publication is never partially trusted. Other files
      // are allowed only when exactly one complete, live record remains.
    }
  }
  if (candidates.length === 0) throw new SafeReadDiscoveryError("safe_read_discovery_unavailable", "No live, valid SafeRead instance was discovered.");
  if (candidates.length !== 1) throw new SafeReadDiscoveryError("safe_read_discovery_ambiguous", "SafeRead discovery found multiple live valid hosts.");
  return candidates[0]!;
}
