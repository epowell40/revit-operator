import { z } from "zod";
import { currentAssignmentKernelV2Binding } from "../lib/assignmentKernelV2.js";
import { createOperatorBackendClient } from "../lib/operatorBackendClient.js";

const pointSchema = z.object({ u: z.number().min(0).max(1), v: z.number().min(0).max(1) }).strict();
const regionSchema = z.object({ min_u: z.number().min(0).max(1), min_v: z.number().min(0).max(1), max_u: z.number().min(0).max(1), max_v: z.number().min(0).max(1) }).strict();
const endpointSchema = z.object({
  endpoint_key: z.string().min(1).max(160), point: pointSchema,
  outward_direction_uv: z.tuple([z.number().finite(), z.number().finite()]),
  boundary: z.enum(["internal", "view_boundary", "sheet_continuation"]),
  continuation_key: z.string().max(160),
  continuation_kind: z.enum(["none", "same_level_run", "vertical_riser"])
}).strict();
const claimSchema = z.object({
  attribute: z.enum(["system", "size", "type", "family", "host", "elevation", "vertical_extent"]),
  value: z.string().min(1).max(500), confidence: z.number().min(0).max(1),
  basis: z.enum(["legible_source_evidence", "approved_project_mapping", "provider_hypothesis", "unresolved"])
}).strict();

export const existingConditionsInterpretationInputSchema = z.object({
  packageId: z.string().min(1).max(160),
  objective: z.string().min(1).max(1200),
  views: z.array(z.object({
    viewKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
    attachmentId: z.string().min(1).max(240),
    page: z.number().int().min(1).max(10_000),
    analysisRole: z.enum(["sheet_context", "region_detail"]),
    region: regionSchema.optional(),
    parentContextViewKey: z.string().min(1).max(160).optional(),
    sheetHint: z.string().max(500).optional(),
    disciplineHint: z.enum(["architectural", "mechanical", "plumbing", "electrical"]).optional()
  }).strict()).min(2).max(12),
  response: z.object({
    schema_version: z.literal(1), package_id: z.string().min(1).max(160),
    coordinate_space: z.literal("normalized_uv_top_left"),
    view_keys: z.array(z.string().min(1).max(160)).min(2).max(12),
    source_marks: z.array(z.object({
      source_mark_id: z.string().min(1).max(160), source_view_key: z.string().min(1).max(160),
      disposition_status: z.enum(["candidate", "unresolved"]),
      primitive_ids: z.array(z.string().min(1).max(160)).max(1000), reason: z.string().max(1000)
    }).strict()).min(1).max(1000),
    primitives: z.array(z.object({
      primitive_id: z.string().min(1).max(160), source_view_key: z.string().min(1).max(160),
      source_mark_ids: z.array(z.string().min(1).max(160)).max(1000),
      kind: z.enum(["wall_segment", "route_segment", "opening", "point_symbol", "annotation"]),
      points: z.array(pointSchema).min(1).max(2000), endpoints: z.array(endpointSchema).max(1000),
      claims: z.array(claimSchema).max(7),
      confidence: z.object({ geometry: z.number().min(0).max(1), classification: z.number().min(0).max(1), topology: z.number().min(0).max(1), visibility: z.number().min(0).max(1) }).strict()
    }).strict()).max(1000),
    open_questions: z.array(z.string().min(1).max(1000)).max(200)
  }).strict(),
  maximumSourceMarks: z.number().int().min(1).max(1000).optional(),
  maximumPrimitives: z.number().int().min(1).max(1000).optional()
}).strict();

export type ExistingConditionsInterpretationToolInput = z.infer<typeof existingConditionsInterpretationInputSchema>;
type Validator = Pick<ReturnType<typeof createOperatorBackendClient>, "validateExistingConditionsInterpretation">;

export async function handleExistingConditionsInterpretation(
  input: ExistingConditionsInterpretationToolInput,
  validator: Validator = createOperatorBackendClient()
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const binding = currentAssignmentKernelV2Binding();
    if (!binding) throw new Error("assignment_kernel_v2_trusted_binding_required");
    const response = await validator.validateExistingConditionsInterpretation({
      schema_version: 1,
      assignment_id: binding.assignment_id,
      assignment_run_id: binding.run_id,
      assignment_generation: binding.generation,
      session_id: binding.session_id,
      package_id: input.packageId,
      objective: input.objective,
      views: input.views.map(view => ({
        view_key: view.viewKey, attachment_id: view.attachmentId, page: view.page, analysis_role: view.analysisRole,
        ...(view.region ? { region: view.region } : {}),
        ...(view.parentContextViewKey ? { parent_context_view_key: view.parentContextViewKey } : {}),
        ...(view.sheetHint ? { sheet_hint: view.sheetHint } : {}),
        ...(view.disciplineHint ? { discipline_hint: view.disciplineHint } : {})
      })),
      response: input.response,
      ...(input.maximumSourceMarks === undefined ? {} : { maximum_source_marks: input.maximumSourceMarks }),
      ...(input.maximumPrimitives === undefined ? {} : { maximum_primitives: input.maximumPrimitives })
    });
    return { content: [{ type: "text", text: JSON.stringify(response) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
}

export function registerExistingConditionsInterpretationTool(
  registerTool: (name: string, description: string, inputSchema: typeof existingConditionsInterpretationInputSchema, handler: (input: ExistingConditionsInterpretationToolInput) => Promise<unknown>) => unknown,
  validator?: Validator
): unknown {
  return registerTool(
    "operator_validate_existing_conditions_interpretation",
    "Bind a structured whole-sheet plus regional-detail interpretation to PDF pages in the current task. Validates source accounting and maps regional UV geometry into full-page coordinates. Read-only: it never creates or changes Revit elements.",
    existingConditionsInterpretationInputSchema,
    input => handleExistingConditionsInterpretation(input, validator)
  );
}
