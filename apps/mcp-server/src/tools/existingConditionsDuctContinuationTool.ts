import { z } from "zod";
import { currentAssignmentKernelV2Binding } from "../lib/assignmentKernelV2.js";
import { createOperatorBackendClient } from "../lib/operatorBackendClient.js";

export const existingConditionsDuctContinuationInputSchema = z.object({
  registrationEvidenceId: z.string().regex(/^ev1_[A-Za-z0-9_-]{32}$/),
  primitiveId: z.string().min(1).max(160),
  connectorObservationId: z.string().regex(/^obsv2_[a-f0-9]{64}$/),
  requiredExistingEndpoint: z.enum(["start", "end"]),
  deferredFarEndReason: z.string().min(3).max(240),
  nativeMapping: z.object({
    levelName: z.string().min(1).max(160),
    elevationZFt: z.number().finite(),
    systemType: z.string().min(1).max(160),
    routeTypeName: z.string().min(1).max(160).optional(),
    routeTypeId: z.number().int().positive().optional(),
    shape: z.enum(["round", "rectangular", "oval"]),
    size: z.string().min(1).max(80)
  }).strict()
}).strict();

export type ExistingConditionsDuctContinuationInput = z.infer<typeof existingConditionsDuctContinuationInputSchema>;
type Planner = Pick<ReturnType<typeof createOperatorBackendClient>, "planExistingConditionsDuctContinuation">;

export async function handleExistingConditionsDuctContinuation(
  input: ExistingConditionsDuctContinuationInput,
  planner: Planner = createOperatorBackendClient()
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const binding = currentAssignmentKernelV2Binding();
    if (!binding) throw new Error("assignment_kernel_v2_trusted_binding_required");
    const response = await planner.planExistingConditionsDuctContinuation({
      assignment_id: binding.assignment_id,
      assignment_run_id: binding.run_id,
      assignment_generation: binding.generation,
      session_id: binding.session_id,
      registration_evidence_id: input.registrationEvidenceId,
      primitive_id: input.primitiveId,
      connector_observation_id: input.connectorObservationId,
      required_existing_endpoint: input.requiredExistingEndpoint,
      deferred_far_end_reason: input.deferredFarEndReason,
      native_mapping: {
        level_name: input.nativeMapping.levelName,
        elevation_z_ft: input.nativeMapping.elevationZFt,
        system_type: input.nativeMapping.systemType,
        ...(input.nativeMapping.routeTypeName ? { route_type_name: input.nativeMapping.routeTypeName } : {}),
        ...(input.nativeMapping.routeTypeId ? { route_type_id: input.nativeMapping.routeTypeId } : {}),
        shape: input.nativeMapping.shape,
        size: input.nativeMapping.size
      }
    });
    return { content: [{ type: "text", text: JSON.stringify(response) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
}

export function registerExistingConditionsDuctContinuationTool(
  registerTool: (name: string, description: string, inputSchema: typeof existingConditionsDuctContinuationInputSchema, handler: (input: ExistingConditionsDuctContinuationInput) => Promise<unknown>) => unknown,
  planner?: Planner
): unknown {
  return registerTool(
    "operator_plan_existing_conditions_duct_continuation",
    "Plan one source-bound duct continuation from an exact registered PDF primitive and a fresh native /revit/get-connectors observation. Supply the registered evidence and obsv2_ observation IDs, not model coordinates. The host retrieves both under the active Assignment, validates one exact existing connector owner, preserves the far end as an unresolved continuation, and returns a staged dry-run workflow. Planning does not modify Revit.",
    existingConditionsDuctContinuationInputSchema,
    input => handleExistingConditionsDuctContinuation(input, planner)
  );
}
