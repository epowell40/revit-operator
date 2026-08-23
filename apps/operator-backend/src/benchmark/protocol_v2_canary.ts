import type { GeneralRevitCapabilityCase } from "./general_revit_capability_acceptance.js";

export const RELEASE_CANARY_CASE_PREFIXES_V2 = [
  "q01", "r01", "b04", "r10", "r13", "c03", "c12", "c15", "c30", "r16"
] as const;

export const RELEASE_CANARY_CASE_IDS_V2 = [
  "q01_air_device_inventory",
  "r01_text_note_edit",
  "b04_duplicate_view",
  "r10_duct_route",
  "r13_schedule_airflow_sync",
  "c03_level4_enlarged_plan_terse",
  "c12_replace_outdated_note_terse",
  "c15_move_notes_clear",
  "c30_hide_arch_rooms_level4",
  "r16_tag_layout_cleanup"
] as const;

export function selectReleaseCanaryCasesV2(cases: readonly GeneralRevitCapabilityCase[]): GeneralRevitCapabilityCase[] {
  const byId = new Map(cases.map((entry) => [entry.case_id, entry]));
  const selected = RELEASE_CANARY_CASE_IDS_V2.map((caseId) => {
    const match = byId.get(caseId);
    if (!match) throw new Error(`Release canary case '${caseId}' is missing; add an explicit versioned mapping instead of substituting a case.`);
    return match;
  });
  if (new Set(selected.map((entry) => entry.case_id)).size !== RELEASE_CANARY_CASE_IDS_V2.length) {
    throw new Error("Release canary contains a duplicate case mapping.");
  }
  return selected;
}

export function assertReleaseCanaryInvocationV2(args: { resume: boolean; receiptComplete: boolean }): void {
  if (args.resume) throw new Error("Release canary is non-resumed by default; use a new run identity and exact rerun comparison.");
  if (!args.receiptComplete) throw new Error("Release canary fails closed on incomplete provider or Revit receipts.");
}
