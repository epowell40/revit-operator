import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callRevit } from "../lib/revitClient.js";
import * as fs from "fs";
import * as path from "path";

// Load config
const CONFIG_PATH = path.join(process.cwd(), "data", "lighting_config.json");
let config: any = {};
try {
    if (fs.existsSync(CONFIG_PATH)) {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
} catch (e) {
    console.error("Failed to load lighting config", e);
}

export const lightingAuditTools: Tool[] = [
    {
        name: "validate_ies_files",
        description: "Checks all lighting fixtures for valid IES files. Can optionally fix paths based on a map.",
        inputSchema: {
            type: "object",
            properties: {
                fix: { type: "boolean", description: "If true, attempts to fix invalid paths using provided corrections." },
                corrections: { 
                    type: "object", 
                    description: "Map of FamilyName -> New IES Path (optional)" 
                }
            }
        }
    },
    {
        name: "check_photometrics",
        description: "Calculates Average Foot-candles (FC) for rooms or levels using Zonal Cavity Method approximation.",
        inputSchema: {
            type: "object",
            properties: {
                scope: { type: "string", description: "Scope of analysis: 'Level 1', 'Room 101', or 'Building'." },
                visualize: { type: "boolean", description: "If true, creates Text Notes in the active view." },
                cu: { type: "number", description: "Coefficient of Utilization (default 0.8)" },
                llf: { type: "number", description: "Light Loss Factor (default 0.85)" }
            },
            required: ["scope"]
        }
    },
    {
        name: "audit_lpd",
        description: "Audits Lighting Power Density (LPD) for Spaces.",
        inputSchema: {
            type: "object",
            properties: {
                scope: { type: "string", description: "Scope: 'Level 1' or 'Building' (default)" }
            }
        }
    }
];

export async function handleLightingAudit(name: string, args: any) {
    let command = "";
    let payload: any = {};

    switch (name) {
        case "validate_ies_files":
            command = "validate_ies";
            payload = { 
                command, 
                fix: args.fix, 
                ies_corrections: args.corrections 
            };
            break;
        case "check_photometrics":
            command = "photometrics";
            payload = { 
                command, 
                scope: args.scope, 
                visualize: args.visualize,
                default_cu: args.cu ?? 0.8,
                default_llf: args.llf ?? 0.85
            };
            break;
        case "audit_lpd":
            command = "lpd";
            payload = { 
                command, 
                scope: args.scope ?? "Building" 
            };
            break;
        default:
            throw new Error(`Unknown tool: ${name}`);
    }

    try {
        const result = await callRevit("/revit/lighting-audit", "POST", payload);
        
        // Post-process LPD with config data if available
        if (command === "lpd" && Array.isArray(result)) {
            const enriched = result.map((r: any) => {
                // Find matching config for space type
                // Note: r.type might be "Office", "Corridor" etc.
                const conf = config.space_types?.find((c: any) => r.type.includes(c.type));
                const limit = conf ? conf.max_lpd : null;
                const status = limit ? (r.lpd <= limit ? "PASS" : "FAIL") : "UNKNOWN_LIMIT";
                return { ...r, limit, status };
            });
            return {
                content: [{ type: "text" as const, text: JSON.stringify(enriched, null, 2) }]
            };
        }

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
