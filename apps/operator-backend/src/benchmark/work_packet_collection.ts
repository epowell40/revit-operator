export type PacketJsonRecord = Record<string, unknown>;

function asRecord(value: unknown): PacketJsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PacketJsonRecord : {};
}

export async function loadVerifiedWorkPackets(
  baseUrl: string,
  assignmentProjection: unknown,
  assignmentKernelV2: unknown,
  requestJson: (baseUrl: string, pathname: string, options?: RequestInit, timeoutMs?: number) => Promise<PacketJsonRecord>
): Promise<PacketJsonRecord> {
  const v2 = asRecord(assignmentKernelV2);
  const v2AssignmentIds = v2.schema === "revit-operator.benchmark-assignment-kernel-v2/v1"
    && Array.isArray(v2.assignment_ids)
    ? [...new Set(v2.assignment_ids.map((value) => String(value ?? "").trim()).filter(Boolean))]
    : [];
  const legacyAssignments = Array.isArray(asRecord(assignmentProjection).assignments)
    ? (asRecord(assignmentProjection).assignments as unknown[]).map(asRecord)
    : [];
  // New V2 traffic is discovered only from the shared V2 session publication.
  // The legacy projection remains an isolated fallback for historical V1 runs.
  const assignmentIds = v2AssignmentIds.length > 0
    ? v2AssignmentIds
    : [...new Set(legacyAssignments
      .map((assignment) => String(assignment.id || assignment.source_record_id || "").replace(/^goal:/, "").trim())
      .filter(Boolean))];
  const packets: PacketJsonRecord[] = [];
  const failures: PacketJsonRecord[] = [];
  for (const id of assignmentIds) {
    try {
      const response = asRecord(await requestJson(
        baseUrl, `/api/assignments/${encodeURIComponent(id)}/verified-work-packet`, {}, 30_000
      ));
      const packet = asRecord(response.packet);
      if (packet.packet_id && packet.packet_hash) packets.push(packet);
      else failures.push({ assignment_id: id, error: "packet_identity_missing" });
    } catch (error) {
      failures.push({ assignment_id: id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    schema: "revit-operator.benchmark-work-packets/v1",
    assignment_source: v2AssignmentIds.length > 0 ? "assignment_kernel_v2" : "legacy_v1_projection",
    packets,
    failures
  };
}
