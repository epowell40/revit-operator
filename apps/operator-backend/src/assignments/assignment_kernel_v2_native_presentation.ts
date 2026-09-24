import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import { sameAssignmentBindingV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 1000) : "";
type NativePayload = { path: string; payload: Record<string, unknown>; observedAt: number; operation: AssignmentSnapshotV2["operations"][string] };

function nativePath(item: NativePayload): string {
  const schema = item.operation.result?.result_schema_id ?? "";
  if (schema.startsWith("operator-native/POST:")) return schema.slice("operator-native/POST:".length).replace(/\/v2$/, "");
  return item.path;
}

function routeSummary(items: NativePayload[]): string | null {
  const route = items.filter(item => nativePath(item) === "/revit/mep-route-workflow"
    && item.operation.result?.persistent_effect === "applied"
    && item.operation.result.native_transaction_state === "committed"
    && record(item.payload.transaction).committed === true
    && record(item.payload.transaction).status === "committed"
    && record(item.payload.applyResult).kind === "duct"
    && record(item.payload.applyResult).rolledBack === false
    && /^Created/.test(text(record(item.payload.applyResult).status)))
    .sort((a, b) => b.observedAt - a.observedAt)[0];
  if (!route) return null;
  const apply = record(route.payload.applyResult);
  const ids = apply.createdElementIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500
      || !ids.every(id => Number.isSafeInteger(id) && id > 0)
      || new Set(ids).size !== ids.length) return null;
  const readback = items.filter(item => nativePath(item) === "/revit/get-connectors"
    && item.observedAt > route.observedAt && item.payload.status === "Ok"
    && item.operation.result?.persistent_effect === "none")
    .sort((a, b) => b.observedAt - a.observedAt)
    .find(item => {
      const results = item.payload.results;
      return Array.isArray(results) && ids.every(id => results.some((entry: unknown) => {
        const row = record(entry);
        return row.id === id && row.ok === true && row.category === "OST_DuctCurves";
      }));
    });
  if (!readback) return null;
  const rows = ids.map(id => record((readback.payload.results as unknown[]).find(entry => record(entry).id === id)));
  const count = ids.length;
  let summary = `Created ${count} duct segment${count === 1 ? "" : "s"}`;

  const details = record(readback.payload.verificationParameters);
  const parameterRows = Array.isArray(details.items) ? details.items : [];
  const selected = record(apply.selected);
  const level = record(selected.level);
  const size = record(apply.chosenSize);
  const parameter = (id: unknown, name: string) => {
    const item = parameterRows.find(entry => record(entry).id === id);
    const values = record(item).parameterDetails;
    return Array.isArray(values) ? record(values.find(entry => record(entry).name === name)) : {};
  };
  const diameter = rows.map(row => parameter(row.id, "Diameter"));
  const sizeLabels = diameter.map(value => text(value.valueString).trim());
  if (sizeLabels.length === count && sizeLabels.every(value => value === sizeLabels[0])) {
    const match = sizeLabels[0]?.match(/^(\d+(?:\.\d+)?)\s*(?:"|in(?:ches)?)$/i);
    const nativeFeet = Number(diameter[0]?.value);
    if (match && Number.isFinite(nativeFeet) && Number.isFinite(size.diameterFt)
        && Math.abs(nativeFeet - Number(size.diameterFt)) < 1e-5
        && Math.abs(Number(match[1]) / 12 - nativeFeet) < 1e-5) summary += ` (${match[1]} in)`;
  }
  const levels = rows.map(row => parameter(row.id, "Reference Level"));
  const levelName = text(level.name).trim();
  if (Number.isSafeInteger(level.id) && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(levelName)
      && levels.every(value => Number(value.value) === level.id && text(value.valueString).trim() === levelName)) {
    summary += ` on ${levelName}`;
  }
  summary += ".";

  const completeConnectors = readback.payload.failedElementCount === 0
    && readback.payload.connectorScanTruncatedElementCount === 0
    && rows.every(row => row.connectorScanTruncated === false
      && Array.isArray(row.connectors) && row.connectorCount === row.connectors.length
      && row.returnedConnectorCount === row.connectors.length
      && row.connectors.every((entry: unknown) => {
        const connector = record(entry);
        return connector.connectorType === "End" && Number.isSafeInteger(connector.physicalConnectionCount)
          && typeof connector.isPhysicallyConnected === "boolean"
          && Array.isArray(connector.physicalConnectedTo);
      }));
  if (completeConnectors) {
    const open = rows.reduce((total, row) => total + (row.connectors as unknown[]).filter(entry => {
      const connector = record(entry);
      return connector.physicalConnectionCount === 0 && connector.isPhysicallyConnected === false
        && (connector.physicalConnectedTo as unknown[]).length === 0;
    }).length, 0);
    if (rows.reduce((total, row) => total + Number(row.openPhysicalConnectorCount), 0) === open)
      summary += ` Verified ${open} open physical end connector${open === 1 ? "" : "s"}.`;
  }
  return summary;
}

/** Present selected native fields without allowing model prose to certify work. */
export function nativeResultPresentationV2(snapshot: AssignmentSnapshotV2, observationIds: readonly string[]): string | null {
  const lines = new Set<string>();
  const nativePayloads: NativePayload[] = [];
  for (const id of observationIds) {
    const observation = snapshot.observations[id];
    const operation = observation && snapshot.operations[observation.operation_id];
    if (!observation || !sameAssignmentBindingV2(snapshot.current_binding, observation.binding)
        || observation.authority !== "native-host" || operation?.result?.status !== "succeeded"
        || operation.settlement_state !== "settled" || !["task_result", "verification"].includes(observation.evidence_class ?? "")) continue;
    let payload: Record<string, unknown>;
    try {
      const ref = readEvidenceRef(observation.raw_payload_ref.replace(/^evidence:/, ""));
      const bytes = readAuthoritativeEvidence(ref, { ...snapshot.current_binding, attempt_id: operation.operation_id });
      payload = record(JSON.parse(bytes.toString("utf8")));
      if (payloadDigestV2(payload).digest !== observation.raw_payload_hash) continue;
    } catch { continue; }
    if (Number.isFinite(Date.parse(observation.observed_at))) nativePayloads.push({
      path: operation.capability_id.startsWith("native:POST:") ? operation.capability_id.slice("native:POST:".length) : "",
      payload, observedAt: Date.parse(observation.observed_at), operation
    });
    const artifact = record(payload.artifact_receipt);
    if (artifact.path === "/revit/export-elements-xlsx" && artifact.phase === "apply" && artifact.status === "complete"
        && typeof payload.selectedCount === "number" && typeof payload.issueCount === "number") {
      lines.add(`Workbook: ${payload.selectedCount} elements; ${payload.issueCount} fields flagged for review.`);
    }
    if (artifact.path === "/revit/export-pdf" && artifact.phase === "apply" && artifact.status === "complete"
        && Array.isArray(payload.selectedSheets)) for (const item of payload.selectedSheets.slice(0, 12)) {
      const row = record(item);
      if (typeof row.sheetNumber === "string" && typeof row.name === "string")
        lines.add(`Exported sheet ${text(row.sheetNumber)}: ${text(row.name)}.`);
    }
    if (Array.isArray(payload.items)) for (const item of payload.items.slice(0, 12)) {
      const row = record(item); const params = record(row.parameters);
      if (typeof params["Sheet Number"] === "string" && typeof params["Sheet Name"] === "string")
        lines.add(`Sheet ${text(params["Sheet Number"])}: ${text(params["Sheet Name"])}.`);
    }
    if (payload.schema === "revit-operator.exported-file-inspection.v1" && payload.ok === true && payload.itemsComplete === true && Array.isArray(payload.files)) {
      for (const file of payload.files.slice(0, 12)) {
        const row = record(file);
        if (row.exists === true && row.readable === true && typeof row.path === "string") lines.add(`Verified file: ${text(row.path)}`);
      }
    }
    const capture = record(payload.export);
    if (typeof capture.path === "string" && typeof capture.viewName === "string") {
      lines.add(`Drawing ${text(payload.sheetNumber)}: ${text(capture.viewName)}.`);
      lines.add(`Drawing image: ${text(capture.path)}`);
    }
  }
  const mepRoute = routeSummary(nativePayloads);
  if (mepRoute) lines.add(mepRoute);
  return lines.size ? [...lines].slice(0, 24).join("\n") : null;
}
