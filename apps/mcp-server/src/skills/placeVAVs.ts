import { RunBundle } from "../lib/RunBundle.js";
import { callRevit } from "../lib/revitClient.js";

interface SizingConfig {
    cfmPerSF: number;
    maxInletSize: number;
    sizes: number[];
}

interface VavInstance {
    x: number;
    y: number;
    z: number;
    parameters: { [key: string]: string };
}

export async function runPlaceVAVs(query: string) {
    const bundle = new RunBundle("place_vavs", { query });
    await bundle.init();

    try {
        bundle.log(`Parsing query: "${query}"`);

        // 1. Config Defaults
        const config: SizingConfig = {
            cfmPerSF: 1.0,
            maxInletSize: 14,
            sizes: [6, 8, 10, 12, 14]
        };

        // 2. Parse Level
        let levelName = "Level 1"; // Default
        const levelMatch = query.match(/(?:level|floor)\s+(\w+)/i) || query.match(/\b(L\d+)\b/i);
        if (levelMatch) {
            levelName = `Level ${levelMatch[1].replace(/^L/i, '')}`;
            if (query.match(/level\s+\d+/i)) levelName = levelMatch[0];
        }
        bundle.log(`Targeting Level: ${levelName}`);

        // 3. Query Zone Data
        bundle.log("Fetching zone data...");
        const zones: any[] = await callRevit("/revit/query-zone-data", "POST", { levelName }) as any[];
        
        if (!zones || zones.length === 0) {
            throw new Error(`No thermal zones found on ${levelName}. Run 'Create thermal zoning' first.`);
        }
        bundle.log(`Found ${zones.length} zones.`);

        // 4. Compute Placement
        const placements: VavInstance[] = [];
        let totalCfm = 0;

        for (const zone of zones) {
            // Skip if VAVs already exist?
            if (zone.existingVavIds && zone.existingVavIds.length > 0 && !query.includes("regenerate")) {
                bundle.log(`Skipping Zone ${zone.zoneId} (Already has VAVs).`);
                continue;
            }

            // Calc CFM
            let zoneArea = 0;
            let zoneCentroid = { x: 0, y: 0, count: 0 };
            
            for (const s of zone.spaces) {
                zoneArea += s.area;
                zoneCentroid.x += s.x;
                zoneCentroid.y += s.y;
                zoneCentroid.count++;
            }
            
            if (zoneCentroid.count > 0) {
                zoneCentroid.x /= zoneCentroid.count;
                zoneCentroid.y /= zoneCentroid.count;
            }

            const requiredCFM = Math.ceil(zoneArea * config.cfmPerSF);
            totalCfm += requiredCFM;

            // Size Selection
            // Max CFM for 14" @ say 1500 FPM ~ 1600 CFM. Let's use simple lookup.
            // 6": 200, 8": 400, 10": 700, 12": 1100, 14": 1600.
            const capacityMap = { 6: 200, 8: 400, 10: 700, 12: 1100, 14: 1600 };
            const maxSingleBox = capacityMap[14];

            let count = 1;
            if (requiredCFM > maxSingleBox) {
                count = Math.ceil(requiredCFM / maxSingleBox);
            }

            const cfmPerBox = Math.ceil(requiredCFM / count);
            
            // Pick Size
            let size = 14;
            for (const s of [6, 8, 10, 12, 14]) {
                if (cfmPerBox <= capacityMap[s as keyof typeof capacityMap]) {
                    size = s;
                    break;
                }
            }

            // Generate Instances
            // If count > 1, we should ideally split spaces using K-Means.
            // For V1, we just stack them slightly offset or place along a line.
            for (let i = 0; i < count; i++) {
                const offsetX = (i - (count - 1) / 2) * 4.0; // Spacing 4ft
                placements.push({
                    x: zoneCentroid.x + offsetX,
                    y: zoneCentroid.y,
                    z: 10.0, // Default ceiling height assumption? Or read from space?
                    parameters: {
                        "ROS_ZoneId": zone.zoneId,
                        "ROS_ZoneName": zone.zoneName,
                        "ROS_EstCFM": cfmPerBox.toString(),
                        "Size": `${size}"`, // Assuming parameter is string "Size" or diameter? 
                        // Often families have "Inlet Diameter" (Double).
                        "Inlet Diameter": (size / 12.0).toString(),
                        "Mark": `VAV-${levelName.replace("Level ", "")}-${zone.zoneId}-${i+1}`
                    }
                });
            }
        }

        if (placements.length === 0) {
            await bundle.complete("No VAVs needed or all zones already populated.");
            return;
        }

        // 5. Place Families
        bundle.log(`Placing ${placements.length} VAV units...`);
        // We need a family name. Hardcoded for prototype or query?
        // Default to "VAV Unit - Single Duct"
        const placeRes: any = await callRevit("/revit/place-families", "POST", {
            levelName,
            familyName: "VAV Unit - Single Duct", // Adjust to loaded family
            symbolName: "Standard",
            instances: placements
        });

        if (placeRes.error) {
            throw new Error(`Placement failed: ${placeRes.error}`);
        }
        bundle.log(`Placed ${placeRes.placedCount} units.`);

        // 6. Tag Elements
        if (placeRes.elementIds.length > 0) {
            bundle.log("Tagging units...");
            const tagRes: any = await callRevit("/revit/tag-elements", "POST", {
                viewName: `M-TZ-${levelName}`, // Use the zoning view
                elementIds: placeRes.elementIds
            });
            bundle.log(`Tagged ${tagRes.taggedCount} units.`);
        }

        // 7. Create Schedule
        bundle.log("Creating/Updating Schedule...");
        await callRevit("/revit/create-schedule", "POST", {
            scheduleName: "VAV Schedule (ROS)",
            categoryName: "OST_MechanicalEquipment",
            fields: ["Mark", "ROS_ZoneId", "ROS_EstCFM", "Size", "Comments"]
        });

        const output = `Successfully placed ${placeRes.placedCount} VAVs for ${zones.length} zones on ${levelName}. Total Load: ${totalCfm} CFM.`;
        await bundle.complete(output);
        return { message: output };

    } catch (error) {
        await bundle.fail(error);
        throw error;
    }
}
