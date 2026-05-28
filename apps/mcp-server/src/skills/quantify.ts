import { RunBundle } from "../lib/RunBundle.js";
import { callRevit } from "../lib/revitClient.js";

// Mapping of common terms to Revit Categories and Keywords
const CATEGORY_MAP: { [key: string]: { categories: string[], keywords?: string[] } } = {
    "toilet": { categories: ["OST_PlumbingFixtures"], keywords: ["toilet", "water closet", "wc"] },
    "urinal": { categories: ["OST_PlumbingFixtures"], keywords: ["urinal"] },
    "sink": { categories: ["OST_PlumbingFixtures"], keywords: ["sink", "lavatory", "basin"] },
    "plumbing": { categories: ["OST_PlumbingFixtures"] },
    "door": { categories: ["OST_Doors"] },
    "window": { categories: ["OST_Windows"] },
    "wall": { categories: ["OST_Walls"] },
    "room": { categories: ["OST_Rooms"] },
    "furniture": { categories: ["OST_Furniture"] },
    "chair": { categories: ["OST_Furniture"], keywords: ["chair", "seat"] },
    "desk": { categories: ["OST_Furniture"], keywords: ["desk", "table"] },
    "equipment": { categories: ["OST_SpecialityEquipment", "OST_MechanicalEquipment", "OST_ElectricalEquipment"] },
    "refrigerator": { categories: ["OST_SpecialityEquipment", "OST_GenericModel"], keywords: ["refrigerator", "fridge"] },
    "light": { categories: ["OST_LightingFixtures"] },
    "terminal": { categories: ["OST_DuctTerminal"] },
    "vav": { categories: ["OST_MechanicalEquipment"], keywords: ["vav", "variable air volume", "box"] },
    "diffuser": { categories: ["OST_DuctTerminal"], keywords: ["diffuser", "grille", "register"] }
};

interface QuantifyRequest {
    intent: string;
    scope?: string;
    categories: string[];
    filters: {
        level?: string;
        keywords_include?: string[];
        keywords_exclude?: string[];
        parameters?: any[];
    };
    group_by: string[];
    room_resolution: boolean;
}

export async function runQuantify(query: string) {
    const bundle = new RunBundle("quantify", { query });
    await bundle.init();

    try {
        bundle.log(`Parsing query: "${query}"`);

        // 1. Parse NL Query
        const request = parseQuantifyQuery(query);
        bundle.log("Parsed Request", request);

        if (request.categories.length === 0) {
            throw new Error("Could not identify what to count. Please specify a category (e.g., 'toilets', 'doors').");
        }

        // 2. Call Revit Handler
        const response: any = await callRevit("/revit/quantify", "POST", request);
        
        if (!response) {
            throw new Error("No response from Revit.");
        }

        bundle.log(`Received ${response.summary.total} items.`);

        // 3. Generate CSV/JSON Artifacts
        if (response.rows && response.rows.length > 0) {
            const headers = ["ID", "Category", "Type", "Name", "Level", "Room"];
            const csvRows = [headers.join(",")];
            
            for (const row of response.rows) {
                const line = [
                    row.id,
                    `"${row.category || ''}"`, 
                    `"${row.type || ''}"`, 
                    `"${row.name || ''}"`, 
                    `"${row.level || ''}"`, 
                    `"${row.room || ''}"`
                ];
                csvRows.push(line.join(","));
            }

            const csvPath = await bundle.saveArtifact("quantify_results.csv", csvRows.join("\n"));
            bundle.log(`Saved detailed results to ${csvPath}`);
        }

        const jsonPath = await bundle.saveArtifact("quantify_results.json", JSON.stringify(response, null, 2));
        bundle.log(`Saved raw response to ${jsonPath}`);

        // Optional visualization helpers (follow-ups by resultSetId)
        const visMode = parseVisualizationMode(query);
        if (visMode && typeof response.resultSetId === "string" && response.resultSetId.trim()) {
            try {
                const visRes: any = await callRevit("/revit/quantify-visualize", "POST", {
                    resultSetId: response.resultSetId,
                    mode: visMode,
                });
                bundle.log("Visualization response", visRes);
            } catch (e) {
                bundle.log("Visualization failed (non-fatal)", String(e));
            }
        }

        // 4. Format Output for Chat
        let output = `Found **${response.summary.total}** items.`;
        
        if (response.summary.groups) {
            output += "\n\n**Breakdown:**\n";
            for (const [key, count] of Object.entries(response.summary.groups)) {
                output += `- ${key}: ${count}\n`;
            }
        }

        if (response.warnings && response.warnings.length > 0) {
            output += `\n*Warnings: ${response.warnings.join(", ")}*`;
        }

        const result = {
            message: output,
            total: response.summary.total,
            groups: response.summary.groups,
            resultSetId: response.resultSetId ?? null
        };

        await bundle.complete(result);
        return result;

    } catch (error) {
        await bundle.fail(error);
        throw error;
    }
}

