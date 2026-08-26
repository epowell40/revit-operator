export const ASSIGNMENT_KERNEL_V2_FEATURE_FLAG = "OPERATOR_ASSIGNMENT_KERNEL_V2" as const;

export function assignmentKernelV2Enabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(environment[ASSIGNMENT_KERNEL_V2_FEATURE_FLAG] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "enabled";
}
