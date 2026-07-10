import { z } from "zod";
import { createOperatorBackendClient, type SemanticMepRoutePlanInput } from "../lib/operatorBackendClient.js";

export const semanticMepRouteInputSchema = z.object({
  userText: z.string().min(1).describe("Natural-language MEP routing request."),
  viewId: z.number().int().optional(),
  roomNumber: z.string().min(1).optional(),
  levelName: z.string().min(1).optional(),
  toolResults: z.array(z.unknown()).optional().describe("Prior read-only discovery results to refine the plan.")
}).strict();

export type SemanticMepRouteToolInput = z.infer<typeof semanticMepRouteInputSchema>;
export type SemanticMepRoutePlanner = Pick<ReturnType<typeof createOperatorBackendClient>, "planSemanticMepRoute">;

export async function handleSemanticMepRoutePlan(
  input: SemanticMepRouteToolInput,
  planner: SemanticMepRoutePlanner = createOperatorBackendClient()
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const request: SemanticMepRoutePlanInput = {
      userText: input.userText,
      ...(input.viewId === undefined ? {} : { viewId: input.viewId }),
      ...(input.roomNumber === undefined ? {} : { roomNumber: input.roomNumber }),
      ...(input.levelName === undefined ? {} : { levelName: input.levelName }),
      ...(input.toolResults === undefined ? {} : { toolResults: input.toolResults })
    };
    const response = await planner.planSemanticMepRoute(request);
    return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: String(error) }] };
  }
}

export function registerSemanticMepRouteTool(
  registerTool: (name: string, description: string, inputSchema: typeof semanticMepRouteInputSchema, handler: (input: SemanticMepRouteToolInput) => Promise<unknown>) => unknown,
  planner?: SemanticMepRoutePlanner
): unknown {
  return registerTool(
    "operator_plan_semantic_mep_route",
    "Create a read-only semantic MEP route plan. This tool never applies or writes Revit model changes.",
    semanticMepRouteInputSchema,
    async (input) => handleSemanticMepRoutePlan(input, planner)
  );
}
