import { z } from "zod";
import { currentAssignmentKernelV2Binding } from "../lib/assignmentKernelV2.js";
import { createOperatorBackendClient } from "../lib/operatorBackendClient.js";

const uvSchema = z.object({ u: z.number().min(0).max(1), v: z.number().min(0).max(1) }).strict();

export const existingConditionsRegistrationInputSchema = z.object({
  interpretationEvidenceId: z.string().regex(/^ev1_[A-Za-z0-9_-]{32}$/),
  frameObservationId: z.string().regex(/^obsv2_[a-f0-9]{64}$/),
  controls: z.array(z.object({
    controlId: z.string().min(1).max(160),
    sourcePageUv: uvSchema,
    candidateViewUv: uvSchema
  }).strict()).min(3).max(12),
  allowReflection: z.boolean().optional(),
  maxRmsErrorFt: z.number().finite().positive().max(100).optional(),
  maxPointErrorFt: z.number().finite().positive().max(100).optional()
}).strict();

export type ExistingConditionsRegistrationToolInput = z.infer<typeof existingConditionsRegistrationInputSchema>;
type Registrar = Pick<ReturnType<typeof createOperatorBackendClient>, "registerExistingConditionsInterpretation">;

export async function handleExistingConditionsRegistration(
  input: ExistingConditionsRegistrationToolInput,
  registrar: Registrar = createOperatorBackendClient()
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const binding = currentAssignmentKernelV2Binding();
    if (!binding) throw new Error("assignment_kernel_v2_trusted_binding_required");
    const response = await registrar.registerExistingConditionsInterpretation({
      schema_version: 1,
      assignment_id: binding.assignment_id,
      assignment_run_id: binding.run_id,
      assignment_generation: binding.generation,
      session_id: binding.session_id,
      interpretation_evidence_id: input.interpretationEvidenceId,
      frame_observation_id: input.frameObservationId,
      controls: input.controls.map(control => ({
        control_id: control.controlId,
        source_page_uv: control.sourcePageUv,
        candidate_view_uv: control.candidateViewUv
      })),
      ...(input.allowReflection === undefined ? {} : { allow_reflection: input.allowReflection }),
      ...(input.maxRmsErrorFt === undefined ? {} : { max_rms_error_ft: input.maxRmsErrorFt }),
      ...(input.maxPointErrorFt === undefined ? {} : { max_point_error_ft: input.maxPointErrorFt })
    });
    return { content: [{ type: "text", text: JSON.stringify(response) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
}

export function registerExistingConditionsRegistrationTool(
  registerTool: (name: string, description: string, inputSchema: typeof existingConditionsRegistrationInputSchema, handler: (input: ExistingConditionsRegistrationToolInput) => Promise<unknown>) => unknown,
  registrar?: Registrar
): unknown {
  return registerTool(
    "operator_register_existing_conditions_interpretation",
    "Register source-bound existing-conditions geometry to an authoritative Revit view frame using 3 to 12 matching landmarks. frameObservationId must be the obsv2_ observation_id in the model-observation-index returned by revit_call_tool POST /revit/export-view-frame, never an ev1_ evidence_id. Reports measured residuals and fails closed when the fit is outside the requested limits. Read-only: it never creates or changes Revit elements.",
    existingConditionsRegistrationInputSchema,
    input => handleExistingConditionsRegistration(input, registrar)
  );
}
