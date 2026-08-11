import { randomUUID } from "node:crypto";
import { auditLog } from "./audit.js";

export const EXECUTION_STRATEGY_EVIDENCE_V1 = "revit-operator.execution-strategy-evidence.v1" as const;
export const EXECUTION_SUBSTRATES = [
  "typed_capability",
  "typed_capability_composition",
  "dynamic_revit_program"
] as const;

type ExecutionSubstrate = typeof EXECUTION_SUBSTRATES[number];

export type ExecutionStrategyEvidence = {
  schema: typeof EXECUTION_STRATEGY_EVIDENCE_V1;
  selected_substrate: ExecutionSubstrate;
  reason: string;
};

export type ExecutionStrategyEvidenceReceipt = {
  schemaVersion: "revit-operator.execution-strategy-evidence-receipt.v1";
  evidenceId: string;
  selected_substrate: ExecutionSubstrate;
  reason: string;
  recordedAtUtc: string;
  authority: "telemetry_only";
  authorization_granted: false;
};

export function recordExecutionStrategyEvidence(
  input: ExecutionStrategyEvidence,
  sink: (event: string, data: Record<string, unknown>) => void = auditLog,
  now: () => Date = () => new Date(),
  id: () => string = randomUUID
): ExecutionStrategyEvidenceReceipt {
  if (input?.schema !== EXECUTION_STRATEGY_EVIDENCE_V1) {
    throw new Error(`schema must be ${EXECUTION_STRATEGY_EVIDENCE_V1}`);
  }
  if (!(EXECUTION_SUBSTRATES as readonly string[]).includes(input.selected_substrate)) {
    throw new Error("selected_substrate is invalid");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 1 || reason.length > 320) throw new Error("reason must contain 1-320 characters");
  const receipt: ExecutionStrategyEvidenceReceipt = {
    schemaVersion: "revit-operator.execution-strategy-evidence-receipt.v1",
    evidenceId: `strategy_${id()}`,
    selected_substrate: input.selected_substrate,
    reason,
    recordedAtUtc: now().toISOString(),
    authority: "telemetry_only",
    authorization_granted: false
  };
  sink("execution.strategy.selected", receipt);
  return receipt;
}
