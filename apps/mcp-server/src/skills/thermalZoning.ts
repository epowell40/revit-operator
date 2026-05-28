import { RunBundle } from "../lib/RunBundle.js";
import { callRevit } from "../lib/revitClient.js";

interface ThermalZoningRequest {
    levelNames: string[];
    targetArea: number;
    keywords: string[];
    recreate: boolean;
}

export async function runThermalZoning(query: string) {
    const bundle = new RunBundle("thermal_zoning", { query });
    await bundle.init();

    try {
        bundle.log(`Parsing query: "${query}"`);

        // 1. Parse Query (Simple Heuristics)
        const request: ThermalZoningRequest = {
            levelNames: [],
            targetArea: 500,
            keywords: ["Corridor", "Elec", "Mech", "Stair", "Lobby"],
            recreate: query.toLowerCase().includes("regenerate")
        };

        const levelMatch = query.match(/(?:level|floor)\s+(\w+)/ig);
        if (levelMatch) {
            request.levelNames = levelMatch.map(m => {
                const num = m.split(' ')[1];
                return `Level ${num}`; // Standardize "Level 1"
            });
        }
        
        if (request.levelNames.length === 0) {
            // Fallback: Ask for current view level or default to Level 1?
            // For now, let's assume Level 1 if unspecified for testing.
            bundle.log("No specific levels found in query, defaulting to Level 1.");
            request.levelNames.push("Level 1");
        }

        bundle.log("Target Levels:", request.levelNames);

        const results = [];

        for (const level of request.levelNames) {
            bundle.log(`Processing ${level}...`);

            // Step A: Ensure Spaces
            bundle.log("Checking spaces...");
            const spaceRes: any = await callRevit("/revit/ensure-spaces", "POST", { levelName: level });
            if (spaceRes.errors && spaceRes.errors.length > 0) {
                bundle.log(`Errors creating spaces: ${spaceRes.errors.join(", ")}`);
            }
            bundle.log(`Spaces: ${spaceRes.existingSpaces} existing, ${spaceRes.spacesCreated} created.`);

            // Step B: Create Zones
            bundle.log("Generating thermal zones...");
            const zoneRes: any = await callRevit("/revit/create-zones", "POST", { 
                levelName: level,
                targetArea: request.targetArea,
                keywords: request.keywords
            });
            
            if (zoneRes.warnings && zoneRes.warnings.length > 0) {
                bundle.log(`Warnings: ${zoneRes.warnings.join(", ")}`);
            }
            bundle.log(`Created ${zoneRes.zones.length} zones.`);

            // Step C: Create Visuals
            bundle.log("Creating views and sheets...");
            const visRes: any = await callRevit("/revit/create-zone-visuals", "POST", { levelName: level });
            if (!visRes.success) {
                bundle.log(`Error creating visuals: ${visRes.error}`);
            } else {
                bundle.log(`View: ${visRes.viewName}, Sheet: ${visRes.sheetName || 'Existing'}`);
            }

            results.push({
                level,
                spaces: spaceRes,
                zones: zoneRes.zones,
                visuals: visRes
            });
        }

        // 4. Generate Report
        const reportRows = ["Level,Zone ID,Zone Name,Area,Space Count"];
        for (const r of results) {
            for (const z of r.zones) {
                reportRows.push(`${r.level},${z.id},${z.name},${z.area.toFixed(1)},${z.spaceCount}`);
            }
        }
        await bundle.saveArtifact("thermal_zones.csv", reportRows.join("\n"));

        // 5. Output
        const totalZones = results.reduce((sum, r) => sum + r.zones.length, 0);
        const output = `Completed Thermal Zoning for ${request.levelNames.join(", ")}. Created ${totalZones} zones total.`;
        
        await bundle.complete({ message: output, details: results });
        return { message: output };

    } catch (error) {
        await bundle.fail(error);
        throw error;
    }
}
