import { callRevit } from "../lib/revitClient.js";
import { planAutoDimension, applyAutoDimension } from "../skills/autoDimension.js";

async function run() {
    console.log("Step 1: finding 'LEVEL 02 DIMENSION PLAN'...");
    const viewsRes = await callRevit("/revit/views", "GET");
    if (!Array.isArray(viewsRes)) {
        console.error("Failed to list views:", viewsRes);
        return;
    }

    const targetName = "LEVEL 02 DIMENSION PLAN";
    const sourceView = viewsRes.find((v: any) => v.name === targetName);

    if (!sourceView) {
        console.error(`View '${targetName}' not found.`);
        return;
    }

    console.log(`Found source view: ${sourceView.name} (ID: ${sourceView.id})`);

    console.log("Step 2: Duplicating View...");
    const dupRes = await callRevit("/revit/duplicate-view", "POST", {
        viewId: sourceView.id,
        newName: `LEVEL 02 DIMENSION PLAN - AutoDim ${Date.now()}`,
        withDetailing: false
    }) as any;

    if (dupRes.error) {
        console.error("Failed to duplicate view:", dupRes.error);
        return;
    }

    const newViewId = dupRes.viewId;
    console.log(`Created new view: ${dupRes.name} (ID: ${newViewId})`);

    console.log("Step 3: Planning Auto-Dimensions...");
    // Note: We need to make sure the data (walls/grids) is available.
    // In a real flow, we might need to refresh the data for the new view, 
    // but assuming the model content is the same, we can use the existing 'walls_with_geo.json' 
    // if it covers the whole model or if we re-query.
    // The current 'planAutoDimension' implementation loads from local JSON files.
    // To be safe, we should probably trigger a data refresh, but for this test we'll assume 
    // the JSON files in 'mcp-server' (level 2 rooms, walls, grids) are sufficient.
    
    try {
        const proposals = await planAutoDimension(newViewId);
        console.log(`Generated ${proposals.length} dimension proposals.`);

        // Log proposals for inspection
        const fs = await import('fs/promises');
        await fs.writeFile('proposals.json', JSON.stringify(proposals, null, 2));
        console.log("Saved proposals to 'proposals.json'");

        if (proposals.length > 0) {
            console.log("Step 4: Applying Dimensions...");
            const result = await applyAutoDimension(newViewId, proposals);
            console.log("Result:", JSON.stringify(result, null, 2));
        } else {
            console.log("No proposals generated.");
        }
    } catch (e) {
        console.error("Error in auto-dimensioning:", e);
    }
}

run();
