export type PacketJsonRecord = Record<string, unknown>;

function asRecord(value: unknown): PacketJsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PacketJsonRecord : {};
}

export async function loadVerifiedWorkPackets(
  baseUrl: string,
  assignmentProjection: unknown,
  requestJson: (baseUrl: string, pathname: string, options?: RequestInit, timeoutMs?: number) => Promise<PacketJsonRecord>
): Promise<PacketJsonRecord> {
  const assignments = Array.isArray(asRecord(assignmentProjection).assignments)
    ? (asRecord(assignmentProjection).assignments as unknown[]).map(asRecord)
    : [];
  const packets: PacketJsonRecord[] = [];
  const failures: PacketJsonRecord[] = [];
  for (const assignment of assignments) {
    const id = String(assignment.id || assignment.source_record_id || "").replace(/^goal:/, "").trim();
    if (!id) continue;
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
  return { schema: "revit-operator.benchmark-work-packets/v1", packets, failures };
}
