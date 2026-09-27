import type { EvidenceRefV1 } from "./evidence_ref.js";
import { extractMcpStructuredPayload } from "./structured_payload.js";

type Row = Record<string, any>;
type Edge = [owner: number, connector: number, peer_owner: number, peer_connector: number, domain_index: number];
type Reference = [owner: number, connector: number | null, peer_owner: number | null, peer_connector: number | null, reason: string];
type Endpoint = [owner: number, connector: number, source_row: number, domain: string, origin: number[] | null, size: Row | null, service: string | null];
type Lists = {
  owner_rows: [owner: number, source_row: number][];
  reciprocal_edges: Edge[];
  owner_components: number[][];
  open_hvac_endpoints: Endpoint[];
  open_electrical_endpoints: Endpoint[];
  open_other_endpoints: Endpoint[];
  boundary_references: Edge[];
  one_sided_references: Edge[];
  excluded_references: Reference[];
  unresolved_references: Reference[];
  row_issues: [source_row: number, owner: number | null, reason: string][];
};
export type ConnectorGraphProjection = {
  schema: "revit-operator.connector-graph-projection.v1";
  source_path: string;
  coverage: {
    requested: number; scanned: number; failed: number; truncated_elements: number;
    returned_rows: number; unique_owners: number; missing_owner_rows: number; duplicate_owner_rows: number;
    filter: string; rows_complete: boolean; missing_requested_ids: "not_reported_by_native";
    native_reference_scan_complete: null; whole_model_complete: null;
  };
  interpretation: string;
  domains: string[];
  columns: { edges: string[]; endpoints: string[]; references: string[]; row_issues: string[] };
  totals: Record<keyof Lists, number> & { logical_connectors: number; omitted_component_members: number };
  omitted: Record<keyof Lists, number>;
  lists_complete: boolean;
  lists: Lists;
};

const record = (v: unknown): Row | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : null;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const ownerId = (v: unknown): v is number => count(v) && v > 0;
const nativeId = (c: Row): boolean => count(c.connectorId) && c.connectorIdBasis === "revit_native_connector_id";
const DOMAINS = ["DomainHvac", "DomainPiping", "DomainElectrical", "DomainCableTrayConduit"];
const physicalDomain = (c: Row): boolean => DOMAINS.includes(c.domain);
const nonlogical = (c: Row): boolean => typeof c.connectorType === "string" && c.connectorType.length > 0 && c.connectorType !== "Logical";
const compare = (a: number[], b: number[]): number => a[0]! - b[0]! || a[1]! - b[1]! || (a[2] ?? 0) - (b[2] ?? 0) || (a[3] ?? 0) - (b[3] ?? 0);

