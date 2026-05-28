import { callRevit } from "../lib/revitClient.js";

async function run() {
    console.log("Investigating Fire Ratings...");
    
    // We can't easily run arbitrary C# code via the API, 
    // but we can use the '/revit/query' endpoint if it supports parameter filtering.
    // Or simpler: Use '/revit/get-parameters' on a few walls.
    
    // 1. Get all walls
    const query = {
        category: "Walls",
        limit: 50 // Check 50 random walls
    };
    
    // We assume /revit/query exists and works as a basic dump
    // If not, we might need to use a different tool.
    // Let's try to just use `revit_query_elements` tool wrapper if available, or call directly.
    
    try {
        const walls = await callRevit("/revit/query", "POST", query);
        if (!Array.isArray(walls)) {
            console.error("Query failed:", walls);
            return;
        }
        
        console.log(`Retrieved ${walls.length} walls.`);
        
        let ratedCount = 0;
        const ratings = new Set();
        
        // 2. Check parameters for each wall
        for (const wall of walls) {
             const params = await callRevit("/revit/get-parameters", "GET", { elementId: wall.id });
             
             // Look for "Fire Rating"
             const rating = params.find((p: any) => p.name === "Fire Rating");
             if (rating && rating.value) {
                 ratedCount++;
                 ratings.add(rating.value);
                 console.log(`Wall ${wall.id}: ${rating.value}`);
             }
        }
        
        console.log(`Found ${ratedCount} rated walls in sample.`);
        console.log("Unique Ratings:", Array.from(ratings));
        
    } catch (e) {
        console.error(e);
    }
}

run();
