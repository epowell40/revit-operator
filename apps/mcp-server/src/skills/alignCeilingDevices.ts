import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callRevit } from "../lib/revitClient.js";

export const alignCeilingDevicesTools: Tool[] = [
    {
        name: "align_ceiling_devices",
        description: "Aligns ceiling-hosted devices (lights, diffusers, sensors) to the ceiling grid.",
        inputSchema: {
            type: "object",
            properties: {
                selection: {
                    type: "object",
                    properties: {
                        ids: { type: "array", items: { type: "integer" }, description: "List of Element IDs to align." }
                    },
                    description: "Specific elements to align. If omitted, uses scope."
                },
                scope: {
                    type: "object",
                    properties: {
                        level_name: { type: "string", description: "Level to process if selection is empty." }
                    }
                },
                rules: {
                    type: "object",
                    properties: {
                        center_threshold_ratio: { type: "number", description: "Ratio (0..1) to decide centering." },
                        snap_tolerance_ft: { type: "number", description: "Max distance to move." }
                    }
                }
            }
        }
    }
];

export async function handleAlignCeilingDevices(name: string, args: any) {
    if (name !== "align_ceiling_devices") {
        throw new Error(`Unknown tool: ${name}`);
    }

    try {
        const payload = {
            selection: args.selection,
            scope: args.scope,
            rules: args.rules,
            grid_anchor: { method: "auto_api" } // Default to API
        };

        const result = await callRevit("/revit/align-ceiling-devices", "POST", payload);
        return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }]
        };
    } catch (error) {
        return {
            content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true
        };
    }
}