/** Presentation of observed native pairs only. Never supplies verification authority. */
export function projectConnectorGraph(ref: EvidenceRefV1, raw: unknown, maxBytes: number): ConnectorGraphProjection | null {
  if (ref.trust_level !== "authoritative_native" && ref.trust_level !== "authoritative_readback") return null;
  const root = record(raw);
  if (!root || root.isError === true) return null;
  const envelope = Array.isArray(root.content) || Object.hasOwn(root, "structuredContent");
  const extracted = envelope ? extractMcpStructuredPayload(root) : null;
  const payload = record(envelope ? extracted?.payload : root);
  // Deliberately recognize the native producer, not arbitrary nested arrays or
  // model-authored summaries. Malformed row contents are reported below.
  const counters = ["requestedCount", "scannedElementCount", "failedElementCount", "matchedElementCount", "totalScannedConnectorCount", "physicallyConnectedConnectorCount", "openPhysicalConnectorCount", "connectorScanTruncatedElementCount"];
  if (!payload || payload.status !== "Ok" || !counters.every(key => count(payload[key])) || payload.requestedCount < 1 || payload.requestedCount > 5000
    || !["allConnectors", "openPhysicalConnectors"].includes(payload.filter)
    || !Array.isArray(payload.results) || payload.results.length > 5000) return null;

  const lists: Lists = { owner_rows: [], reciprocal_edges: [], owner_components: [], open_hvac_endpoints: [], open_electrical_endpoints: [], open_other_endpoints: [], boundary_references: [], one_sided_references: [], excluded_references: [], unresolved_references: [], row_issues: [] };
  const owners = new Map<number, { row: Row; index: number }>();
  const duplicates = new Set<number>();
  let duplicateRows = 0;
  for (const [index, value] of payload.results.entries()) {
    const row = record(value);
    if (!row || !ownerId(row.id)) { lists.row_issues.push([index, null, "invalid_owner_row"]); continue; }
    lists.owner_rows.push([row.id, index]);
    if (owners.has(row.id)) { duplicates.add(row.id); duplicateRows++; lists.row_issues.push([index, row.id, "duplicate_owner"]); }
    else owners.set(row.id, { row, index });
  }
  const connectors = new Map<string, { c: Row; owner: number; index: number }>();
  const ambiguous = new Set<string>();
  let logical = 0, scannedConnectors = 0, failedRows = 0, truncatedRows = 0;
  for (const [id, { row, index }] of owners) {
    if (row.ok !== true) { failedRows++; lists.row_issues.push([index, id, "owner_read_failed"]); continue; }
    if (!Array.isArray(row.connectors) || row.connectors.length > 512) { lists.row_issues.push([index, id, "invalid_connector_rows"]); continue; }
    scannedConnectors += row.connectors.length;
    if (row.connectorScanTruncated === true) truncatedRows++;
    if (row.connectorScanTruncated !== false) lists.row_issues.push([index, id, "connector_scan_truncated_or_unknown"]);
    if (row.connectorCount !== row.connectors.length || row.returnedConnectorCount !== row.connectors.length) lists.row_issues.push([index, id, "connector_count_mismatch_or_filtered"]);
    for (const value of row.connectors) {
      const c = record(value);
      if (!c || !Array.isArray(c.connectedTo) || !Array.isArray(c.physicalConnectedTo) || c.connectedTo.some((r: unknown) => !record(r)) || c.physicalConnectedTo.some((r: unknown) => !record(r))) {
        lists.row_issues.push([index, id, "invalid_connector_or_reference_rows"]); continue;
      }
      if (c.connectorType === "Logical") logical++;
      if (!nativeId(c)) { lists.unresolved_references.push([id, null, null, null, "native_connector_id_unavailable"]); continue; }
      const key = `${id}/${c.connectorId}`;
      if (connectors.has(key)) { ambiguous.add(key); lists.row_issues.push([index, id, "duplicate_native_connector_id"]); }
      else connectors.set(key, { c, owner: id, index });
    }
  }
  const rowsComplete = lists.row_issues.length === 0 && payload.filter === "allConnectors"
    && payload.results.length === payload.requestedCount && owners.size === payload.requestedCount
    && payload.scannedElementCount === payload.requestedCount && payload.failedElementCount === 0
    && payload.matchedElementCount === owners.size && payload.connectorScanTruncatedElementCount === 0
    && payload.totalScannedConnectorCount === scannedConnectors;
  if (payload.failedElementCount !== failedRows || payload.connectorScanTruncatedElementCount !== truncatedRows
    || (payload.filter === "allConnectors" && payload.totalScannedConnectorCount !== scannedConnectors)) lists.row_issues.push([-1, null, "aggregate_count_mismatch"]);
  const directed = new Map<string, Edge>();
  for (const [key, { c, owner, index }] of connectors) {
    if (duplicates.has(owner) || ambiguous.has(key)) continue;
    const note = (r: Row, reason: string): Reference => [owner, c.connectorId, ownerId(r.ownerId) ? r.ownerId : null, nativeId(r) ? r.connectorId : null, reason];
    for (const r of c.connectedTo as Row[]) {
      if (c.connectorType === "Logical" || r.connectorType === "Logical" || r.isMepSystem === true || r.isConnectedTo === false) {
        lists.excluded_references.push(note(r, r.isMepSystem === true ? "mep_system" : c.connectorType === "Logical" || r.connectorType === "Logical" ? "logical" : "nonphysical"));
      } else if (r.isConnectedTo !== true) {
        // Native derives isPhysicalElement=false when IsConnectedTo throws.
        // That flag alone cannot turn an unknown check into a known exclusion.
        lists.unresolved_references.push(note(r, "native_connection_check_unknown"));
      } else if (!c.physicalConnectedTo.some((p: Row) => p.ownerId === r.ownerId && p.connectorId === r.connectorId)) {
        lists.unresolved_references.push(note(r, "reference_not_in_physical_rows"));
      }
    }
    if (!nonlogical(c) || !physicalDomain(c)) continue;
    if (c.physicalConnectionCount !== c.physicalConnectedTo.length || c.isPhysicallyConnected !== (c.physicalConnectedTo.length > 0)) lists.row_issues.push([index, owner, "physical_reference_count_mismatch"]);
    const referenceKeys = new Set<string>();
    for (const r of c.physicalConnectedTo as Row[]) {
      if (!nonlogical(r) || !physicalDomain(r) || r.isMepSystem !== false || r.isPhysicalElement !== true || r.isConnectedTo !== true || !nativeId(r) || !ownerId(r.ownerId) || r.ownerId === owner || r.domain !== c.domain) {
        lists.unresolved_references.push(note(r, "unproven_physical_reference")); continue;
      }
      const referenceKey = `${r.ownerId}/${r.connectorId}`;
      if (referenceKeys.has(referenceKey)) { lists.row_issues.push([index, owner, "duplicate_physical_reference"]); continue; }
      referenceKeys.add(referenceKey);
      if (!c.connectedTo.some((all: Row) => all.ownerId === r.ownerId && all.connectorId === r.connectorId && nativeId(all)
        && all.domain === r.domain && all.connectorType === r.connectorType && all.isMepSystem === false && all.isPhysicalElement === true && all.isConnectedTo === true)) {
        lists.unresolved_references.push(note(r, "physical_reference_absent_from_allrefs")); continue;
      }
      const edge: Edge = [owner, c.connectorId, r.ownerId, r.connectorId, DOMAINS.indexOf(c.domain)];
      if (!owners.has(r.ownerId)) {
        if (rowsComplete) lists.boundary_references.push(edge);
        else lists.unresolved_references.push(note(r, "peer_outside_returned_rows_requested_scope_unknown"));
        continue;
      }
      const peerKey = `${r.ownerId}/${r.connectorId}`, peer = connectors.get(peerKey)?.c;
      if (duplicates.has(r.ownerId) || ambiguous.has(peerKey) || !peer || !nonlogical(peer) || peer.domain !== c.domain) {
        lists.unresolved_references.push(note(r, "peer_connector_missing_ambiguous_or_mismatched")); continue;
      }
      directed.set(`${key}>${peerKey}`, edge);
    }
    if (c.isConnected === false && c.physicalConnectedTo.length === 0 && c.physicalConnectionCount === 0 && c.isPhysicallyConnected === false) {
      const origin = Array.isArray(c.origin) && c.origin.length === 3 && c.origin.every(Number.isFinite) ? c.origin : null;
      const size = record(c.size);
      const safeSize = size ? Object.fromEntries(Object.entries(size).filter(([k, v]) => ["kind", "radiusFt", "diameterFt", "widthFt", "heightFt"].includes(k) && (typeof v === "string" || typeof v === "number" && Number.isFinite(v)))) : null;
      const endpoint: Endpoint = [owner, c.connectorId, index, c.domain, origin, safeSize, typeof c.systemClassification === "string" ? c.systemClassification : null];
      (c.domain === "DomainHvac" ? lists.open_hvac_endpoints : c.domain === "DomainElectrical" ? lists.open_electrical_endpoints : lists.open_other_endpoints).push(endpoint);
    } else if (c.physicalConnectedTo.length === 0 && c.isConnected !== false) lists.unresolved_references.push([owner, c.connectorId, null, null, "connection_state_without_physical_peer"]);
  }
  const neighbors = new Map<number, Set<number>>([...owners.keys()].filter(id => !duplicates.has(id) && owners.get(id)!.row.ok === true).map(id => [id, new Set<number>()]));
  for (const edge of directed.values()) {
    const [a, ac, b, bc] = edge;
    if (!directed.has(`${b}/${bc}>${a}/${ac}`)) { lists.one_sided_references.push(edge); continue; }
    if (a < b) lists.reciprocal_edges.push(edge);
    neighbors.get(a)?.add(b); neighbors.get(b)?.add(a);
  }
  const seen = new Set<number>();
  for (const id of [...neighbors.keys()].sort((a, b) => a - b)) {
    if (seen.has(id)) continue;
    const component: number[] = [], queue = [id]; seen.add(id);
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i]!; component.push(next);
      for (const peer of neighbors.get(next) ?? []) if (!seen.has(peer)) { seen.add(peer); queue.push(peer); }
    }
    lists.owner_components.push(component.sort((a, b) => a - b));
  }
  for (const name of ["reciprocal_edges", "one_sided_references", "boundary_references"] as const) lists[name].sort((a, b) => compare(a.slice(0, 4) as number[], b.slice(0, 4) as number[]));
  const keys = Object.keys(lists) as (keyof Lists)[];
  const summary: ConnectorGraphProjection = {
    schema: "revit-operator.connector-graph-projection.v1", source_path: extracted ? "payload.results" : "results",
    coverage: { requested: payload.requestedCount, scanned: payload.scannedElementCount, failed: payload.failedElementCount, truncated_elements: payload.connectorScanTruncatedElementCount,
      returned_rows: payload.results.length, unique_owners: owners.size, missing_owner_rows: Math.max(0, payload.requestedCount - owners.size), duplicate_owner_rows: duplicateRows,
      filter: payload.filter, rows_complete: rowsComplete && lists.row_issues.length === 0, missing_requested_ids: "not_reported_by_native", native_reference_scan_complete: null, whole_model_complete: null },
    interpretation: "Observed reciprocal physical native pairs only. Boundary reciprocity=not_scanned. Requested owner membership is inferred from complete allConnectors rows; missing IDs are unknown. Native reference/manager failures are not reported; reference completeness remains unknown. Owner connectivity, including equipment ports, does not prove airflow/service continuity. Open endpoints are not necessarily defects. No geometry, source fidelity or completion proof. Raw rows remain retrievable.",
    domains: [...DOMAINS],
    columns: { edges: ["owner", "native_connector", "peer_owner", "peer_native_connector", "domain_index"], endpoints: ["owner", "native_connector", "source_row", "domain", "origin", "size", "service"], references: ["owner", "native_connector", "peer_owner", "peer_native_connector", "reason"], row_issues: ["source_row", "owner", "reason"] },
    totals: { ...Object.fromEntries(keys.map(key => [key, lists[key].length])) as Record<keyof Lists, number>, logical_connectors: logical, omitted_component_members: 0 },
    omitted: Object.fromEntries(keys.map(key => [key, 0])) as Record<keyof Lists, number>, lists_complete: true, lists
  };
  // Remove whole entries, never silently partial component memberships. Counts
  // describe the full observed graph, independently of the presentation budget.
  let bytes = Buffer.byteLength(JSON.stringify(summary), "utf8");
  while (bytes > maxBytes) {
    // Preserve physical pairs, complete components and open ends ahead of
    // nonphysical reference details and the redundant owner-to-row index.
    const largest = (["excluded_references", "owner_rows"] as const).find(key => lists[key].length > 0)
      ?? keys.filter(key => lists[key].length > 0).sort((a, b) => JSON.stringify(lists[b]).length - JSON.stringify(lists[a]).length)[0];
    if (!largest) break; // Caller reports whole-summary omission if the skeleton cannot fit.
    const length = lists[largest].length, listBytes = Buffer.byteLength(JSON.stringify(lists[largest]), "utf8");
    const n = Math.min(length, Math.max(1, Math.ceil((bytes - maxBytes + 32) / (listBytes / length))));
    const removed = lists[largest].splice(length - n, n);
    summary.omitted[largest] += n; summary.lists_complete = false;
    if (largest === "owner_components") summary.totals.omitted_component_members += removed.reduce((sum, members) => sum + members.length, 0);
    bytes = Buffer.byteLength(JSON.stringify(summary), "utf8");
  }
  return summary;
}
