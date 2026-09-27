import { z } from "zod";
import { currentAssignmentKernelV2Binding } from "../lib/assignmentKernelV2.js";
import { createOperatorBackendClient } from "../lib/operatorBackendClient.js";

const openEndInputSchema = z.object({
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
const interiorTeeInputSchema = z.object({
  connectionMode: z.literal("interior_tee"),
  registrationEvidenceId: z.string().regex(/^ev1_[A-Za-z0-9_-]{32}$/),
  primitiveId: z.string().min(1).max(160),
  mainConnectorObservationId: z.string().regex(/^obsv2_[a-f0-9]{64}$/),
  deferredFarEndReason: z.string().min(3).max(240),
  nativeMapping: z.object({
    mainElementId: z.number().int().positive(),
    levelName: z.string().min(1).max(160),
    elevationZFt: z.number().finite(),
    systemType: z.string().min(1).max(160),
    routeTypeId: z.number().int().positive(),
    shape: z.literal("round"),
    size: z.string().min(1).max(80)
  }).strict()
}).strict();
export const existingConditionsDuctContinuationInputSchema = z.union([openEndInputSchema, interiorTeeInputSchema]);

export type ExistingConditionsDuctContinuationInput = z.infer<typeof existingConditionsDuctContinuationInputSchema>;
type Planner = Pick<ReturnType<typeof createOperatorBackendClient>, "planExistingConditionsDuctContinuation" | "planExistingConditionsDuctBranch">;

export async function handleExistingConditionsDuctContinuation(
  input: ExistingConditionsDuctContinuationInput,
  planner: Planner = createOperatorBackendClient()
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const binding = currentAssignmentKernelV2Binding();
    if (!binding) throw new Error("assignment_kernel_v2_trusted_binding_required");
    const context = {
      assignment_id: binding.assignment_id,
      assignment_run_id: binding.run_id,
      assignment_generation: binding.generation,
      session_id: binding.session_id,
      registration_evidence_id: input.registrationEvidenceId,
      primitive_id: input.primitiveId,
    };
    let response: unknown;
    if ("connectionMode" in input) {
      response = await planner.planExistingConditionsDuctBranch({
        ...context,
        main_connector_observation_id: input.mainConnectorObservationId,
        native_mapping: {
          main_element_id: input.nativeMapping.mainElementId,
          level_name: input.nativeMapping.levelName,
          elevation_z_ft: input.nativeMapping.elevationZFt,
          system_type: input.nativeMapping.systemType,
          route_type_id: input.nativeMapping.routeTypeId,
          shape: input.nativeMapping.shape,
          size: input.nativeMapping.size,
          deferred_far_end_reason: input.deferredFarEndReason
        }
      });
    } else {
      response = await planner.planExistingConditionsDuctContinuation({
      ...context,
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
    }
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
    "Plan one source-bound duct continuation from an exact registered PDF primitive and fresh native /revit/get-connectors evidence. For an open connector, supply connectorObservationId and requiredExistingEndpoint. For a branch into the interior of an already-connected straight duct, set connectionMode:'interior_tee', mainConnectorObservationId, and nativeMapping.mainElementId. The host checks the registered PDF junction, native main geometry, size, type, and system before staging a split tee; do not ask the user to place a tee manually. Planning does not modify Revit. For registered_for_staged_dry_run, call revit_call_tool POST /revit/existing-conditions-mep-draft-workflow with {registered_stage_key: next_stage_key, stage_phase:'dry_run', dryRun:true}. After verified rollback, use the same key with stage_phase:'apply', dryRun:false. Never reconstruct the request from preview points.",
    existingConditionsDuctContinuationInputSchema,
    input => handleExistingConditionsDuctContinuation(input, planner)
  );
}
