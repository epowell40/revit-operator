type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

export function directKernelPublicationsV2(toolResultsValue: unknown): JsonRecord[] {
  const toolResults = record(toolResultsValue);
  const bundle = record(toolResults.durable_assignment_kernel_v2);
  if (bundle.schema !== "revit-operator.benchmark-assignment-kernel-v2/v1") return [];
  return records(bundle.assignments).filter((publication) =>
    record(publication.snapshot).schema === "revit-operator.assignment-snapshot/v2"
      && record(publication.provider_ledger).schema === "revit-operator.assignment-provider-ledger/v2");
}

/** Historical V1 report compatibility only; new V2 publications use the direct bundle. */
function legacyKernelPublicationsV2(toolResults: JsonRecord): JsonRecord[] {
  const projection = record(toolResults.durable_assignment_projection);
  return records(projection.assignments).flatMap((assignment) => {
    const snapshot = record(assignment.assignment_snapshot_v2);
    if (snapshot.schema !== "revit-operator.assignment-snapshot/v2") return [];
    const binding = record(snapshot.current_binding);
    return [{
      schema: "revit-operator.assignment-kernel-publication/v2",
      assignment_id: binding.assignment_id,
      assignment_version: snapshot.assignment_version,
      snapshot,
      provider_ledger: {
        schema: "revit-operator.assignment-provider-ledger/v2",
        assignment_id: binding.assignment_id,
        run_id: binding.run_id,
        generation: binding.generation,
        call_ids: snapshot.provider_call_ids,
        calls: snapshot.provider_calls,
        in_flight_call_ids: snapshot.in_flight_provider_call_ids
      }
    }];
  });
}

export function kernelPublicationsV2(toolResultsValue: unknown): JsonRecord[] {
  const toolResults = record(toolResultsValue);
  const direct = directKernelPublicationsV2(toolResults);
  return direct.length > 0 ? direct : legacyKernelPublicationsV2(toolResults);
}

export function assignmentRowFromKernelPublicationV2(publication: JsonRecord): JsonRecord {
  const snapshot = record(publication.snapshot);
  return {
    id: `goal:${String(publication.assignment_id || record(snapshot.current_binding).assignment_id || "")}`,
    source_record_id: publication.assignment_id,
    assignment_snapshot_v2: snapshot
  };
}
