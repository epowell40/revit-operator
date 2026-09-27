import { z } from "zod";
import { currentAssignmentKernelV2Binding } from "../lib/assignmentKernelV2.js";
import { createOperatorBackendClient } from "../lib/operatorBackendClient.js";

export const existingConditionsRegistrationHandoffInputSchema = z.object({
  originRegistrationEvidenceId: z.string().regex(/^ev1_[A-Za-z0-9_-]{32}$/),
  currentLandmarkObservationId: z.string().regex(/^obsv2_[a-f0-9]{64}$/)
}).strict();
export type ExistingConditionsRegistrationHandoffInput = z.infer<typeof existingConditionsRegistrationHandoffInputSchema>;
type Client = Pick<ReturnType<typeof createOperatorBackendClient>, "resumeExistingConditionsRegistration">;

export async function handleExistingConditionsRegistrationHandoff(
  input: ExistingConditionsRegistrationHandoffInput,
  client: Client = createOperatorBackendClient()
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const binding = currentAssignmentKernelV2Binding();
    if (!binding) throw new Error("assignment_kernel_v2_trusted_binding_required");
    const result = await client.resumeExistingConditionsRegistration({
      assignment_id: binding.assignment_id,
      assignment_run_id: binding.run_id,
      assignment_generation: binding.generation,
      session_id: binding.session_id,
      origin_registration_evidence_id: input.originRegistrationEvidenceId,
      current_landmark_observation_id: input.currentLandmarkObservationId
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
}

export function registerExistingConditionsRegistrationHandoffTool(
  registerTool: (name: string, description: string, inputSchema: typeof existingConditionsRegistrationHandoffInputSchema, handler: (input: ExistingConditionsRegistrationHandoffInput) => Promise<unknown>) => unknown,
  client?: Client
): unknown {
  return registerTool(
    "operator_resume_existing_conditions_registration",
    "Carry a completed PDF-to-Revit registration from an earlier Assignment in this same Operator conversation. First obtain a fresh, complete native /revit/export-visible-elements observation of the active view's Grids. Supply its obsv2_ observation ID and the prior registration ev1_ evidence ID. The host verifies project identity, view, and every grid axis against the original native evidence, then creates a new evidence reference scoped to this Assignment. This is read-only and does not repeat PDF analysis or permit model writes. A mismatch must be investigated, never forced into alignment.",
    existingConditionsRegistrationHandoffInputSchema,
    input => handleExistingConditionsRegistrationHandoff(input, client)
  );
}
