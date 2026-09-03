import {
  parseAssignmentKernelRuntimeAttestationV2,
  type AssignmentKernelRuntimeAttestationV2
} from "@revitoperator/assignment-kernel-v2-contracts";

type QualificationCaseEffect = {
  case_id?: unknown;
  expected_effect?: unknown;
};

export type GeneralRevitQualificationWriteGrantRequirement = {
  required: boolean;
  case_ids: string[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function assertGeneralRevitQualificationRuntime(input: {
  required_assignment_kernel_v2: boolean;
  backend_health: unknown;
}): AssignmentKernelRuntimeAttestationV2 | null {
  if (!input.required_assignment_kernel_v2) return null;
  const response = record(input.backend_health);
  const backend = record(response.backend);
  try {
    if (response.ok !== true || backend.status !== "ok") throw new Error("backend health is unavailable");
    const attestation = parseAssignmentKernelRuntimeAttestationV2(backend.assignment_kernel_runtime);
    if (attestation.assignment_kernel_v2_enabled !== true) throw new Error("Assignment Kernel V2 is disabled");
    return attestation;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      "General Revit qualification runtime preflight failed before fixture, Assignment, provider, or Revit work: "
      + detail
    );
  }
}

export function generalRevitQualificationWriteGrantRequirement(
  cases: QualificationCaseEffect[],
  applyRequested: boolean
): GeneralRevitQualificationWriteGrantRequirement {
  const caseIds = new Set<string>();
  for (const candidate of cases) {
    const effect = String(candidate.expected_effect || "").trim().toLowerCase();
    if (!applyRequested && effect === "read") continue;
    const caseId = String(candidate.case_id || "").trim();
    if (caseId) caseIds.add(caseId);
  }
  return { required: caseIds.size > 0, case_ids: [...caseIds] };
}

export function assertGeneralRevitQualificationWriteGrant(input: {
  cases: QualificationCaseEffect[];
  apply_requested: boolean;
  grant: unknown;
}): void {
  const requirement = generalRevitQualificationWriteGrantRequirement(input.cases, input.apply_requested);
  if (!requirement.required) return;

  const grant = record(input.grant);
  if (grant.active === true && grant.write_ready === true) return;

  const detail = typeof grant.error === "string" && grant.error.trim()
    ? ` ${grant.error.trim()}`
    : "";
  throw new Error(
    `General Revit qualification write grant preflight failed for ${requirement.case_ids.join(", ")}`
    + ` before fixture, Assignment, provider, or Revit work.${detail}`
  );
}
