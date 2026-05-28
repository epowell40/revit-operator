import { RunBundle } from "../lib/RunBundle.js";
import { callRevit } from "../lib/revitClient.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

export async function runCodeCompliance(query: string) {
    const bundle = new RunBundle("code_compliance", { query });
    await bundle.init();

    try {
        bundle.log(`Parsing query: "${query}"`);

        // 1. Load Rules
        const rulesPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "code_rules.json");
        if (!fs.existsSync(rulesPath)) {
            throw new Error("Rules file not found at " + rulesPath);
        }
        const ruleset = JSON.parse(fs.readFileSync(rulesPath, "utf8"));

        // 2. Generate Rulebook Artifact (Verification Step)
        let rulebookMd = "# Active Code Compliance Rulebook\n\n";
        rulebookMd += "| ID | Description | Check | Threshold | Category | Filters | Citation |\n";
        rulebookMd += "|---|---|---|---|---|---|---|\n";
        for (const r of ruleset.rules) {
            const check = r.check_type ?? "";
            let threshold = "";
            switch (check) {
                case "inscribed_circle":
                    threshold = `>= ${r.min_diameter_in}\" diameter`;
                    break;
                case "min_area":
                    threshold = `>= ${r.min_sf} SF`;
                    break;
                case "min_dimension":
                    threshold = `>= ${r.min_dim_ft} ft`;
                    break;
                case "param_value":
                    threshold = `${r.param_name} >= ${r.min_val_ft} ft`;
                    break;
                case "distance_to_wall":
                    threshold = `${r.min_dist_in}-${r.max_dist_in}\"`;
                    break;
                case "clearance_box":
                    threshold = `depth ${r.clearance_depth_ft} ft (${r.direction ?? "?"}), ratio ${r.clearance_width_ratio ?? 1}`;
                    break;
                default:
                    threshold = "(unknown)";
                    break;
            }

            const elementFilters = Array.isArray(r.filter_name_contains) ? r.filter_name_contains.join(", ") : "";
            const roomFilters = Array.isArray(r.filter_room_name_contains) ? r.filter_room_name_contains.join(", ") : "";
            const filters = [elementFilters ? `elem: ${elementFilters}` : "", roomFilters ? `room: ${roomFilters}` : ""]
                .filter(Boolean)
                .join(" | ");

            rulebookMd += `| ${r.id} | ${r.description ?? ""} | ${check} | ${threshold} | ${r.category ?? ""} | ${filters} | ${r.citation ?? ""} |\n`;
        }
        
        await bundle.saveArtifact("active_rulebook.md", rulebookMd);
        bundle.log("Generated active_rulebook.md for validation.");

        // 3. Parse Scope
        const levels = [];
        const levelMatch = query.match(/(?:level|floor)\s+(\w+)/i) || query.match(/\b(L\d+)\b/i);
        if (levelMatch) {
            levels.push(`Level ${levelMatch[1].replace(/^L/i, '')}`);
        } else {
            levels.push("Level 1"); // Default
        }

        const roomNames: string[] = [];
        const q = query.toLowerCase();
        if (q.includes("patient")) roomNames.push("Patient");
        if (q.includes("toilet") || q.includes("restroom") || q.includes("wc")) roomNames.push("Toilet");
        if (q.includes("operating room") || q.includes("operating")) roomNames.push("Operating");
        if (q.includes("exam")) roomNames.push("Exam");
        if (q.includes("corridor") || q.includes("hall")) roomNames.push("Corridor");
        if (q.includes("icu") || q.includes("critical")) roomNames.push("ICU");
        if (q.includes("nicu") || q.includes("neonatal")) roomNames.push("NICU");
        if (q.includes("hospice") || q.includes("palliative")) roomNames.push("Hospice");

        // 4. Run Analysis
        bundle.log(`Running spatial analysis on ${levels.join(", ") }...`);
        const report: any = await callRevit("/revit/spatial-analysis", "POST", {
            levels,
            room_names: roomNames,
            ruleset
        });

        // 5. Output Results
        await bundle.saveArtifact("compliance_report.json", JSON.stringify(report, null, 2));

        let output = `**Compliance Check Complete**\n`;
        output += `- Passed: ${report.summary.passed}\n`;
        output += `- Failed: ${report.summary.failed}\n`;
        
        if (report.violations && report.violations.length > 0) {
            output += `\n**Violations:**\n`;
            for (const v of report.violations) {
                const loc = v.location ? ` @ (${v.location.x.toFixed(2)}, ${v.location.y.toFixed(2)}, ${v.location.z.toFixed(2)})` : "";
                output += `- **${v.roomName}**: Failed rule *${v.rule}* (${v.citation}). Expected ${v.expected}, found ${v.actual}${loc}.\n`;
            }
        } else {
            output += "\nNo violations found.";
        }

        await bundle.complete(output);
        return { message: output };

    } catch (error) {
        await bundle.fail(error);
        throw error;
    }
}
