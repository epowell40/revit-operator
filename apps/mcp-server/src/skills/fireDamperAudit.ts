import { z } from "zod";
import { callRevit } from "../lib/revitClient.js";

export const fireDamperAuditInputSchema = z.object({
    mode: z.enum(["audit", "fix"]).describe("The operation mode. 'audit' reports issues; 'fix' applies corrections."),
    config: z.object({
        fireDamperFamily: z.string().optional().describe("Name of the Fire Damper family"),
        smokeDamperFamily: z.string().optional().describe("Name of the Smoke Damper family"),
        comboDamperFamily: z.string().optional().describe("Name of the Combo Fire/Smoke Damper family"),
        minDuctWidthInches: z.number().optional().describe("Minimum duct width for access compliance (default 14)")
    }).passthrough().optional(),
    fixes: z.array(z.object({
        ductId: z.number(),
        damperType: z.string(),
        newWidthInches: z.number().optional(),
        location: z.object({
            x: z.number(),
            y: z.number(),
            z: z.number()
        }).passthrough()
    }).passthrough()).optional().describe("List of fix instructions (required for 'fix' mode)")
}).passthrough();

export const fireDamperAudit = {
    name: "fire_damper_audit",
    description: "Audits the Revit model for ducts penetrating fire/smoke rated walls and fixes compliance issues (missing dampers, undersized access)."
} as const;

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