export function parseQuantifyQuery(query: string): QuantifyRequest {
    const lowerQuery = query.toLowerCase();
    const req: QuantifyRequest = {
        intent: parseIntent(lowerQuery),
        categories: [],
        filters: {},
        group_by: ["Type"],
        room_resolution: lowerQuery.includes("room") || lowerQuery.includes("where")
    };

    // Linked scope heuristics
    if (lowerQuery.includes("linked") || lowerQuery.includes("links") || lowerQuery.includes("link model") || lowerQuery.includes("in links")) {
        req.scope = "both";
    }

    // 1. Identify Categories & Keywords
    for (const [key, map] of Object.entries(CATEGORY_MAP)) {
        // Simple plural check: "toilets" -> "toilet"
        if (lowerQuery.includes(key) || lowerQuery.includes(key + "s")) {
            req.categories.push(...map.categories);
            if (map.keywords) {
                if (!req.filters.keywords_include) req.filters.keywords_include = [];
                req.filters.keywords_include.push(...map.keywords);
            }
        }
    }

    // Deduplicate categories
    req.categories = [...new Set(req.categories)];

    // 2. Identify Level
    // Regex for "Level X" or "L1"
    const levelMatch = query.match(/(?:level|floor)\s+(\w+)/i) || query.match(/\b(L\d+)\b/i);
    if (levelMatch) {
        // Need to be careful. If user says "Level 1", we pass "Level 1". 
        // Ideally we resolve this to a full level name via another call, 
        // but for V1 let's pass the string and let the Handler try strict matching 
        // (or we can improve the handler to do fuzzy matching).
        // Let's assume standard "Level 1" format or pass the raw match.
        req.filters.level = `Level ${levelMatch[1].replace(/^L/i, '')}`; // Norm "L1" -> "Level 1" heuristic
        
        // Use the original capture if it looks like a full name
        if (query.match(/level\s+\d+/i)) {
             req.filters.level = levelMatch[0]; // "Level 1"
        }
    }

    // 3. Grouping
    if (lowerQuery.includes("group by room") || lowerQuery.includes("per room")) {
        req.group_by = ["Room"];
        req.room_resolution = true;
    } else if (lowerQuery.includes("group by level")) {
        req.group_by = ["Level"];
    }

    return req;
}

function parseIntent(lowerQuery: string): string {
    if (/\bhow many\b/.test(lowerQuery) || lowerQuery.trim().startsWith("count ")) return "count";
    if (lowerQuery.includes("list ")) return "list";
    return "count_and_list";
}

function parseVisualizationMode(query: string): "highlight" | "isolate" | "new_view" | "clear" | null {
    const q = query.toLowerCase();
    if (q.includes("clear highlight") || q.includes("clear isolate") || q.includes("clear selection")) return "clear";
    if (q.includes("isolate")) return "isolate";
    if (q.includes("show") || q.includes("results view")) return "new_view";
    if (q.includes("highlight") || q.includes("select")) return "highlight";
    return null;
}
