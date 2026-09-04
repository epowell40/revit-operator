import type { AssignmentSnapshotV2 } from "../snapshot.js";

/** Cumulative wall time with admitted work, reconstructed from durable receipts.
 * Idle/waiting time consumes no allowance. Overlapping provider and native work
 * count once; an unsettled interval remains charged across process loss.
 */
export function assignmentActiveExecutionTimeMsV2(snapshot: AssignmentSnapshotV2, now: string): number {
  const until = Date.parse(now);
  const created = Date.parse(snapshot.spec.created_at);
  if (!Number.isFinite(until) || !Number.isFinite(created)) return Infinity;
  const intervals = [
    ...Object.values(snapshot.provider_calls).map(call => {
      const start = Date.parse(call.admitted_at);
      // Imported receipts distinguish provider duration from receipt delivery.
      // Do not turn a delayed notification into extra model execution time.
      const end = call.provider_duration_ms != null
        ? start + call.provider_duration_ms
        : Date.parse(call.completed_at ?? call.response_transport_completed_at ?? now);
      return [start, end];
    }),
    ...Object.values(snapshot.operations).map(operation => [Date.parse(operation.opened_at), Date.parse(operation.settled_at ?? now)])
  ];
  if (intervals.some(([start, end]) => !Number.isFinite(start) || !Number.isFinite(end))) return Infinity;
  // Imported/native timestamps may predate local admission. Such a receipt
  // cannot charge history before this task or create a negative duration.
  const bounded = intervals.map(([start, end]) => [Math.min(until, Math.max(created, start)), Math.min(until, Math.max(created, start, end))]);
  bounded.sort(([left], [right]) => left - right);
  let elapsed = 0;
  let coveredUntil = -Infinity;
  for (const [start, end] of bounded) {
    elapsed += Math.max(0, end - Math.max(start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, end);
  }
  return elapsed;
}
