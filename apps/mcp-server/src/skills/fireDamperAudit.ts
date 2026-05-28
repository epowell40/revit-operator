import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callRevit } from "../lib/revitClient.js";

export const fireDamperAudit: Tool = {
    name: "fire_damper_audit",
    description: "Audits the Revit model for ducts penetrating fire/smoke rated walls and fixes compliance issues (missing dampers, undersized access).",
    inputSchema: {
        type: "object",
        properties: {
            mode: {
                type: "string",
                enum: ["audit", "fix"],
                description: "The operation mode. 'audit' reports issues; 'fix' applies corrections."
            },
            config: {
                type: "object",
                properties: {
                    fireDamperFamily: { type: "string", description: "Name of the Fire Damper family" },
                    smokeDamperFamily: { type: "string", description: "Name of the Smoke Damper family" },
                    comboDamperFamily: { type: "string", description: "Name of the Combo Fire/Smoke Damper family" },
                    minDuctWidthInches: { type: "number", description: "Minimum duct width for access compliance (default 14)" }
                }
            },
            fixes: {
                type: "array",
                description: "List of fix instructions (required for 'fix' mode)",
                items: {
                    type: "object",
                    properties: {
                        ductId: { type: "number" },
                        damperType: { type: "string" },
                        newWidthInches: { type: "number" },
                        location: {
                            type: "object",
                            properties: {
                                x: { type: "number" },
                                y: { type: "number" },
                                z: { type: "number" }
                            },
                            required: ["x", "y", "z"]
                        }
                    },
                    required: ["ductId", "damperType", "location"]
                }
            }
        },
        required: ["mode"]
    }
};

export async function handleFireDamperAudit(args: any) {
    const { mode, config, fixes } = args;

    try {
        const payload = {
            command: mode,
            config: config || {},
            fixes: fixes || []
        };

        const result = await callRevit("/revit/fire-damper-audit", "POST", payload);
        
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(result, null, 2)
                }
            ]
        };
    } catch (error) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error executing Fire Damper Audit: ${error instanceof Error ? error.message : String(error)}`
                }
            ],
            isError: true
        };
    }
}
