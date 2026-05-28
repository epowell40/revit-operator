import { planAutoDimension, applyAutoDimension } from "./dist/skills/autoDimension.js";

async function run() {
    const viewId = 68320448;
    console.log("Starting Auto-Dimensioning Run...");
    
    try {
        const proposals = await planAutoDimension(viewId);
        console.log(`Generated ${proposals.length} proposals.`);
        
        if (proposals.length > 0) {
            console.log("Sample Proposal:", JSON.stringify(proposals[0], null, 2));
            
            console.log("Applying dimensions...");
            const result = await applyAutoDimension(viewId, proposals);
            console.log("Result:", JSON.stringify(result, null, 2));
        } else {
            console.log("No proposals generated. Check room data alignment.");
        }
        
    } catch (e) {
        console.error("Error running auto-dimension:", e);
    }
}

run();
