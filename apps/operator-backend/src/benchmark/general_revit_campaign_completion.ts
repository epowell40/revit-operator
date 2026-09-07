import { assertGeneralRevitCaseSettled, type GeneralRevitExportIsolation } from "./general_revit_export_isolation.js";

type RecordValue = Record<string, unknown>;
export type GeneralRevitCampaignStop = { case_id: string | null; reason: string; recovery_required: true };

export function retainedGeneralRevitCampaignStop(checkpoint: RecordValue | null): GeneralRevitCampaignStop | null {
  const context = checkpoint?.suite_context as RecordValue | undefined;
  if (context?.campaign_stop) return context.campaign_stop as GeneralRevitCampaignStop;
  const traces = Array.isArray(checkpoint?.task_traces) ? checkpoint.task_traces as RecordValue[] : [];
  const failed = traces.find(trace => trace.export_isolation_error);
  return failed ? { case_id: String(failed.case_id), reason: String(failed.export_isolation_error), recovery_required: true } : null;
}

export function generalRevitSuiteTiming(startedAt: string, invocationStartedMs: number, priorActiveMs: number,
  resumed: boolean, finishedAt: string | null, nowMs = Date.now()): RecordValue {
  const parsedStart = Date.parse(startedAt);
  return {
    schema: "revit-operator.benchmark-suite-timing.v1", started_at_utc: startedAt, finished_at_utc: finishedAt,
    last_checkpoint_at_utc: finishedAt || new Date(nowMs).toISOString(),
    wall_clock_ms: Number.isFinite(parsedStart) ? Math.max(0, nowMs - parsedStart) : null,
    active_wall_clock_ms: priorActiveMs + Math.max(0, nowMs - invocationStartedMs), resumed
  };
}

/** Stop before another fixture is opened; retain the trace and live artifacts for review. */
export function finishGeneralRevitCampaignCase(trace: RecordValue, isolation: GeneralRevitExportIsolation | null): GeneralRevitCampaignStop | null {
  try {
    assertGeneralRevitCaseSettled(trace);
    if (isolation) trace.export_artifacts = isolation.finish(String(trace.case_id), true);
    return null;
  } catch (error) {
    trace.export_isolation_error = String(error);
    return { case_id: String(trace.case_id), reason: String(error), recovery_required: true };
  }
}

export function generalRevitCampaignCompletion(selected: string[], traces: RecordValue[], stop: GeneralRevitCampaignStop | null) {
  const recorded = traces.map(trace => String(trace.case_id));
  const missing = selected.filter(id => !recorded.includes(id));
  const complete = stop === null && selected.length > 0 && missing.length === 0
    && recorded.length === selected.length && new Set(recorded).size === recorded.length;
  return { status: complete ? "completed" : "incomplete", complete, selected_case_ids: selected,
    recorded_case_ids: recorded, unrecorded_case_ids: missing, stop,
    score_scope: complete ? "selected_cases" : "recorded_cases_only_not_a_campaign_grade" };
}
