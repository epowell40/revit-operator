import * as fs from 'fs';
import * as path from 'path';
import { callRevit } from "../lib/revitClient.js";
import { RandomForestClassifier } from 'ml-random-forest';

// --- Interfaces ---

interface Point { x: number; y: number; z?: number; }
interface Line { p1: Point; p2: Point; }
interface Element {
    id: number;
    name: string;
    level?: string;
    geometry?: Line;
    location?: Point;
    type?: 'Grid' | 'Wall';
}

export interface DimensionProposal {
    type: "Chain" | "RoomSlice";
    elements: number[];
    description: string;
    line?: Line;
    meta?: {
        kind:
            | "ml-merged"
            | "dense-slice"
            | "tile-slice"
            | "adjacent"
            | "room-span"
            | "room-bbox"
            | "wall-repair"
            | "grid-chain"
            | "overall"
            | "wall-to-wall"
            | "opening-locator";
        roomId?: number;
        roomIds?: number[];
        orientation?: "H" | "V";
        mlScore?: number;
    };
}

interface AlignmentGroup {
    key: string;
    elements: Element[];
    type: 'Grid' | 'Wall';
    geom: Line;
    features: number[];
    isDefined: boolean;
}

type BadRefsState = {
    wallIds?: Record<string, number>;
    pairIds?: Record<string, number>;
};

const BAD_REFS_REL_PATH = path.join("work", "EPIC-0004_auto-dimensioning", "bad_refs.json");

function resolveRepoRelativePath(relPath: string) {
    // Prefer repo-root relative paths even when executed from `mcp-server/`.
    const cwd = process.cwd();
    const c0 = path.resolve(cwd, relPath);
    const c1 = path.resolve(cwd, "..", relPath);
    const c2 = path.resolve(cwd, "..", "..", relPath);
    const isMcpServerCwd = path.basename(cwd).toLowerCase() === "mcp-server";
    const candidates = isMcpServerCwd ? [c1, c0, c2] : [c0, c1, c2];

    const existing = candidates.find(fs.existsSync);
    if (existing) return existing;

    if (isMcpServerCwd) return c1;
    return c0;
}

function loadBadRefs() {
    const p = resolveRepoRelativePath(BAD_REFS_REL_PATH);
    try {
        if (!fs.existsSync(p)) return { badWallIds: new Set<number>(), badPairs: new Set<string>(), path: p };
        const raw = fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, "");
        const data = JSON.parse(raw) as BadRefsState;
        const badWallIds = new Set<number>();
        const badPairs = new Set<string>();

        const WALL_THRESHOLD = 3; // only blacklist walls that fail repeatedly
        for (const [k, v] of Object.entries(data.wallIds ?? {})) {
            const id = Number(k);
            if (!Number.isFinite(id)) continue;
            if ((v ?? 0) >= WALL_THRESHOLD) badWallIds.add(id);
        }

        const PAIR_THRESHOLD = 1;
        for (const [k, v] of Object.entries(data.pairIds ?? {})) {
            if ((v ?? 0) >= PAIR_THRESHOLD) badPairs.add(String(k));
        }

        return { badWallIds, badPairs, path: p };
    } catch {
        return { badWallIds: new Set<number>(), badPairs: new Set<string>(), path: p };
    }
}

function bumpBadRefs(kind: string, ids: number[]) {
    const p = resolveRepoRelativePath(BAD_REFS_REL_PATH);
    let state: BadRefsState = {};
    try {
        if (fs.existsSync(p)) state = JSON.parse(fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, ""));
    } catch { }

    if (!state.wallIds) state.wallIds = {};
    if (!state.pairIds) state.pairIds = {};

    const uniq = Array.from(new Set(ids.filter(n => Number.isFinite(n)))).sort((a, b) => a - b);
    for (const id of uniq) {
        state.wallIds[String(id)] = (state.wallIds[String(id)] ?? 0) + 1;
    }

    if (uniq.length >= 2) {
        const pairKey = `${kind}|${uniq.slice(0, 2).join(",")}`;
        state.pairIds[pairKey] = (state.pairIds[pairKey] ?? 0) + 1;
    }

    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(state, null, 2));
    } catch { }
}

// --- Geometric & Feature Utils ---

function getDir(line: Line) {
    const dx = line.p2.x - line.p1.x;
    const dy = line.p2.y - line.p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    return { x: dx / len, y: dy / len };
}

function getDist(l1: Line, l2: Line) {
    // Distance between parallel infinite lines
    const dir = getDir(l1);
    const n = { x: -dir.y, y: dir.x }; // Normal
    // Project vector from l1.p1 to l2.p1 onto normal
    const dx = l2.p1.x - l1.p1.x;
    const dy = l2.p1.y - l1.p1.y;
    return Math.abs(dx * n.x + dy * n.y);
}

function getAlignmentKey(geom: Line) {
    if (!geom) return null;
    let dx = geom.p2.x - geom.p1.x;
    let dy = geom.p2.y - geom.p1.y;
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    
    if (angle < 0) angle += 180;
    if (angle >= 180) angle -= 180;
    
    const snappedAngle = Math.round(angle);
    
    // Distance from Origin
    const A = geom.p1.y - geom.p2.y;
    const B = geom.p2.x - geom.p1.x;
    const C = geom.p1.x * geom.p2.y - geom.p2.x * geom.p1.y;
    
    const dist = Math.abs(C) / Math.sqrt(A * A + B * B);
    const snappedDist = Math.round(dist * 10) / 10;
    
    return `${snappedAngle}_${snappedDist}`;
}

function getWallTypeFeatures(name: string) {
    const n = name.toLowerCase();
    return [
        n.includes('exterior') ? 1 : 0,
        n.includes('interior') ? 1 : 0,
        n.includes('core') || n.includes('shaft') ? 1 : 0,
        n.includes('curtain') ? 1 : 0,
        // Rough thickness guess based on name
        n.includes('cmu') ? 12 : (n.includes('furring') ? 2 : 5)
    ];
}

// --- Main Logic ---

export async function planAutoDimension(
    viewId: number,
    opts?: {
        /**
         * Controls aggressiveness and selection defaults.
         * - `coverage`: maximize wall coverage (can be visually dense).
         * - `architect`: fewer, more standard "dimension-plan" constraints.
         */
        preset?: "coverage" | "architect";
        /**
         * If true (default), selection starts with walls already referenced by existing dimensions
         * in the target view, so the tool preferentially fills in what's missing instead of
         * re-dimensioning already-defined geometry.
         */
        respectExistingDimensions?: boolean;
        /**
         * How to create room-level (interior) dimensions.
         * - `raycast`: legacy, can create long “stripe” dimensions across many rooms.
         * - `bbox`: uses room boundary loops to place 1 H + 1 V local dimension per room (preferred).
         * - `none`: skips room-level dimensions.
         */
        roomMode?: "raycast" | "bbox" | "none";
        /**
         * Whether to add "adjacent spacing" proposals (can create long stripes).
         * Keep off for a cleaner architectural-first output.
         */
        includeAdjacent?: boolean;
        /**
         * Dense slice proposals are long, slice-based strings (high recall, higher clutter).
         * Disable for cleaner architectural output.
         */
        includeDenseSlices?: boolean;
        /**
         * Tile slice proposals add local "sweeps" per tile (can still create stripe-like clutter).
         * Disable for cleaner architectural output; wall-repair can fill remaining gaps.
         */
        includeTileSlices?: boolean;
        /**
         * If true (default in `coverage` preset), generate local 2-ref "repair" constraints to increase adequacy.
         * This can add many dimensions; consider disabling for architect-quality output.
         */
        includeWallRepair?: boolean;
        /**
         * If true (default in `coverage` preset), selection enforces at least one H and one V room constraint
         * for each sampled room. Disable for architect-quality output (rooms then become optional candidates).
         */
        enforceRoomConstraints?: boolean;
        /** Maximum number of room groups to consider (affects clutter). */
        roomMaxGroups?: number;
        /** If true, includes corridor rooms and generates width dimensions for them. */
        includeCorridors?: boolean;
        /** Number of width samples per corridor (when corridors are included). */
        corridorSampleCount?: number;
        /** Lower this to stop earlier (fewer dimensions). */
        targetWallCoverage?: number;
        /** Hard cap on selected dimensions (useful for architect preset). */
        maxDimensions?: number;
        /**
         * Whether to add a small set of "global/grid" chains.
         * - `always`: always add (can duplicate on reruns)
         * - `ifEmpty`: add only if the view has no existing dimensions (default when respectExistingDimensions=true)
         * - `none`: never add
         */
        globalsMode?: "always" | "ifEmpty" | "none";
    }
) {
    console.log(`Planning auto-dimensions (Constraint Solver) for view ${viewId}...`);

    // 1. Load Data
    const readJson = (name: string) => {
        try {
            // Check multiple paths to be robust
            const pathsToCheck = [
                path.resolve(process.cwd(), name),
                path.resolve(process.cwd(), 'mcp-server', name),
                path.resolve(process.cwd(), '../', name)
            ];

            let p = pathsToCheck.find(fs.existsSync);
            
            if (!p) {
                console.warn(`File not found: ${name} in ${pathsToCheck.join(', ')}`);
                return [];
            }

            let raw = fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, '');
            const data = JSON.parse(raw);
            return Array.isArray(data) ? data : (data.value || []);
        } catch (e) {
            console.warn(`Could not read ${name}`, e);
            return [];
        }
    };

    const tryLoadFromRevit = async () => {
        try {
            // Prefer the richer `dimensioning_v2` export since `/revit/query` does not include view-projected geometry.
            const LIMIT = 100000;
            const dimv2 = await callRevit<any>("/revit/export-dimensioning-v2", "POST", {
                viewId,
                includePotentialElements: true,
                elementLimit: LIMIT,
            });

            const elems = Array.isArray(dimv2?.elements) ? dimv2.elements : [];
            const toLine = (g: any): Line | undefined => {
                if (!g || !g.p1 || !g.p2) return undefined;
                return { p1: { x: Number(g.p1.x), y: Number(g.p1.y) }, p2: { x: Number(g.p2.x), y: Number(g.p2.y) } };
            };
            const mapped: Element[] = elems.map((e: any): Element => {
                const geom2d = toLine(e?.geom2d);
                return {
                    id: Number(e?.id),
                    name: String(e?.name ?? e?.typeName ?? ""),
                    level: e?.level ? String(e.level) : undefined,
                    geometry: geom2d,
                    type: e?.category === "Grids" ? "Grid" : e?.category === "Walls" ? "Wall" : undefined,
                };
            });

            const walls = mapped.filter((e) => e.type === "Wall");
            const grids = mapped.filter((e) => e.type === "Grid");

            console.log(`Loaded live elements from Revit (dimensioning_v2): walls=${walls.length}, grids=${grids.length}`);
            return { walls, grids };
        } catch (e) {
            console.warn("Could not load elements from Revit; falling back to local JSON files.", e);
            return null;
        }
    };

    const live = await tryLoadFromRevit();
    const walls = (live?.walls ?? readJson('walls_with_geo.json')) as Element[];
    const grids = (live?.grids ?? readJson('grids_with_geo.json')) as Element[];
    
    const validWalls = walls.filter(w => w.geometry);
    const validGrids = grids.filter(g => g.geometry);

    console.log(`Loaded ${validWalls.length} walls and ${validGrids.length} grids.`);

    const preset = opts?.preset ?? "coverage";
    const respectExistingDimensions = opts?.respectExistingDimensions ?? true;
    const roomMode = opts?.roomMode ?? (preset === "architect" ? "bbox" : "raycast");
    const includeAdjacent = opts?.includeAdjacent ?? (preset !== "architect");
    const includeDenseSlices = opts?.includeDenseSlices ?? true;
    const includeTileSlices = opts?.includeTileSlices ?? (preset !== "architect");
    const includeWallRepair = opts?.includeWallRepair ?? true;
    const enforceRoomConstraints = opts?.enforceRoomConstraints ?? (preset === "coverage");
    const includeCorridors = opts?.includeCorridors ?? (preset === "architect");
    const corridorSampleCountRaw = opts?.corridorSampleCount ?? (preset === "architect" ? 3 : 0);
    const corridorSampleCount = Math.max(0, Math.min(8, Number.isFinite(corridorSampleCountRaw) ? corridorSampleCountRaw : 0));
    const roomMaxGroupsRaw = opts?.roomMaxGroups ?? (preset === "architect" ? 30 : 220);
    const roomMaxGroups = Math.max(0, Math.min(400, Number.isFinite(roomMaxGroupsRaw) ? roomMaxGroupsRaw : 0));
    const targetWallCoverage = opts?.targetWallCoverage ?? (preset === "coverage" ? 0.93 : 0.80);
    const maxDimensionsRaw = opts?.maxDimensions ?? (preset === "architect" ? 140 : undefined);
    const maxDimensions = Number.isFinite(maxDimensionsRaw as any) ? (maxDimensionsRaw as number) : undefined;
    const globalsMode = opts?.globalsMode ?? (respectExistingDimensions ? "ifEmpty" : "always");
    const initiallyCoveredWallIds = new Set<number>();
    let existingDimCount = 0;
    if (respectExistingDimensions) {
        try {
            const dims = await callRevit("/revit/analyze-dimensions", "POST", { viewId }) as any[];
            existingDimCount = Array.isArray(dims) ? dims.length : 0;
            const wallIdSet = new Set<number>(validWalls.map(w => w.id));
            for (const d of dims ?? []) {
                for (const r of (d?.references ?? [])) {
                    const id = Number(r?.elementId);
                    if (!Number.isFinite(id)) continue;
                    if (wallIdSet.has(id)) initiallyCoveredWallIds.add(id);
                }
            }
            if (initiallyCoveredWallIds.size > 0) {
                console.log(`Detected ${initiallyCoveredWallIds.size} walls already referenced by dimensions in view ${viewId}.`);
            }
        } catch (e) {
            console.warn("Could not analyze existing dimensions for initial coverage; continuing.", e);
        }
    }

    // 2. Alignment Grouping
    const groups: { [key: string]: AlignmentGroup } = {};

    // --- NEW LOGIC: Calculate Building Extents ---
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    
    // Use validWalls and validGrids
    [...validWalls, ...validGrids].forEach(el => {
        if (el.geometry) {
            minX = Math.min(minX, el.geometry.p1.x, el.geometry.p2.x);
            maxX = Math.max(maxX, el.geometry.p1.x, el.geometry.p2.x);
            minY = Math.min(minY, el.geometry.p1.y, el.geometry.p2.y);
            maxY = Math.max(maxY, el.geometry.p1.y, el.geometry.p2.y);
        }
    });
    console.log(`Building Extents: [${minX}, ${minY}] to [${maxX}, ${maxY}]`);

    const processElement = (el: Element, type: 'Grid' | 'Wall') => {
        if (!el.geometry) return;
        const key = getAlignmentKey(el.geometry);
        if (!key) return;

        if (!groups[key]) {
            groups[key] = {
                key,
                elements: [],
                type,
                geom: el.geometry,
                features: type === 'Wall' ? getWallTypeFeatures(el.name || "") : [0, 0, 0, 0, 0],
                isDefined: false // Will set Grids to true later
            };
        }
        // Hierarchy: Grid > Wall
        if (type === 'Grid') {
            groups[key].type = 'Grid';
            // If a group contains a Grid, it is fundamentally a Grid Group (e.g. Wall on Grid Line)
        }
        groups[key].elements.push(el);
    };

    validGrids.forEach(g => processElement(g, 'Grid'));
    validWalls.forEach(w => processElement(w, 'Wall'));

    // Initialize Definition Status: Grids are defined
    Object.values(groups).forEach(g => {
        if (g.type === 'Grid') g.isDefined = true;
    });

    // --- Spatial Clustering ---
    // Split "Infinite Line" groups into spatial clusters if gaps exist.
    const clusteredGroups: { [key: string]: AlignmentGroup } = {};
    const GAP_THRESHOLD = 20.0; // feet
    const elementToGroupKey: { [id: number]: string } = {};

    for (const key in groups) {
        const group = groups[key];
        if (group.elements.length === 0) continue;

        // If only 1 element, no need to sort/split, but we rename key for consistency
        if (group.elements.length === 1) {
            const newKey = `${key}_c0`;
            clusteredGroups[newKey] = { ...group, key: newKey };
            elementToGroupKey[group.elements[0].id] = newKey;
            continue;
        }

        // Calculate projection axis
        const dir = getDir(group.geom); 
        
        const projections = group.elements.map(el => {
            if (!el.geometry) return { el, min: 0, max: 0 };
            const t1 = el.geometry.p1.x * dir.x + el.geometry.p1.y * dir.y;
            const t2 = el.geometry.p2.x * dir.x + el.geometry.p2.y * dir.y;
            return {
                el,
                min: Math.min(t1, t2),
                max: Math.max(t1, t2)
            };
        });

        projections.sort((a, b) => a.min - b.min);

        let clusterIndex = 0;
        let prevMax = projections[0].max;
        
        let currentClusterElements: Element[] = [projections[0].el];

        for (let i = 1; i < projections.length; i++) {
            const curr = projections[i];
            // If gap is large, split
            if (curr.min - prevMax > GAP_THRESHOLD) {
                // Save old cluster
                const newKey = `${key}_c${clusterIndex}`;
                clusteredGroups[newKey] = {
                    ...group,
                    key: newKey,
                    elements: [...currentClusterElements]
                };
                currentClusterElements.forEach(e => elementToGroupKey[e.id] = newKey);
                
                // Start new cluster
                clusterIndex++;
                currentClusterElements = [];
                prevMax = curr.max; // Reset max for new cluster
            } else {
                // Extend max
                prevMax = Math.max(prevMax, curr.max);
            }
            currentClusterElements.push(curr.el);
        }
        
        // Save final cluster
        const newKey = `${key}_c${clusterIndex}`;
        clusteredGroups[newKey] = {
            ...group,
            key: newKey,
            elements: [...currentClusterElements]
        };
        currentClusterElements.forEach(e => elementToGroupKey[e.id] = newKey);
    }
    
    // Replace original groups with clustered groups
    const uniqueGroups = Object.values(clusteredGroups);
    console.log(`Identified ${uniqueGroups.length} unique Alignment Clusters (from ${Object.keys(groups).length} infinite lines).`);

    // 3. Load ML Models
    let classifier: RandomForestClassifier | null = null;
    try {
        const modelPaths = [
            path.resolve(process.cwd(), 'dimension_model.json'),
            path.resolve(process.cwd(), 'mcp-server', 'dimension_model.json')
        ];
        const modelPath = modelPaths.find(fs.existsSync);
        
        if (modelPath) {
            const modelState = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));
            classifier = RandomForestClassifier.load(modelState);
            console.log("Loaded ML Model.");
        } else {
            console.error("Model not found!");
            return [];
        }
    } catch (e) {
        console.error("Failed to load model", e);
        return [];
    }

    // v2 candidate scorer (used only in `architect` preset selection; best-effort load)
    type V2CandidateScorer =
        | { type: "single"; model: RandomForestClassifier }
        | { type: "bundle"; models: Record<string, RandomForestClassifier>; thresholds: Record<string, number> };
    let classifierV2: V2CandidateScorer | null = null;
    if (preset === "architect") {
        try {
            const modelPaths = [
                path.resolve(process.cwd(), "dimension_model_v2_architect.json"),
                path.resolve(process.cwd(), "mcp-server", "dimension_model_v2_architect.json"),
                path.resolve(process.cwd(), "mcp-server", "eval", "dimension_model_v2_architect.json"),
                path.resolve(process.cwd(), "..", "mcp-server", "dimension_model_v2_architect.json"),
            ];
            const modelPath = modelPaths.find(fs.existsSync);
            if (modelPath) {
                const modelState = JSON.parse(fs.readFileSync(modelPath, "utf-8"));
                if (modelState?.schema === "dimension_model_v2_bundle_v1") {
                    const models: Record<string, RandomForestClassifier> = {};
                    const thresholds: Record<string, number> = {};
                    const kinds = modelState?.kinds ?? {};
                    for (const [kind, entry] of Object.entries(kinds)) {
                        const rfState = (entry as any)?.model ?? entry;
                        const bestThr = Number((entry as any)?.bestThr);
                        if (Number.isFinite(bestThr)) thresholds[kind] = bestThr;
                        try {
                            models[kind] = RandomForestClassifier.load(rfState as any);
                        } catch {
                            // ignore kind load failure
                        }
                    }
                    classifierV2 = { type: "bundle", models, thresholds };
                    console.log(`Loaded v2 candidate model bundle: ${modelPath}`);
                } else {
                    classifierV2 = { type: "single", model: RandomForestClassifier.load(modelState) };
                    console.log(`Loaded v2 candidate model: ${modelPath}`);
                }
            } else {
                console.log("No v2 candidate model found; selection stays heuristic-only.");
            }
        } catch (e) {
            console.warn("Failed to load v2 candidate model; continuing without it.", e);
            classifierV2 = null;
        }
    }

    const proposals: DimensionProposal[] = [];
    const createdLinks = new Set<string>(); // avoid duplicates

    // Helper to predict
    // (predictLink removed, logic inlined)

    // 4. Constraint Solving Loop
    let changed = true;
    let iterations = 0;
    
    // Phase 1: Grid -> Core (Skeleton)
    // Phase 2: Defined -> Undefined (Fill Gaps)
    // We do this in a single loop that prioritizes connecting undefined stuff.
    
    while (changed && iterations < 5) { // Max passes
        changed = false;
        iterations++;
        const definedCount = uniqueGroups.filter(g => g.isDefined).length;
        console.log(`Pass ${iterations}: Defined Groups: ${definedCount}/${uniqueGroups.length}`);

        const undefinedGroups = uniqueGroups.filter(g => !g.isDefined);
        const definedGroups = uniqueGroups.filter(g => g.isDefined);
        
        if (undefinedGroups.length === 0) break;

        let passCandidates = 0;
        let passPositives = 0;

        for (const uGroup of undefinedGroups) {
             const uAngle = uGroup.key.split('_')[0];
             
             // Find potential neighbors (Defined groups)
             const neighbors = definedGroups.filter(dGroup => {
                 const dAngle = dGroup.key.split('_')[0];
                 return uAngle === dAngle; // Must be parallel
             });

             // Sort by distance (closest first)
             neighbors.sort((a, b) => getDist(uGroup.geom, a.geom) - getDist(uGroup.geom, b.geom));
             
             // Try to link to the closest defined neighbors
             // We check top 3 closest to see if ML likes any of them
             let linked = false;
             for (const dGroup of neighbors.slice(0, 3)) {
                 passCandidates++;
                 
                 const features = [
                    getDist(dGroup.geom, uGroup.geom),
                    dGroup.type==='Grid'?1:0, 
                    uGroup.type==='Grid'?1:0, 
                    ...dGroup.features, 
                    ...uGroup.features
                 ];

                 // @ts-ignore - predictProbability is available in v2 but might not be in types
                 const probs = classifier!.predictProbability([features], 1);
                 const prob = probs[0];

                 // Heuristic Override: If very close to Grid (< 2ft), accept with lower confidence
                 const isCloseToGrid = (dGroup.type === 'Grid' && features[0] < 2.0);
                 const threshold = isCloseToGrid ? 0.05 : 0.1;

                 if (prob > threshold) {
                     passPositives++;
                     const linkKey = [dGroup.key, uGroup.key].sort().join('|');
                     if (!createdLinks.has(linkKey)) {
                         createdLinks.add(linkKey);
                         
                         // Create Proposal
                         const elA = dGroup.elements[0];
                         const elB = uGroup.elements[0];
                         
                         proposals.push({
                             type: "Chain",
                             elements: [elA.id, elB.id],
                             description: `Auto-Dim: ${dGroup.type}(${elA.id}) -> ${uGroup.type}(${elB.id})`
                         });
                         
                         linked = true;
                         // Don't break immediately, maybe we want multiple dims? 
                         // Usually one dim defines it.
                         break; 
                     }
                 }
             }
             
             if (linked) {
                 uGroup.isDefined = true;
                 changed = true;
             }
        }
        console.log(`Pass ${iterations} Stats: Checked ${passCandidates} pairs, Found ${passPositives} positives.`);
        
        // Update the loop state immediately so next iteration of `while` sees new defined groups
        // (Note: `definedGroups` variable is re-evaluated at start of loop)
    }
    
    // Phase 3: Chain Closing (Drafting Standards)
    // The previous loop created a Minimum Spanning Tree (Tree structure).
    // Now we want to "Close the String" by connecting leaf nodes back to a Grid or Reference.
    // Scan for Defined Groups that were targets but not sources (Leafs).
    
    // Map of what links to what: Key -> Set(Keys)
    const forwardLinks: { [key: string]: Set<string> } = {};
    const backwardLinks: { [key: string]: Set<string> } = {};
    
    createdLinks.forEach(link => {
        const [kA, kB] = link.split('|');
        // We don't know directionality from the key string alone, 
        // but typically we linked Defined (Source) -> Undefined (Target).
        // Let's reconstruct flow based on the proposals.
    });
    
    // Easier way: Iterate uniqueGroups. If a group is Defined, check if it has a "forward" neighbor.
    // If not, try to link it to a Grid.
    
    let closingLinks = 0;
    const definedGroups = uniqueGroups.filter(g => g.isDefined);
    
    for (const group of definedGroups) {
        if (group.type === 'Grid') continue; // Grids don't need to close to things
        
        // Check if this group has already been linked to something *further* in the chain.
        // This is hard to know without a graph. 
        // Heuristic: Look for a Grid in the "direction" of the wall normal? 
        // Simpler Heuristic: Look for the NEAREST Grid that isn't already linked to this group.
        
        const angle = group.key.split('_')[0];
        const neighbors = definedGroups.filter(g => {
            const gAngle = g.key.split('_')[0];
            return gAngle === angle && g.type === 'Grid'; // Only close to Grids for now
        });
        
        // Sort by distance
        neighbors.sort((a, b) => getDist(group.geom, a.geom) - getDist(group.geom, b.geom));
        
        for (const neighbor of neighbors) {
             const dist = getDist(group.geom, neighbor.geom);
             if (dist < 0.5) continue; // Too close (touching)
             if (dist > 30.0) continue; // Don't close to a grid 30ft away if there's nothing in between
             
             const linkKey = [group.key, neighbor.key].sort().join('|');
             if (!createdLinks.has(linkKey)) {
                 // Check ML probability for this closing link
                 const features = [
                    dist,
                    0, // group is definitely not a Grid (we filtered above)
                    1, // neighbor is definitely a Grid (we filtered above)
                    ...group.features, 
                    ...neighbor.features
                 ];

                 // @ts-ignore
                 const probs = classifier!.predictProbability([features], 1);
                 
                 // Lower threshold for closing links because they are "nice to have" not "critical location"
                 if (probs[0] > 0.1) {
                     createdLinks.add(linkKey);
                     proposals.push({
                         type: "Chain",
                         elements: [group.elements[0].id, neighbor.elements[0].id],
                         description: `Closing Chain: ${group.type} -> ${neighbor.type}`
                     });
                     closingLinks++;
                     break; // Only need one closer
                 }
             }
        }
    }
    
    console.log(`Generated ${proposals.length} raw links (added ${closingLinks} closing links) after ${iterations} passes.`);

    // 5. Chain Merging
    // Group links that share the same dimension line (orientation + offset)
    const mergedProposals: DimensionProposal[] = [];
    const orientationGroups: { [angle: string]: { idA: number, idB: number, keyA: string, keyB: string }[] } = {};

    proposals.forEach(p => {
        // Find keys using the map
        const keyA = elementToGroupKey[p.elements[0]];
        const keyB = elementToGroupKey[p.elements[1]];
        
        if (!keyA || !keyB) return;

        // Angle is the first part of the key "0_10.0_c0" -> "0"
        const angle = keyA.split('_')[0];
        
        if (!orientationGroups[angle]) orientationGroups[angle] = [];
        orientationGroups[angle].push({ idA: p.elements[0], idB: p.elements[1], keyA, keyB });
    });

    for (const angle in orientationGroups) {
        const links = orientationGroups[angle];
        const adj: { [id: string]: Set<string> } = {};
        const keys = new Set<string>();
        
        links.forEach(l => {
            if (!adj[l.keyA]) adj[l.keyA] = new Set();
            if (!adj[l.keyB]) adj[l.keyB] = new Set();
            adj[l.keyA].add(l.keyB);
            adj[l.keyB].add(l.keyA);
            keys.add(l.keyA);
            keys.add(l.keyB);
        });

        const visited = new Set<string>();
        for (const key of keys) {
            if (visited.has(key)) continue;
            
            const component: string[] = [];
            const queue = [key];
            visited.add(key);
            
            while (queue.length > 0) {
                const curr = queue.shift()!;
                component.push(curr);
                adj[curr]?.forEach(neighbor => {
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        queue.push(neighbor);
                    }
                });
            }

            if (component.length > 1) {
                // Split Component Logic
                const wallKeys = component.filter(k => clusteredGroups[k].type === 'Wall');
                const gridKeys = component.filter(k => clusteredGroups[k].type === 'Grid');
                
                if (wallKeys.length === 0) {
                     // Grid-only chain (e.g. overall dims)
                     const elements = component.flatMap(ckey => clusteredGroups[ckey].elements.map(e => e.id));
                     const uniqueElements = [...new Set(elements)];
                     mergedProposals.push({
                        type: "Chain",
                        elements: uniqueElements,
                        description: `Merged Chain (${angle}°): ${uniqueElements.length} segments (Grids Only)`,
                        meta: { kind: "ml-merged" }
                    });
                    continue;
                }
                
                // Cluster Walls by Parallel Position
                // If angle=0 (Horizontal Elements), we cluster by X.
                // If angle=90 (Vertical Elements), we cluster by Y.
                const isVertical = (angle === "90" || angle === "270"); // Elements are Vertical
                // Note: If Elements are Vertical (90), Dimension is Horizontal? No.
                // Standard: Vertical Line (90) -> Dimension measures X. Dimension Line is Horizontal.
                // Elements run along Y. Parallel Axis is Y.
                
                const getPos = (k: string) => {
                    const g = clusteredGroups[k].geom;
                    const c = { x: (g.p1.x + g.p2.x)/2, y: (g.p1.y + g.p2.y)/2 };
                    return isVertical ? c.y : c.x;
                };
                
                wallKeys.sort((a, b) => getPos(a) - getPos(b));
                
                // Group WallKeys
                const wallClusters: string[][] = [];
                let currentCluster: string[] = [wallKeys[0]];
                
                for (let i = 1; i < wallKeys.length; i++) {
                    const prev = wallKeys[i-1];
                    const curr = wallKeys[i];
                    if (Math.abs(getPos(curr) - getPos(prev)) > 20.0) { // 20ft gap
                         wallClusters.push(currentCluster);
                         currentCluster = [];
                    }
                    currentCluster.push(curr);
                }
                wallClusters.push(currentCluster);
                
                // Emit Proposals
                for (const wCluster of wallClusters) {
                    const clusterElements = new Set<string>(wCluster);
                    const relevantGrids = new Set<string>();
                    
                    // Find Grids connected to THIS cluster's walls
                    // BFS from wCluster nodes, stopping at Grids
                    // Actually, we just check direct neighbors in `adj` that are Grids?
                    // Or recursive? The graph structure is usually Wall-Grid-Wall.
                    // If we have WallA-Grid1-Grid2-WallB. 
                    // And WallA is in Cluster1. WallB is in Cluster2.
                    // Grid1 should be in Cluster1. Grid2?
                    // Simple approach: Include ALL Grids reachable from wCluster without passing through other Walls?
                    // Heuristic: Include direct Grid neighbors of the walls in this cluster.
                    
                    wCluster.forEach(wk => {
                        adj[wk]?.forEach(neighbor => {
                            if (clusteredGroups[neighbor].type === 'Grid') {
                                relevantGrids.add(neighbor);
                            }
                        });
                    });
                    
                    const finalKeys = [...clusterElements, ...relevantGrids];
                    const elements = finalKeys.flatMap(ckey => clusteredGroups[ckey].elements.map(e => e.id));
                    const uniqueElements = [...new Set(elements)];
                    
                    mergedProposals.push({
                        type: "Chain",
                        elements: uniqueElements,
                        description: `Merged Chain (${angle}°): ${uniqueElements.length} segments (Cluster at ${Math.round(getPos(wCluster[0]))})`,
                        meta: { kind: "ml-merged" }
                    });
                }
            }
        }
    }

    // 6. Dense "Slice" Proposals (Heuristic Recall Booster)
    // Create additional dimension strings by sampling across the plan and
    // dimensioning intersecting walls. This increases recall even when ML
    // linking is conservative.
    const denseSliceProposals: DimensionProposal[] = [];

    const quant = (v: number, step: number) => Math.round(v / step) * step;
    const proposalSignature = (p: DimensionProposal) => {
        const ids = (p.elements || []).slice().sort((a, b) => a - b).join(",");
        if (!p.line) return ids;
        const q = 0.5; // ft
        const p1 = p.line.p1;
        const p2 = p.line.p2;
        return `${ids}|L:${quant(p1.x, q)},${quant(p1.y, q)}-${quant(p2.x, q)},${quant(p2.y, q)}`;
    };

    const lineLen = (l: Line) => {
        const dx = l.p2.x - l.p1.x;
        const dy = l.p2.y - l.p1.y;
        return Math.sqrt(dx * dx + dy * dy);
    };

    const lineAngleDeg = (l: Line) => {
        const dx = l.p2.x - l.p1.x;
        const dy = l.p2.y - l.p1.y;
        let a = Math.atan2(dy, dx) * (180 / Math.PI);
        if (a < 0) a += 180;
        if (a >= 180) a -= 180;
        return a;
    };

    const ANGLE_TOL = 10; // degrees
    const MIN_WALL_LEN = 2.0; // ft
    // NOTE: Dense-slice is a recall booster, but too many global slices can create "striping".
    // These settings aim for moderate, stable coverage.
    const SLICE_TARGET = preset === "architect" ? 8 : 22;
    const MIN_SLICE_SEP = preset === "architect" ? 28.0 : 12.0; // ft
    const CLUSTER_GAP = preset === "architect" ? 30.0 : 25.0; // ft
    const THIN_GAP = 0.75; // ft
    const DISPLAY_OFFSETS = [0.0]; // ft (keep 0 to avoid invalid refs on short walls)
    const END_EXTEND = 4.0; // ft
    const MAX_REFS = preset === "architect" ? 8 : 10;
    const MAX_DENSE_PROPOSALS = preset === "architect" ? 40 : 120;
    const MAX_SPAN = preset === "architect" ? 45.0 : 60.0; // ft (split long clusters into local chunks)
    const CHUNK_OVERLAP = 2; // refs

    const isHorizontalish = (a: number) => Math.min(a, 180 - a) <= ANGLE_TOL;
    const isVerticalish = (a: number) => Math.abs(a - 90) <= ANGLE_TOL;

    const verticalWalls = validWalls.filter(w => {
        if (!w.geometry) return false;
        const a = lineAngleDeg(w.geometry);
        return isVerticalish(a) && lineLen(w.geometry) >= MIN_WALL_LEN;
    });

    const horizontalWalls = validWalls.filter(w => {
        if (!w.geometry) return false;
        const a = lineAngleDeg(w.geometry);
        return isHorizontalish(a) && lineLen(w.geometry) >= MIN_WALL_LEN;
    });

    const quantileSamples = (vals: number[], targetCount: number, minSep: number) => {
        const sorted = vals.slice().sort((a, b) => a - b);
        const n = sorted.length;
        if (n === 0) return [] as number[];
        const out: number[] = [];
        for (let i = 0; i < targetCount; i++) {
            const idx = Math.floor(((i + 0.5) / targetCount) * (n - 1));
            const v = sorted[idx];
            if (out.length === 0 || Math.abs(v - out[out.length - 1]) >= minSep) out.push(v);
        }
        return out;
    };

    const uniformSamples = (minV: number, maxV: number, targetCount: number, minSep: number) => {
        if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return [] as number[];
        if (maxV <= minV) return [] as number[];
        const span = maxV - minV;
        const step = span / Math.max(1, targetCount - 1);
        const out: number[] = [];
        for (let i = 0; i < targetCount; i++) {
            const v = minV + i * step;
            if (out.length === 0 || Math.abs(v - out[out.length - 1]) >= minSep) out.push(v);
        }
        return out;
    };

    const capRefs = (items: { id: number, pos: number }[]) => {
        if (items.length <= MAX_REFS) return items;
        const keep: { id: number, pos: number }[] = [];
        keep.push(items[0]);
        keep.push(items[items.length - 1]);
        const remaining = MAX_REFS - 2;
        for (let i = 0; i < remaining; i++) {
            const t = (i + 1) / (remaining + 1);
            const idx = Math.round(t * (items.length - 1));
            keep.push(items[idx]);
        }
        keep.sort((a, b) => a.pos - b.pos);
        const seen = new Set<number>();
        return keep.filter(k => (seen.has(k.id) ? false : (seen.add(k.id), true)));
    };

    const addDenseProposal = (p: DimensionProposal) => {
        if (denseSliceProposals.length >= MAX_DENSE_PROPOSALS) return;
        if (!p.elements || p.elements.length < 2) return;
        denseSliceProposals.push(p);
    };

    if (!includeDenseSlices) {
        console.log("Skipping dense slice proposals (includeDenseSlices=false).");
    } else {
        // Horizontal dimension strings (sample Y; dimension vertical-ish walls across X)
        const yCenters = verticalWalls.map(w => (w.geometry!.p1.y + w.geometry!.p2.y) / 2);
        const ySlices = [
            ...quantileSamples(yCenters, SLICE_TARGET, MIN_SLICE_SEP),
            ...uniformSamples(minY, maxY, SLICE_TARGET, MIN_SLICE_SEP),
        ].sort((a, b) => a - b).filter((v, idx, arr) => idx === 0 || Math.abs(v - arr[idx - 1]) >= MIN_SLICE_SEP);

        ySlices.forEach((y0, sliceIdx) => {
            if (denseSliceProposals.length >= MAX_DENSE_PROPOSALS) return;
            const hits: { id: number, pos: number, len: number }[] = [];
            for (const w of verticalWalls) {
                const g = w.geometry!;
                const y1 = g.p1.y, y2 = g.p2.y;
                const minYw = Math.min(y1, y2), maxYw = Math.max(y1, y2);
                if (y0 < minYw - 1e-6 || y0 > maxYw + 1e-6) continue;
                const dy = y2 - y1;
                if (Math.abs(dy) < 1e-9) continue;
                const t = (y0 - y1) / dy;
                if (t < -1e-6 || t > 1 + 1e-6) continue;
                const x = g.p1.x + t * (g.p2.x - g.p1.x);
                hits.push({ id: w.id, pos: x, len: lineLen(g) });
            }
            hits.sort((a, b) => a.pos - b.pos);

            const thinned: { id: number, pos: number, len: number }[] = [];
            for (const h of hits) {
                const last = thinned[thinned.length - 1];
                if (!last || Math.abs(h.pos - last.pos) >= THIN_GAP) {
                    thinned.push(h);
                } else if (h.len > last.len) {
                    thinned[thinned.length - 1] = h;
                }
            }

            let cluster: { id: number, pos: number, len: number }[] = [];
            const flush = () => {
                if (cluster.length < 2) { cluster = []; return; }
                const refs = cluster.map(c => ({ id: c.id, pos: c.pos }));
                const emit = (segment: { id: number, pos: number }[], segIdx: number) => {
                    const capped = capRefs(segment);
                    if (capped.length < 2) return;
                    const yLine = y0 + DISPLAY_OFFSETS[(sliceIdx + segIdx) % DISPLAY_OFFSETS.length];
                    const x1 = capped[0].pos - END_EXTEND;
                    const x2 = capped[capped.length - 1].pos + END_EXTEND;
                    addDenseProposal({
                        type: "Chain",
                        elements: capped.map(c => c.id),
                        description: `DenseSlice(H): y=${Math.round(y0)} refs=${capped.length}`,
                        line: { p1: { x: x1, y: yLine, z: 0 }, p2: { x: x2, y: yLine, z: 0 } },
                        meta: { kind: "dense-slice", orientation: "H" }
                    });
                };

                const span = refs[refs.length - 1].pos - refs[0].pos;
                if (span <= MAX_SPAN) {
                    emit(refs, 0);
                    cluster = [];
                    return;
                }

                let segIdx = 0;
                let start = 0;
                while (start < refs.length - 1 && denseSliceProposals.length < MAX_DENSE_PROPOSALS) {
                    let end = start + 1;
                    while (end < refs.length && (refs[end].pos - refs[start].pos) <= MAX_SPAN) end++;
                    end = Math.max(start + 1, end - 1);
                    emit(refs.slice(start, end + 1), segIdx++);
                    if (end >= refs.length - 1) break;
                    start = Math.max(0, end - CHUNK_OVERLAP);
                    if (start === end) start++;
                }
                cluster = [];
            };

            for (const h of thinned) {
                const last = cluster[cluster.length - 1];
                if (last && (h.pos - last.pos) > CLUSTER_GAP) flush();
                cluster.push(h);
            }
            flush();
        });

        // Vertical dimension strings (sample X; dimension horizontal-ish walls across Y)
        const xCenters = horizontalWalls.map(w => (w.geometry!.p1.x + w.geometry!.p2.x) / 2);
        const xSlices = [
            ...quantileSamples(xCenters, SLICE_TARGET, MIN_SLICE_SEP),
            ...uniformSamples(minX, maxX, SLICE_TARGET, MIN_SLICE_SEP),
        ].sort((a, b) => a - b).filter((v, idx, arr) => idx === 0 || Math.abs(v - arr[idx - 1]) >= MIN_SLICE_SEP);

        xSlices.forEach((x0, sliceIdx) => {
            if (denseSliceProposals.length >= MAX_DENSE_PROPOSALS) return;
            const hits: { id: number, pos: number, len: number }[] = [];
            for (const w of horizontalWalls) {
                const g = w.geometry!;
                const x1 = g.p1.x, x2 = g.p2.x;
                const minXw = Math.min(x1, x2), maxXw = Math.max(x1, x2);
                if (x0 < minXw - 1e-6 || x0 > maxXw + 1e-6) continue;
                const dx = x2 - x1;
                if (Math.abs(dx) < 1e-9) continue;
                const t = (x0 - x1) / dx;
                if (t < -1e-6 || t > 1 + 1e-6) continue;
                const y = g.p1.y + t * (g.p2.y - g.p1.y);
                hits.push({ id: w.id, pos: y, len: lineLen(g) });
            }
            hits.sort((a, b) => a.pos - b.pos);

            const thinned: { id: number, pos: number, len: number }[] = [];
            for (const h of hits) {
                const last = thinned[thinned.length - 1];
                if (!last || Math.abs(h.pos - last.pos) >= THIN_GAP) {
                    thinned.push(h);
                } else if (h.len > last.len) {
                    thinned[thinned.length - 1] = h;
                }
            }

            let cluster: { id: number, pos: number, len: number }[] = [];
            const flush = () => {
                if (cluster.length < 2) { cluster = []; return; }
                const refs = cluster.map(c => ({ id: c.id, pos: c.pos }));
                const emit = (segment: { id: number, pos: number }[], segIdx: number) => {
                    const capped = capRefs(segment);
                    if (capped.length < 2) return;
                    const xLine = x0 + DISPLAY_OFFSETS[(sliceIdx + segIdx) % DISPLAY_OFFSETS.length];
                    const y1 = capped[0].pos - END_EXTEND;
                    const y2 = capped[capped.length - 1].pos + END_EXTEND;
                    addDenseProposal({
                        type: "Chain",
                        elements: capped.map(c => c.id),
                        description: `DenseSlice(V): x=${Math.round(x0)} refs=${capped.length}`,
                        line: { p1: { x: xLine, y: y1, z: 0 }, p2: { x: xLine, y: y2, z: 0 } },
                        meta: { kind: "dense-slice", orientation: "V" }
                    });
                };

                const span = refs[refs.length - 1].pos - refs[0].pos;
                if (span <= MAX_SPAN) {
                    emit(refs, 0);
                    cluster = [];
                    return;
                }

                let segIdx = 0;
                let start = 0;
                while (start < refs.length - 1 && denseSliceProposals.length < MAX_DENSE_PROPOSALS) {
                    let end = start + 1;
                    while (end < refs.length && (refs[end].pos - refs[start].pos) <= MAX_SPAN) end++;
                    end = Math.max(start + 1, end - 1);
                    emit(refs.slice(start, end + 1), segIdx++);
                    if (end >= refs.length - 1) break;
                    start = Math.max(0, end - CHUNK_OVERLAP);
                    if (start === end) start++;
                }
                cluster = [];
            };

            for (const h of thinned) {
                const last = cluster[cluster.length - 1];
                if (last && (h.pos - last.pos) > CLUSTER_GAP) flush();
                cluster.push(h);
            }
            flush();
        });

        if (denseSliceProposals.length > 0) {
            const existing = new Set(mergedProposals.map(p => proposalSignature(p)));
            const filtered = denseSliceProposals.filter(p => {
                const sig = proposalSignature(p);
                if (existing.has(sig)) return false;
                existing.add(sig);
                return true;
            });
            mergedProposals.push(...filtered);
            console.log(`Added ${filtered.length} dense slice proposals.`);
        }
    }

    // 6b. Tile-Local Slice Proposals (area-by-area coverage)
    // One short H + one short V per 50ft tile where possible.
    if (!includeTileSlices) {
        console.log("Skipping tile slice proposals (includeTileSlices=false).");
    } else {
        const tileSliceProposals: DimensionProposal[] = [];
        const TILE_SLICE = 50.0; // ft
        const TILE_SLICE_SMALL = 25.0; // ft (micro-tiles to catch local partitions)
        const TILE_MARGIN = 4.0; // ft
        // Allow more local slices; downstream selection caps per stripe/tile to avoid clutter.
        const MAX_TILE_SLICES = 260;

    const nx = Math.max(1, Math.ceil((maxX - minX) / TILE_SLICE));
    const ny = Math.max(1, Math.ceil((maxY - minY) / TILE_SLICE));

    const HIT_END_MARGIN = 0.75; // ft (avoid wall endpoints -> fewer "Invalid number of references")

    const hitsVerticalAtY = (y0: number, xMin: number, xMax: number) => {
        const hits: { id: number, pos: number, len: number }[] = [];
        for (const w of verticalWalls) {
            const g = w.geometry!;
            const y1 = g.p1.y, y2 = g.p2.y;
            const minYw = Math.min(y1, y2), maxYw = Math.max(y1, y2);
            const spanY = maxYw - minYw;
            const margin = Math.min(HIT_END_MARGIN, Math.max(0.1, spanY * 0.2));
            if (y0 < (minYw + margin) || y0 > (maxYw - margin)) continue;
            const dy = y2 - y1;
            if (Math.abs(dy) < 1e-9) continue;
            const t = (y0 - y1) / dy;
            if (t < -1e-6 || t > 1 + 1e-6) continue;
            const x = g.p1.x + t * (g.p2.x - g.p1.x);
            if (x < xMin - TILE_MARGIN || x > xMax + TILE_MARGIN) continue;
            hits.push({ id: w.id, pos: x, len: lineLen(g) });
        }
        hits.sort((a, b) => a.pos - b.pos);
        return hits;
    };

    const hitsHorizontalAtX = (x0: number, yMin: number, yMax: number) => {
        const hits: { id: number, pos: number, len: number }[] = [];
        for (const w of horizontalWalls) {
            const g = w.geometry!;
            const x1 = g.p1.x, x2 = g.p2.x;
            const minXw = Math.min(x1, x2), maxXw = Math.max(x1, x2);
            const spanX = maxXw - minXw;
            const margin = Math.min(HIT_END_MARGIN, Math.max(0.1, spanX * 0.2));
            if (x0 < (minXw + margin) || x0 > (maxXw - margin)) continue;
            const dx = x2 - x1;
            if (Math.abs(dx) < 1e-9) continue;
            const t = (x0 - x1) / dx;
            if (t < -1e-6 || t > 1 + 1e-6) continue;
            const y = g.p1.y + t * (g.p2.y - g.p1.y);
            if (y < yMin - TILE_MARGIN || y > yMax + TILE_MARGIN) continue;
            hits.push({ id: w.id, pos: y, len: lineLen(g) });
        }
        hits.sort((a, b) => a.pos - b.pos);
        return hits;
    };

    const tileSamples = [0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85];

    for (let iy = 0; iy < ny && tileSliceProposals.length < MAX_TILE_SLICES; iy++) {
        for (let ix = 0; ix < nx && tileSliceProposals.length < MAX_TILE_SLICES; ix++) {
            const xA = minX + ix * TILE_SLICE;
            const xB = xA + TILE_SLICE;
            const yA = minY + iy * TILE_SLICE;
            const yB = yA + TILE_SLICE;

            const ySamples = tileSamples.map(f => yA + (yB - yA) * f);
            const xSamples = tileSamples.map(f => xA + (xB - xA) * f);

            const sigIds = (refs: { id: number }[]) => refs.map(r => r.id).slice().sort((a, b) => a - b).join(",");

            // H tile slice: try multiple y samples; keep up to 2 best distinct candidates
            const hCands: { y0: number; refs: { id: number; pos: number }[]; span: number; sig: string }[] = [];
            for (const y0 of ySamples) {
                const hv = hitsVerticalAtY(y0, xA, xB);
                const hvThin: { id: number, pos: number, len: number }[] = [];
                for (const h of hv) {
                    const last = hvThin[hvThin.length - 1];
                    if (!last || Math.abs(h.pos - last.pos) >= THIN_GAP) hvThin.push(h);
                    else if (h.len > last.len) hvThin[hvThin.length - 1] = h;
                }
                const hvRefs = capRefs(hvThin.map(h => ({ id: h.id, pos: h.pos })));
                if (hvRefs.length < 2) continue;
                const span = hvRefs[hvRefs.length - 1].pos - hvRefs[0].pos;
                hCands.push({ y0, refs: hvRefs, span, sig: sigIds(hvRefs) });
            }
            hCands.sort((a, b) => (b.span - a.span) || (a.refs.length - b.refs.length));
            const usedHSigs = new Set<string>();
            for (const cand of hCands) {
                if (usedHSigs.has(cand.sig)) continue;
                usedHSigs.add(cand.sig);
                const x1 = cand.refs[0].pos - END_EXTEND;
                const x2 = cand.refs[cand.refs.length - 1].pos + END_EXTEND;
                tileSliceProposals.push({
                    type: "Chain",
                    elements: cand.refs.map(r => r.id),
                    description: `TileSlice(H): tile=${ix},${iy} y=${Math.round(cand.y0)} refs=${cand.refs.length}`,
                    line: { p1: { x: x1, y: cand.y0, z: 0 }, p2: { x: x2, y: cand.y0, z: 0 } },
                    meta: { kind: "tile-slice", orientation: "H" }
                });
                if (tileSliceProposals.length >= MAX_TILE_SLICES) break;
                if (usedHSigs.size >= 3) break;
            }

            if (tileSliceProposals.length >= MAX_TILE_SLICES) break;

            // V tile slice: try multiple x samples; keep up to 2 best distinct candidates
            const vCands: { x0: number; refs: { id: number; pos: number }[]; span: number; sig: string }[] = [];
            for (const x0 of xSamples) {
                const hh = hitsHorizontalAtX(x0, yA, yB);
                const hhThin: { id: number, pos: number, len: number }[] = [];
                for (const h of hh) {
                    const last = hhThin[hhThin.length - 1];
                    if (!last || Math.abs(h.pos - last.pos) >= THIN_GAP) hhThin.push(h);
                    else if (h.len > last.len) hhThin[hhThin.length - 1] = h;
                }
                const hhRefs = capRefs(hhThin.map(h => ({ id: h.id, pos: h.pos })));
                if (hhRefs.length < 2) continue;
                const span = hhRefs[hhRefs.length - 1].pos - hhRefs[0].pos;
                vCands.push({ x0, refs: hhRefs, span, sig: sigIds(hhRefs) });
            }
            vCands.sort((a, b) => (b.span - a.span) || (a.refs.length - b.refs.length));
            const usedVSigs = new Set<string>();
            for (const cand of vCands) {
                if (usedVSigs.has(cand.sig)) continue;
                usedVSigs.add(cand.sig);
                const y1 = cand.refs[0].pos - END_EXTEND;
                const y2 = cand.refs[cand.refs.length - 1].pos + END_EXTEND;
                tileSliceProposals.push({
                    type: "Chain",
                    elements: cand.refs.map(r => r.id),
                    description: `TileSlice(V): tile=${ix},${iy} x=${Math.round(cand.x0)} refs=${cand.refs.length}`,
                    line: { p1: { x: cand.x0, y: y1, z: 0 }, p2: { x: cand.x0, y: y2, z: 0 } },
                    meta: { kind: "tile-slice", orientation: "V" }
                });
                if (tileSliceProposals.length >= MAX_TILE_SLICES) break;
                if (usedVSigs.size >= 3) break;
            }
        }
    }

    // Micro-tile pass: smaller windows often pick up short partition runs that a 50ft tile misses.
    // Keep this conservative: 1H + 1V per micro tile max.
    {
        const nxS = Math.max(1, Math.ceil((maxX - minX) / TILE_SLICE_SMALL));
        const nyS = Math.max(1, Math.ceil((maxY - minY) / TILE_SLICE_SMALL));
        const microSamples = [0.2, 0.5, 0.8];
        let addedMicro = 0;
        const MAX_MICRO_ADD = 120;

        for (let iy = 0; iy < nyS && tileSliceProposals.length < MAX_TILE_SLICES && addedMicro < MAX_MICRO_ADD; iy++) {
            for (let ix = 0; ix < nxS && tileSliceProposals.length < MAX_TILE_SLICES && addedMicro < MAX_MICRO_ADD; ix++) {
                const xA = minX + ix * TILE_SLICE_SMALL;
                const xB = xA + TILE_SLICE_SMALL;
                const yA = minY + iy * TILE_SLICE_SMALL;
                const yB = yA + TILE_SLICE_SMALL;

                const ySamples = microSamples.map(f => yA + (yB - yA) * f);
                const xSamples = microSamples.map(f => xA + (xB - xA) * f);

                const sigIds = (refs: { id: number }[]) => refs.map(r => r.id).slice().sort((a, b) => a - b).join(",");

                // H micro tile slice
                {
                    const hCands: { y0: number; refs: { id: number; pos: number }[]; span: number; sig: string }[] = [];
                    for (const y0 of ySamples) {
                        const hv = hitsVerticalAtY(y0, xA, xB);
                        const hvThin: { id: number, pos: number, len: number }[] = [];
                        for (const h of hv) {
                            const last = hvThin[hvThin.length - 1];
                            if (!last || Math.abs(h.pos - last.pos) >= THIN_GAP) hvThin.push(h);
                            else if (h.len > last.len) hvThin[hvThin.length - 1] = h;
                        }
                        const hvRefs = capRefs(hvThin.map(h => ({ id: h.id, pos: h.pos })));
                        if (hvRefs.length < 2) continue;
                        const span = hvRefs[hvRefs.length - 1].pos - hvRefs[0].pos;
                        hCands.push({ y0, refs: hvRefs, span, sig: sigIds(hvRefs) });
                    }
                    hCands.sort((a, b) => (b.span - a.span) || (a.refs.length - b.refs.length));
                    const cand = hCands[0];
                    if (cand) {
                        const x1 = cand.refs[0].pos - END_EXTEND;
                        const x2 = cand.refs[cand.refs.length - 1].pos + END_EXTEND;
                        tileSliceProposals.push({
                            type: "Chain",
                            elements: cand.refs.map(r => r.id),
                            description: `MicroTileSlice(H): tile=${ix},${iy} y=${Math.round(cand.y0)} refs=${cand.refs.length}`,
                            line: { p1: { x: x1, y: cand.y0, z: 0 }, p2: { x: x2, y: cand.y0, z: 0 } },
                            meta: { kind: "tile-slice", orientation: "H" }
                        });
                        addedMicro++;
                    }
                }

                if (tileSliceProposals.length >= MAX_TILE_SLICES || addedMicro >= MAX_MICRO_ADD) break;

                // V micro tile slice
                {
                    const vCands: { x0: number; refs: { id: number; pos: number }[]; span: number; sig: string }[] = [];
                    for (const x0 of xSamples) {
                        const hh = hitsHorizontalAtX(x0, yA, yB);
                        const hhThin: { id: number, pos: number, len: number }[] = [];
                        for (const h of hh) {
                            const last = hhThin[hhThin.length - 1];
                            if (!last || Math.abs(h.pos - last.pos) >= THIN_GAP) hhThin.push(h);
                            else if (h.len > last.len) hhThin[hhThin.length - 1] = h;
                        }
                        const hhRefs = capRefs(hhThin.map(h => ({ id: h.id, pos: h.pos })));
                        if (hhRefs.length < 2) continue;
                        const span = hhRefs[hhRefs.length - 1].pos - hhRefs[0].pos;
                        vCands.push({ x0, refs: hhRefs, span, sig: sigIds(hhRefs) });
                    }
                    vCands.sort((a, b) => (b.span - a.span) || (a.refs.length - b.refs.length));
                    const cand = vCands[0];
                    if (cand) {
                        const y1 = cand.refs[0].pos - END_EXTEND;
                        const y2 = cand.refs[cand.refs.length - 1].pos + END_EXTEND;
                        tileSliceProposals.push({
                            type: "Chain",
                            elements: cand.refs.map(r => r.id),
                            description: `MicroTileSlice(V): tile=${ix},${iy} x=${Math.round(cand.x0)} refs=${cand.refs.length}`,
                            line: { p1: { x: cand.x0, y: y1, z: 0 }, p2: { x: cand.x0, y: y2, z: 0 } },
                            meta: { kind: "tile-slice", orientation: "V" }
                        });
                        addedMicro++;
                    }
                }
            }
        }
    }

        if (tileSliceProposals.length > 0) {
            const existing = new Set(mergedProposals.map(p => proposalSignature(p)));
            const filtered = tileSliceProposals.filter(p => {
                const sig = proposalSignature(p);
                if (existing.has(sig)) return false;
                existing.add(sig);
                return true;
            });
            mergedProposals.push(...filtered);
            console.log(`Added ${filtered.length} tile slice proposals.`);
        }
    }

    // 7. Adjacent-Wall Spacing Proposals (room/corridor widths)
    // Create short, local dimensions between adjacent parallel wall runs where they overlap.
    const adjacentProposals: DimensionProposal[] = [];
    const MAX_ADJ_PROPOSALS = 400;
    const POS_TOL = 0.75; // ft
    const MIN_OVERLAP = 4.0; // ft
    const MAX_INTERVALS_PER_PAIR = 8;
    const MAX_CLUSTER_NEIGHBORS = 3; // allow skipping one cluster when needed
    const MAX_CLUSTER_GAP = 28.0; // ft (avoid overly-global spacing dims)
    const ADJ_END_MARGIN = 1.0; // ft (avoid picking walls right at endpoints -> fewer invalid refs)

    type Interval = { a: number, b: number };

    const mergeIntervals = (intervals: Interval[]) => {
        const ints = intervals
            .map(i => ({ a: Math.min(i.a, i.b), b: Math.max(i.a, i.b) }))
            .filter(i => Number.isFinite(i.a) && Number.isFinite(i.b))
            .sort((x, y) => x.a - y.a);

        const out: Interval[] = [];
        for (const i of ints) {
            const last = out[out.length - 1];
            if (!last || i.a > last.b) out.push({ ...i });
            else last.b = Math.max(last.b, i.b);
        }
        return out;
    };

    const intersectIntervals = (a: Interval[], b: Interval[]) => {
        const out: Interval[] = [];
        let i = 0, j = 0;
        while (i < a.length && j < b.length) {
            const s = Math.max(a[i].a, b[j].a);
            const e = Math.min(a[i].b, b[j].b);
            if (e > s) out.push({ a: s, b: e });
            if (a[i].b < b[j].b) i++;
            else j++;
        }
        return out;
    };

    const addAdjProposal = (p: DimensionProposal) => {
        if (adjacentProposals.length >= MAX_ADJ_PROPOSALS) return;
        if (!p.elements || p.elements.length < 2) return;
        adjacentProposals.push(p);
    };

    const clusterWallsByPos = (
        walls: Element[],
        getPos: (w: Element) => number,
        getRange: (w: Element) => Interval
    ) => {
        const entries = walls
            .filter(w => w.geometry)
            .map(w => ({ w, pos: getPos(w), range: getRange(w) }))
            .filter(e => Number.isFinite(e.pos));

        entries.sort((a, b) => a.pos - b.pos);
        const clusters: { pos: number, walls: Element[], ranges: Interval[], intervals: Interval[] }[] = [];

        for (const e of entries) {
            const last = clusters[clusters.length - 1];
            if (!last || Math.abs(e.pos - last.pos) > POS_TOL) {
                clusters.push({ pos: e.pos, walls: [e.w], ranges: [e.range], intervals: [] });
            } else {
                // running average to stabilize the cluster position
                const n = last.walls.length;
                last.pos = (last.pos * n + e.pos) / (n + 1);
                last.walls.push(e.w);
                last.ranges.push(e.range);
            }
        }

        clusters.forEach(c => (c.intervals = mergeIntervals(c.ranges)));
        return clusters;
    };

    const pickWallAt = (cluster: { walls: Element[] }, axis: "x" | "y", t: number) => {
        let best: Element | null = null;
        let bestLen = -Infinity;
        for (const w of cluster.walls) {
            const g = w.geometry!;
            const a = axis === "x" ? Math.min(g.p1.x, g.p2.x) : Math.min(g.p1.y, g.p2.y);
            const b = axis === "x" ? Math.max(g.p1.x, g.p2.x) : Math.max(g.p1.y, g.p2.y);
            const span = b - a;
            const m = Math.min(ADJ_END_MARGIN, Math.max(0.1, span * 0.2));
            if (t < (a + m) - 1e-6 || t > (b - m) + 1e-6) continue;
            const len = lineLen(g);
            if (len > bestLen) {
                bestLen = len;
                best = w;
            }
        }
        if (best) return best;

        // fallback: closest midpoint to t
        let bestD = Infinity;
        for (const w of cluster.walls) {
            const g = w.geometry!;
            const mid = axis === "x"
                ? (g.p1.x + g.p2.x) / 2
                : (g.p1.y + g.p2.y) / 2;
            const d = Math.abs(mid - t);
            if (d < bestD) {
                bestD = d;
                best = w;
            }
        }
        return best ?? cluster.walls[0];
    };

    // Vertical-ish walls -> measure X spacing with horizontal dimension lines
    const vClusters = clusterWallsByPos(
        verticalWalls,
        w => (w.geometry!.p1.x + w.geometry!.p2.x) / 2,
        w => ({ a: w.geometry!.p1.y, b: w.geometry!.p2.y })
    );
    vClusters.sort((a, b) => a.pos - b.pos);

    let adjIdx = 0;
    for (let i = 0; i < vClusters.length - 1 && adjacentProposals.length < MAX_ADJ_PROPOSALS; i++) {
        const c1 = vClusters[i];

        const pairOptions: { j: number; inter: Interval[]; score: number }[] = [];
        for (let dj = 1; dj <= MAX_CLUSTER_NEIGHBORS && (i + dj) < vClusters.length; dj++) {
            const c2 = vClusters[i + dj];
            const gap = Math.abs(c2.pos - c1.pos);
            if (gap < 0.5 || gap > MAX_CLUSTER_GAP) continue;
            const inter = intersectIntervals(c1.intervals, c2.intervals)
                .filter(iv => (iv.b - iv.a) >= MIN_OVERLAP)
                .sort((x, y) => (y.b - y.a) - (x.b - x.a))
                .slice(0, MAX_INTERVALS_PER_PAIR);
            if (inter.length === 0) continue;
            const score = inter.reduce((acc, iv) => acc + (iv.b - iv.a), 0) - gap; // prefer strong overlap, smaller gap
            pairOptions.push({ j: i + dj, inter, score });
        }
        pairOptions.sort((a, b) => b.score - a.score);

        for (const opt of pairOptions.slice(0, 2)) {
            const c2 = vClusters[opt.j];
            for (const iv of opt.inter) {
                const midY = (iv.a + iv.b) / 2;
                const w1 = pickWallAt(c1, "y", midY);
                const w2 = pickWallAt(c2, "y", midY);
                const yLine = midY + DISPLAY_OFFSETS[adjIdx++ % DISPLAY_OFFSETS.length] * 0.5;
                const xMin = Math.min(c1.pos, c2.pos) - END_EXTEND;
                const xMax = Math.max(c1.pos, c2.pos) + END_EXTEND;
                addAdjProposal({
                    type: "Chain",
                    elements: [w1.id, w2.id],
                    description: `Adjacent(H): x=${Math.round((c1.pos + c2.pos) / 2)} overlap=${Math.round(iv.b - iv.a)}`,
                    line: { p1: { x: xMin, y: yLine, z: 0 }, p2: { x: xMax, y: yLine, z: 0 } },
                    meta: { kind: "adjacent", orientation: "H" }
                });
            }
        }
    }

    // Horizontal-ish walls -> measure Y spacing with vertical dimension lines
    const hClusters = clusterWallsByPos(
        horizontalWalls,
        w => (w.geometry!.p1.y + w.geometry!.p2.y) / 2,
        w => ({ a: w.geometry!.p1.x, b: w.geometry!.p2.x })
    );
    hClusters.sort((a, b) => a.pos - b.pos);

    for (let i = 0; i < hClusters.length - 1 && adjacentProposals.length < MAX_ADJ_PROPOSALS; i++) {
        const c1 = hClusters[i];

        const pairOptions: { j: number; inter: Interval[]; score: number }[] = [];
        for (let dj = 1; dj <= MAX_CLUSTER_NEIGHBORS && (i + dj) < hClusters.length; dj++) {
            const c2 = hClusters[i + dj];
            const gap = Math.abs(c2.pos - c1.pos);
            if (gap < 0.5 || gap > MAX_CLUSTER_GAP) continue;
            const inter = intersectIntervals(c1.intervals, c2.intervals)
                .filter(iv => (iv.b - iv.a) >= MIN_OVERLAP)
                .sort((x, y) => (y.b - y.a) - (x.b - x.a))
                .slice(0, MAX_INTERVALS_PER_PAIR);
            if (inter.length === 0) continue;
            const score = inter.reduce((acc, iv) => acc + (iv.b - iv.a), 0) - gap;
            pairOptions.push({ j: i + dj, inter, score });
        }
        pairOptions.sort((a, b) => b.score - a.score);

        for (const opt of pairOptions.slice(0, 2)) {
            const c2 = hClusters[opt.j];
            for (const iv of opt.inter) {
                const midX = (iv.a + iv.b) / 2;
                const w1 = pickWallAt(c1, "x", midX);
                const w2 = pickWallAt(c2, "x", midX);
                const xLine = midX + DISPLAY_OFFSETS[adjIdx++ % DISPLAY_OFFSETS.length] * 0.5;
                const yMin = Math.min(c1.pos, c2.pos) - END_EXTEND;
                const yMax = Math.max(c1.pos, c2.pos) + END_EXTEND;
                addAdjProposal({
                    type: "Chain",
                    elements: [w1.id, w2.id],
                    description: `Adjacent(V): y=${Math.round((c1.pos + c2.pos) / 2)} overlap=${Math.round(iv.b - iv.a)}`,
                    line: { p1: { x: xLine, y: yMin, z: 0 }, p2: { x: xLine, y: yMax, z: 0 } },
                    meta: { kind: "adjacent", orientation: "V" }
                });
            }
        }
    }

    if (includeAdjacent && adjacentProposals.length > 0) {
        const existing = new Set(mergedProposals.map(p => proposalSignature(p)));
        const filtered = adjacentProposals.filter(p => {
            const sig = proposalSignature(p);
            if (existing.has(sig)) return false;
            existing.add(sig);
            return true;
        });
        mergedProposals.push(...filtered);
        console.log(`Added ${filtered.length} adjacent spacing proposals.`);
    } else if (!includeAdjacent) {
        console.log("Skipping adjacent spacing proposals (includeAdjacent=false).");
    }

    // 8. Room-Centered Raycast Dimensions (Interior Coverage)
    // For each sampled room, raycast from several interior probe points (based on room boundary bbox)
    // to find nearest bounding walls in +/-X and +/-Y.
    try {
        if (roomMode === "none") {
            console.log("Skipping room proposals (roomMode=none).");
            throw new Error("skip-room-proposals");
        }

        const levelName = (validWalls.find(w => w.level)?.level) || (validGrids.find(g => g.level)?.level) || "";
        if (levelName) {
            const rooms = await callRevit("/revit/rooms", "POST", { action: "list", levelName }) as any[];
            const roomsAll = (rooms || [])
                .filter(r => typeof r?.id === "number" && typeof r?.area === "number")
                .filter(r => {
                    const name = String(r?.name ?? "").toLowerCase();
                    const area = Number(r?.area);
                    if (!Number.isFinite(area)) return false;
                    // Rooms below ~30sf are typically closets/chases and tend to generate noisy dimensions.
                    if (area < 30) return false;
                    // In coverage mode, skip very large/open areas to avoid plan-wide stripes.
                    if (preset !== "architect" && area > 350) return false;
                    if (!includeCorridors && name.includes("corridor")) return false;
                    if (name.includes("lobby") || name.includes("waiting") || name.includes("wait")) return false;
                    if (name.includes("open")) return false;
                    if (name.includes("mechanical") || name.includes("electrical") || name.includes("shaft")) return false;
                    if (name.includes("stair") || name.includes("elev")) return false;
                    return true;
                })
                .sort((a, b) => b.area - a.area);

            const ROOM_SAMPLE = roomMaxGroups;
            // Revit can return multiple ids for what is effectively the same named room. Group by a stable key
            // so downstream coverage uses consistent ids and room-span proposals include all duplicate ids.
            const roomKeyFromList = (r: any) => `${String(r?.number ?? "")}|${String(r?.name ?? "")}|${String(r?.level ?? levelName)}`;
            const roomGroupsMap = new Map<string, { key: string; ids: number[]; area: number; number: string; name: string }>();
            for (const r of roomsAll) {
                const id = Number(r?.id);
                const area = Number(r?.area);
                if (!Number.isFinite(id) || !Number.isFinite(area)) continue;
                const number = String(r?.number ?? "");
                const name = String(r?.name ?? "");
                const key = roomKeyFromList(r);
                const g = roomGroupsMap.get(key) ?? { key, ids: [], area: -Infinity, number, name };
                if (!g.ids.includes(id)) g.ids.push(id);
                g.area = Math.max(g.area, area);
                if (!g.number && number) g.number = number;
                if (!g.name && name) g.name = name;
                roomGroupsMap.set(key, g);
            }

            const roomGroups = [...roomGroupsMap.values()]
                .map(g => ({
                    ...g,
                    ids: g.ids.slice().sort((a, b) => a - b),
                    canonicalId: g.ids.slice().sort((a, b) => a - b)[0] ?? -1,
                }))
                .filter(g => Number.isFinite(g.canonicalId) && g.canonicalId > 0 && g.ids.length > 0 && Number.isFinite(g.area))
                .sort((a, b) => b.area - a.area);

            const sampledGroups = roomGroups.slice(0, ROOM_SAMPLE);
            const roomIds = [...new Set(sampledGroups.flatMap(g => g.ids))];

            const roomDetails = await callRevit("/revit/rooms", "POST", { action: "detail", roomIds }) as any[];

            const roomDetailById = new Map<number, any>();
            (roomDetails || []).forEach(r => {
                const id = Number(r?.id);
                if (Number.isFinite(id)) roomDetailById.set(id, r);
            });

            const detailed = sampledGroups
                .map(g => {
                    const detailCandidates = g.ids.map(id => roomDetailById.get(id)).filter(Boolean);
                    // Prefer a detail record that has boundary loops and a valid location.
                    const pick = (detailCandidates.find(d => Array.isArray(d?.boundaryLoops) && d.boundaryLoops.length > 0 && d.location)
                        ?? detailCandidates.find(d => d?.location)
                        ?? detailCandidates[0]) as any;
                    if (!pick) return null;
                    const loc = pick.location as { x: number, y: number, z: number } | null;
                    const area = Number(pick.area);
                    const number = String(pick?.number ?? g.number ?? "");
                    const nameOnly = String(pick?.name ?? g.name ?? "");
                    return {
                        id: g.canonicalId as number,
                        roomIds: g.ids as number[],
                        area: area,
                        name: `${number} ${nameOnly}`.trim(),
                        loc,
                        boundaryLoops: pick.boundaryLoops as any[] | undefined
                    };
                })
                .filter((r): r is { id: number; roomIds: number[]; area: number; name: string; loc: { x: number, y: number, z: number } | null; boundaryLoops: any[] | undefined } => !!r)
                .filter(r => r.loc && Number.isFinite(r.loc.x) && Number.isFinite(r.loc.y) && typeof r.area === "number" && r.area >= 20);

            const roomProposals: DimensionProposal[] = [];
            const MAX_ROOM_PROPOSALS = preset === "architect" ? 220 : 900;
            const ROOM_EXTEND = 2.0; // ft
            const ROOM_OUT_BASE = 2.25; // ft
            const ROOM_OUT_STEP = 0.75; // ft
            const ROOM_OUT_COUNT = 10;  // spread placements to reduce stripe collisions
            const WALL_HIT_MAX_DIST = 40.0; // ft (ignore absurdly far hits)

            const wallById = new Map<number, Element>();
            validWalls.forEach(w => wallById.set(w.id, w));

            const seenRoomSig = new Set<string>();
            const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
            const genHRooms = new Set<number>();
            const genVRooms = new Set<number>();

            if (roomMode === "bbox") {
                type Seg = { elementId: number; mx: number; my: number; dx: number; dy: number; len: number; };

                const pickExtrema = (items: Seg[], key: (s: Seg) => number, dir: -1 | 1) => {
                    if (items.length === 0) return null;
                    let best = items[0];
                    let bestK = key(best);
                    for (let i = 1; i < items.length; i++) {
                        const k = key(items[i]);
                        if (dir === -1 ? k < bestK : k > bestK) {
                            best = items[i];
                            bestK = k;
                        }
                    }
                    return best;
                };

                for (const r of detailed) {
                    if (roomProposals.length >= MAX_ROOM_PROPOSALS) break;
                    if (!r?.boundaryLoops || !Array.isArray(r.boundaryLoops) || r.boundaryLoops.length === 0) continue;

                    const segs: Seg[] = [];
                    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                    for (const loop of (r.boundaryLoops ?? [])) {
                        for (const s of (loop ?? [])) {
                            const eid = Number(s?.elementId);
                            const x0 = Number(s?.start?.x);
                            const y0 = Number(s?.start?.y);
                            const x1 = Number(s?.end?.x);
                            const y1 = Number(s?.end?.y);
                            if (![eid, x0, y0, x1, y1].every(Number.isFinite)) continue;
                            const dx = x1 - x0;
                            const dy = y1 - y0;
                            const len = Math.sqrt(dx * dx + dy * dy);
                            if (!(len > 1e-3)) continue;
                            const mx = (x0 + x1) / 2;
                            const my = (y0 + y1) / 2;
                            segs.push({ elementId: eid, mx, my, dx, dy, len });
                            minX = Math.min(minX, x0, x1);
                            maxX = Math.max(maxX, x0, x1);
                            minY = Math.min(minY, y0, y1);
                            maxY = Math.max(maxY, y0, y1);
                        }
                    }

                    if (!(Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minY) && Number.isFinite(maxY))) continue;
                    if (!(maxX > minX + 1.0 && maxY > minY + 1.0)) continue;

                    const rx = Number(r.loc?.x);
                    const ry = Number(r.loc?.y);
                    const cx = Number.isFinite(rx) ? rx : (minX + maxX) / 2;
                    const cy = Number.isFinite(ry) ? ry : (minY + maxY) / 2;

                    const verticalSegs = segs.filter(s => Math.abs(s.dy) >= Math.abs(s.dx) && s.len >= 2.0);
                    const horizontalSegs = segs.filter(s => Math.abs(s.dx) > Math.abs(s.dy) && s.len >= 2.0);

                    const left = pickExtrema(verticalSegs, s => s.mx, -1);
                    const right = pickExtrema(verticalSegs, s => s.mx, 1);
                    const bottom = pickExtrema(horizontalSegs, s => s.my, -1);
                    const top = pickExtrema(horizontalSegs, s => s.my, 1);

                    const isCorridor = includeCorridors && String(r.name ?? "").toLowerCase().includes("corridor");
                    const dxRoom = maxX - minX;
                    const dyRoom = maxY - minY;
                    const longAxisIsX = dxRoom >= dyRoom;

                    // Architect preset: only dimension corridors by default (rooms can be added via other methods).
                    if (preset === "architect" && !isCorridor) continue;

                    // Corridor handling: generate a few width dimensions along the corridor length.
                    if (isCorridor && corridorSampleCount > 0) {
                        const sampleN = corridorSampleCount;
                        const inset = 1.25;
                        const z = r.loc?.z ?? 0;
                        if (longAxisIsX) {
                            // Horizontal corridor (long in X): width is between bottom/top (horizontal segs), dim line vertical.
                            if (bottom && top && bottom.elementId !== top.elementId && Math.abs(top.my - bottom.my) >= 1.0) {
                                const y0 = minY + 0.75;
                                const y1 = maxY - 0.75;
                                const spanX = Math.max(0.01, dxRoom - inset * 2);
                                for (let i = 0; i < sampleN; i++) {
                                    const t = sampleN === 1 ? 0.5 : i / (sampleN - 1);
                                    const x = clamp(minX + inset + t * spanX, minX + 1.0, maxX - 1.0);
                                    roomProposals.push({
                                        type: "Chain",
                                        elements: [bottom.elementId, top.elementId],
                                        description: `CorridorWidth(V): ${r.name}`,
                                        line: { p1: { x, y: y0, z }, p2: { x, y: y1, z } },
                                        meta: { kind: "room-bbox", roomId: r.id, roomIds: r.roomIds ?? [r.id], orientation: "V" }
                                    });
                                }
                                (r.roomIds ?? [r.id]).forEach((id: number) => genVRooms.add(id));
                            }
                        } else {
                            // Vertical corridor (long in Y): width is between left/right (vertical segs), dim line horizontal.
                            if (left && right && left.elementId !== right.elementId && Math.abs(right.mx - left.mx) >= 1.0) {
                                const x0 = minX + 0.75;
                                const x1 = maxX - 0.75;
                                const spanY = Math.max(0.01, dyRoom - inset * 2);
                                for (let i = 0; i < sampleN; i++) {
                                    const t = sampleN === 1 ? 0.5 : i / (sampleN - 1);
                                    const y = clamp(minY + inset + t * spanY, minY + 1.0, maxY - 1.0);
                                    roomProposals.push({
                                        type: "Chain",
                                        elements: [left.elementId, right.elementId],
                                        description: `CorridorWidth(H): ${r.name}`,
                                        line: { p1: { x: x0, y, z }, p2: { x: x1, y, z } },
                                        meta: { kind: "room-bbox", roomId: r.id, roomIds: r.roomIds ?? [r.id], orientation: "H" }
                                    });
                                }
                                (r.roomIds ?? [r.id]).forEach((id: number) => genHRooms.add(id));
                            }
                        }
                        continue;
                    }

                    // Non-corridor: typical room bbox dimensions (1 H + 1 V).
                    if (left && right && left.elementId !== right.elementId && Math.abs(right.mx - left.mx) >= 1.0) {
                        const y = clamp(cy, minY + 1.0, maxY - 1.0);
                        const x0 = minX + 0.75;
                        const x1 = maxX - 0.75;
                        roomProposals.push({
                            type: "Chain",
                            elements: [left.elementId, right.elementId],
                            description: `RoomBBox(H): ${r.name} (${Math.round(r.area)} sf)`,
                            line: { p1: { x: x0, y, z: r.loc?.z ?? 0 }, p2: { x: x1, y, z: r.loc?.z ?? 0 } },
                            meta: { kind: "room-bbox", roomId: r.id, roomIds: r.roomIds ?? [r.id], orientation: "H" }
                        });
                        (r.roomIds ?? [r.id]).forEach((id: number) => genHRooms.add(id));
                    }

                    if (bottom && top && bottom.elementId !== top.elementId && Math.abs(top.my - bottom.my) >= 1.0) {
                        const x = clamp(cx, minX + 1.0, maxX - 1.0);
                        const y0 = minY + 0.75;
                        const y1 = maxY - 0.75;
                        roomProposals.push({
                            type: "Chain",
                            elements: [bottom.elementId, top.elementId],
                            description: `RoomBBox(V): ${r.name} (${Math.round(r.area)} sf)`,
                            line: { p1: { x, y: y0, z: r.loc?.z ?? 0 }, p2: { x, y: y1, z: r.loc?.z ?? 0 } },
                            meta: { kind: "room-bbox", roomId: r.id, roomIds: r.roomIds ?? [r.id], orientation: "V" }
                        });
                        (r.roomIds ?? [r.id]).forEach((id: number) => genVRooms.add(id));
                    }
                }

                if (genHRooms.size > 0 || genVRooms.size > 0) {
                    console.log(`Room bbox generated: H=${genHRooms.size} rooms, V=${genVRooms.size} rooms (detailedRooms=${detailed.length})`);
                }
            }

            if (roomMode !== "bbox") {
                const allVerticalWalls = validWalls.filter(w => w.geometry && isVerticalish(lineAngleDeg(w.geometry!)) && lineLen(w.geometry!) >= MIN_WALL_LEN);
                const allHorizontalWalls = validWalls.filter(w => w.geometry && isHorizontalish(lineAngleDeg(w.geometry!)) && lineLen(w.geometry!) >= MIN_WALL_LEN);

            const findNearestVerticalAtY = (
                y: number,
                x: number,
                candidates: Element[]
            ): { left: { id: number; x: number; z: number } | null; right: { id: number; x: number; z: number } | null } => {
                let left: { id: number, x: number, z: number } | null = null;
                let right: { id: number, x: number, z: number } | null = null;
                for (const w of candidates) {
                    const g = w.geometry!;
                    const y1 = g.p1.y, y2 = g.p2.y;
                    const minYw = Math.min(y1, y2), maxYw = Math.max(y1, y2);
                    if (y < minYw - 1e-6 || y > maxYw + 1e-6) continue;
                    const dy = y2 - y1;
                    if (Math.abs(dy) < 1e-9) continue;
                    const t = (y - y1) / dy;
                    if (t < -1e-6 || t > 1 + 1e-6) continue;
                    const xi = g.p1.x + t * (g.p2.x - g.p1.x);
                    const zi = g.p1.z ?? 0;
                    if (xi < x - 0.25) {
                        if (!left || xi > left.x) left = { id: w.id, x: xi, z: zi };
                    } else if (xi > x + 0.25) {
                        if (!right || xi < right.x) right = { id: w.id, x: xi, z: zi };
                    }
                }
                if (left && (x - left.x) > WALL_HIT_MAX_DIST) left = null;
                if (right && (right.x - x) > WALL_HIT_MAX_DIST) right = null;
                return { left, right };
            };

            const findNearestHorizontalAtX = (
                x: number,
                y: number,
                candidates: Element[]
            ): { bottom: { id: number; y: number; z: number } | null; top: { id: number; y: number; z: number } | null } => {
                let bottom: { id: number, y: number, z: number } | null = null;
                let top: { id: number, y: number, z: number } | null = null;
                for (const w of candidates) {
                    const g = w.geometry!;
                    const x1 = g.p1.x, x2 = g.p2.x;
                    const minXw = Math.min(x1, x2), maxXw = Math.max(x1, x2);
                    if (x < minXw - 1e-6 || x > maxXw + 1e-6) continue;
                    const dx = x2 - x1;
                    if (Math.abs(dx) < 1e-9) continue;
                    const t = (x - x1) / dx;
                    if (t < -1e-6 || t > 1 + 1e-6) continue;
                    const yi = g.p1.y + t * (g.p2.y - g.p1.y);
                    const zi = g.p1.z ?? 0;
                    if (yi < y - 0.25) {
                        if (!bottom || yi > bottom.y) bottom = { id: w.id, y: yi, z: zi };
                    } else if (yi > y + 0.25) {
                        if (!top || yi < top.y) top = { id: w.id, y: yi, z: zi };
                    }
                }
                if (bottom && (y - bottom.y) > WALL_HIT_MAX_DIST) bottom = null;
                if (top && (top.y - y) > WALL_HIT_MAX_DIST) top = null;
                return { bottom, top };
            };

            let idx = 0;
            for (const r of detailed) {
                if (roomProposals.length >= MAX_ROOM_PROPOSALS) break;
                const cx0 = clamp(r.loc!.x, minX + 1.0, maxX - 1.0);
                const cy0 = clamp(r.loc!.y, minY + 1.0, maxY - 1.0);
                const cz = r.loc!.z ?? 0;

                // Compute a room bbox from boundary points when available to create multiple probe lines.
                let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity;
                const loops = r.boundaryLoops ?? [];
                for (const loop of loops) {
                    if (!Array.isArray(loop)) continue;
                    for (const seg of loop) {
                        const pts = [seg?.start, seg?.end].filter(Boolean);
                        for (const p of pts) {
                            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
                            rMinX = Math.min(rMinX, p.x);
                            rMaxX = Math.max(rMaxX, p.x);
                            rMinY = Math.min(rMinY, p.y);
                            rMaxY = Math.max(rMaxY, p.y);
                        }
                    }
                }

                const hasBbox = Number.isFinite(rMinX) && Number.isFinite(rMaxX) && Number.isFinite(rMinY) && Number.isFinite(rMaxY) &&
                    (rMaxX > rMinX) && (rMaxY > rMinY);

                const cx = hasBbox ? clamp(cx0, rMinX + 0.5, rMaxX - 0.5) : cx0;
                const cy = hasBbox ? clamp(cy0, rMinY + 0.5, rMaxY - 0.5) : cy0;

                // Prefer raycasting to room boundary walls (human-like), but fall back to nearby walls
                // when the boundary loop includes non-wall segments (room separation lines, etc).
                const boundaryWallIds = new Set<number>();
                for (const loop of loops) {
                    if (!Array.isArray(loop)) continue;
                    for (const seg of loop) {
                        const id = seg?.elementId;
                        if (typeof id === "number" && id > 0 && wallById.has(id)) boundaryWallIds.add(id);
                    }
                }

                const boundaryWalls = [...boundaryWallIds].map(id => wallById.get(id)!).filter(w => w?.geometry);
                const boundaryVertical = boundaryWalls.filter(w => isVerticalish(lineAngleDeg(w.geometry!)));
                const boundaryHorizontal = boundaryWalls.filter(w => isHorizontalish(lineAngleDeg(w.geometry!)));

                // Some "open" rooms have boundaries that are room-separation lines or other non-wall elements.
                // Fall back to nearby walls within the room bbox to still provide constraints.
                const localMargin = 12.0; // ft
                const localWalls = hasBbox
                    ? validWalls.filter(w => {
                        const g = w.geometry;
                        if (!g) return false;
                        const minXw = Math.min(g.p1.x, g.p2.x);
                        const maxXw = Math.max(g.p1.x, g.p2.x);
                        const minYw = Math.min(g.p1.y, g.p2.y);
                        const maxYw = Math.max(g.p1.y, g.p2.y);
                        const ovX = maxXw >= (rMinX - localMargin) && minXw <= (rMaxX + localMargin);
                        const ovY = maxYw >= (rMinY - localMargin) && minYw <= (rMaxY + localMargin);
                        return ovX && ovY;
                    })
                    : [];
                const localVertical = localWalls.filter(w => w.geometry && isVerticalish(lineAngleDeg(w.geometry!)));
                const localHorizontal = localWalls.filter(w => w.geometry && isHorizontalish(lineAngleDeg(w.geometry!)));

                const combinedVertical = (() => {
                    const out: Element[] = [];
                    const seen = new Set<number>();
                    for (const w of [...boundaryVertical, ...localVertical]) {
                        if (!w?.geometry) continue;
                        if (seen.has(w.id)) continue;
                        seen.add(w.id);
                        out.push(w);
                    }
                    return out;
                })();

                const combinedHorizontal = (() => {
                    const out: Element[] = [];
                    const seen = new Set<number>();
                    for (const w of [...boundaryHorizontal, ...localHorizontal]) {
                        if (!w?.geometry) continue;
                        if (seen.has(w.id)) continue;
                        seen.add(w.id);
                        out.push(w);
                    }
                    return out;
                })();

                const useVertical = combinedVertical.length >= 2 ? combinedVertical : localVertical;
                const useHorizontal = combinedHorizontal.length >= 2 ? combinedHorizontal : localHorizontal;

                const finalUseVertical = useVertical.length >= 2 ? useVertical : allVerticalWalls;
                const finalUseHorizontal = useHorizontal.length >= 2 ? useHorizontal : allHorizontalWalls;

                if (finalUseVertical.length < 2 || finalUseHorizontal.length < 2) {
                    idx++;
                    continue;
                }

                // Prefer dimensions just outside the room boundary (human-like),
                // but generate a couple placement options (above/below or left/right) so selection can
                // avoid stripe collisions while still covering rooms.
                const h = ((r.id * 2654435761) >>> 0);
                const out = ROOM_OUT_BASE + (h % ROOM_OUT_COUNT) * ROOM_OUT_STEP;
                const out2 = ROOM_OUT_BASE + (((h >>> 7) + 3) % ROOM_OUT_COUNT) * ROOM_OUT_STEP;
                const yAbove = hasBbox ? (rMaxY + out) : (cy + 2.0);
                const yBelow = hasBbox ? (rMinY - out) : (cy - 2.0);
                const yAbove2 = hasBbox ? (rMaxY + out2) : (cy + 3.5);
                const yBelow2 = hasBbox ? (rMinY - out2) : (cy - 3.5);
                const xLeft = hasBbox ? (rMinX - out) : (cx - 2.0);
                const xRight = hasBbox ? (rMaxX + out) : (cx + 2.0);
                const xLeft2 = hasBbox ? (rMinX - out2) : (cx - 3.5);
                const xRight2 = hasBbox ? (rMaxX + out2) : (cx + 3.5);

                const yProbeCandidates = hasBbox
                    ? [
                        cy,
                        rMinY + (rMaxY - rMinY) * 0.25,
                        rMinY + (rMaxY - rMinY) * 0.50,
                        rMinY + (rMaxY - rMinY) * 0.75
                    ]
                    : [cy];
                const xProbeCandidates = hasBbox
                    ? [
                        cx,
                        rMinX + (rMaxX - rMinX) * 0.25,
                        rMinX + (rMaxX - rMinX) * 0.50,
                        rMinX + (rMaxX - rMinX) * 0.75
                    ]
                    : [cx];

                if (roomProposals.length < MAX_ROOM_PROPOSALS) {
                    let bestLR: { left: { id: number, x: number, z: number }, right: { id: number, x: number, z: number } } | null = null;
                    let bestSpan = Infinity;
                    for (const yProbe of yProbeCandidates) {
                        for (const xProbe of xProbeCandidates) {
                            let { left, right } = findNearestVerticalAtY(yProbe, xProbe, finalUseVertical);
                            if (!left || !right) continue;
                            if (left.id === right.id) continue;
                            const span = right.x - left.x;
                            if (!(span > 0) || span > WALL_HIT_MAX_DIST * 2) continue;
                            if (span < bestSpan) {
                                bestSpan = span;
                                bestLR = { left, right };
                            }
                        }
                    }
                    if (!bestLR && useVertical.length >= 2) {
                        const centers = useVertical
                            .map(w => {
                                const g = w.geometry!;
                                return { id: w.id, x: (g.p1.x + g.p2.x) / 2, z: g.p1.z ?? cz };
                            })
                            .sort((a, b) => a.x - b.x);
                        const leftNear = centers.filter(c => c.x <= cx).slice(-1)[0] ?? centers[0];
                        const rightNear = centers.find(c => c.x >= cx) ?? centers[centers.length - 1];
                        if (leftNear && rightNear && leftNear.id !== rightNear.id) {
                            const span = rightNear.x - leftNear.x;
                            if (span > 0 && span <= WALL_HIT_MAX_DIST * 2) {
                                bestLR = { left: leftNear, right: rightNear };
                            }
                        }
                    }
                    if (bestLR) {
                        genHRooms.add(r.id);
                        const { left, right } = bestLR;
                        // Clamp display line to the overlap of wall extents to avoid invalid references.
                        const wl = wallById.get(left.id)?.geometry;
                        const wr = wallById.get(right.id)?.geometry;
                        const overlapMinY = (wl && wr)
                            ? Math.max(Math.min(wl.p1.y, wl.p2.y), Math.min(wr.p1.y, wr.p2.y))
                            : -Infinity;
                        const overlapMaxY = (wl && wr)
                            ? Math.min(Math.max(wl.p1.y, wl.p2.y), Math.max(wr.p1.y, wr.p2.y))
                            : Infinity;
                        const yClamp = (y: number) => {
                            if (!Number.isFinite(overlapMinY) || !Number.isFinite(overlapMaxY) || overlapMaxY <= overlapMinY + 0.5) return y;
                            return clamp(y, overlapMinY + 0.25, overlapMaxY - 0.25);
                        };

                        const yLines = [yAbove, yBelow, yAbove2, yBelow2].map(yClamp);
                        for (const yLine of yLines) {
                            if (roomProposals.length >= MAX_ROOM_PROPOSALS) break;
                            const sig = `${r.id}|H|${proposalSignature({
                                type: "Chain",
                                elements: [left.id, right.id],
                                description: "",
                                line: {
                                    p1: { x: left.x - ROOM_EXTEND, y: yLine, z: left.z ?? cz },
                                    p2: { x: right.x + ROOM_EXTEND, y: yLine, z: right.z ?? cz }
                                }
                            })}`;
                            if (seenRoomSig.has(sig)) continue;
                            seenRoomSig.add(sig);
                            roomProposals.push({
                                type: "Chain",
                                elements: [left.id, right.id],
                                description: `RoomSpan(H): ${r.name} (${Math.round(r.area)} sf)`,
                                line: {
                                    p1: { x: left.x - ROOM_EXTEND, y: yLine, z: left.z ?? cz },
                                    p2: { x: right.x + ROOM_EXTEND, y: yLine, z: right.z ?? cz }
                                },
                                meta: { kind: "room-span", roomId: r.id, roomIds: r.roomIds ?? [r.id], orientation: "H" }
                            });
                        }
                    }
                }

                if (roomProposals.length < MAX_ROOM_PROPOSALS) {
                    let bestBT: { bottom: { id: number, y: number, z: number }, top: { id: number, y: number, z: number } } | null = null;
                    let bestSpan = Infinity;
                    for (const xProbe of xProbeCandidates) {
                        for (const yProbe of yProbeCandidates) {
                            let { bottom, top } = findNearestHorizontalAtX(xProbe, yProbe, finalUseHorizontal);
                            if (!bottom || !top) continue;
                            if (bottom.id === top.id) continue;
                            const span = top.y - bottom.y;
                            if (!(span > 0) || span > WALL_HIT_MAX_DIST * 2) continue;
                            if (span < bestSpan) {
                                bestSpan = span;
                                bestBT = { bottom, top };
                            }
                        }
                    }
                    if (!bestBT && useHorizontal.length >= 2) {
                        const centers = useHorizontal
                            .map(w => {
                                const g = w.geometry!;
                                return { id: w.id, y: (g.p1.y + g.p2.y) / 2, z: g.p1.z ?? cz };
                            })
                            .sort((a, b) => a.y - b.y);
                        const bottomNear = centers.filter(c => c.y <= cy).slice(-1)[0] ?? centers[0];
                        const topNear = centers.find(c => c.y >= cy) ?? centers[centers.length - 1];
                        if (bottomNear && topNear && bottomNear.id !== topNear.id) {
                            const span = topNear.y - bottomNear.y;
                            if (span > 0 && span <= WALL_HIT_MAX_DIST * 2) {
                                bestBT = { bottom: bottomNear, top: topNear };
                            }
                        }
                    }
                    if (bestBT) {
                        genVRooms.add(r.id);
                        const { bottom, top } = bestBT;
                        // Clamp display line to the overlap of wall extents to avoid invalid references.
                        const wb = wallById.get(bottom.id)?.geometry;
                        const wt = wallById.get(top.id)?.geometry;
                        const overlapMinX = (wb && wt)
                            ? Math.max(Math.min(wb.p1.x, wb.p2.x), Math.min(wt.p1.x, wt.p2.x))
                            : -Infinity;
                        const overlapMaxX = (wb && wt)
                            ? Math.min(Math.max(wb.p1.x, wb.p2.x), Math.max(wt.p1.x, wt.p2.x))
                            : Infinity;
                        const xClamp = (x: number) => {
                            if (!Number.isFinite(overlapMinX) || !Number.isFinite(overlapMaxX) || overlapMaxX <= overlapMinX + 0.5) return x;
                            return clamp(x, overlapMinX + 0.25, overlapMaxX - 0.25);
                        };

                        const xLines = [xRight, xLeft, xRight2, xLeft2].map(xClamp);
                        for (const xLine of xLines) {
                            if (roomProposals.length >= MAX_ROOM_PROPOSALS) break;
                            const sig = `${r.id}|V|${proposalSignature({
                                type: "Chain",
                                elements: [bottom.id, top.id],
                                description: "",
                                line: {
                                    p1: { x: xLine, y: bottom.y - ROOM_EXTEND, z: bottom.z ?? cz },
                                    p2: { x: xLine, y: top.y + ROOM_EXTEND, z: top.z ?? cz }
                                }
                            })}`;
                            if (seenRoomSig.has(sig)) continue;
                            seenRoomSig.add(sig);
                            roomProposals.push({
                                type: "Chain",
                                elements: [bottom.id, top.id],
                                description: `RoomSpan(V): ${r.name} (${Math.round(r.area)} sf)`,
                                line: {
                                    p1: { x: xLine, y: bottom.y - ROOM_EXTEND, z: bottom.z ?? cz },
                                    p2: { x: xLine, y: top.y + ROOM_EXTEND, z: top.z ?? cz }
                                },
                                meta: { kind: "room-span", roomId: r.id, roomIds: r.roomIds ?? [r.id], orientation: "V" }
                            });
                        }
                    }
                }

                idx++;
            }

                if (genHRooms.size > 0 || genVRooms.size > 0) {
                    // Debug: how many unique rooms produced at least one H/V constraint (before dedupe against other proposal kinds).
                    console.log(`Room raycast generated: H=${genHRooms.size} rooms, V=${genVRooms.size} rooms (detailedRooms=${detailed.length})`);
                }
            }

            if (roomProposals.length > 0) {
                // Merge duplicates by signature, but preserve multi-room coverage for the dimension.
                const sigToExisting = new Map<string, DimensionProposal>();
                for (const p of mergedProposals) sigToExisting.set(proposalSignature(p), p);

                const appended: DimensionProposal[] = [];
                for (const p of roomProposals) {
                    const sig = proposalSignature(p);
                    const existing = sigToExisting.get(sig);
                    const addIds = p.meta?.roomIds ?? (typeof p.meta?.roomId === "number" ? [p.meta.roomId] : []);

                    if (existing) {
                        if (addIds.length > 0) {
                            if (!existing.meta) {
                                // If an identical non-room proposal already exists, enrich it with room coverage metadata.
                                existing.meta = { kind: p.meta?.kind ?? "room-span", orientation: p.meta?.orientation };
                            } else if (!existing.meta.orientation && p.meta?.orientation) {
                                // Preserve room orientation even if the existing proposal already had meta.
                                existing.meta.orientation = p.meta.orientation;
                            }
                            const prev = existing.meta.roomIds ?? (typeof existing.meta.roomId === "number" ? [existing.meta.roomId] : []);
                            const merged = [...prev];
                            for (const id of addIds) if (!merged.includes(id)) merged.push(id);
                            existing.meta.roomIds = merged;
                            if (typeof existing.meta.roomId !== "number" && merged.length > 0) existing.meta.roomId = merged[0];
                        }
                        continue;
                    }

                    sigToExisting.set(sig, p);
                    appended.push(p);
                }

                mergedProposals.push(...appended);

                const hRooms = new Set<number>();
                const vRooms = new Set<number>();
                let hCount = 0;
                let vCount = 0;
                for (const p of roomProposals) {
                    const o = p.meta?.orientation;
                    if (!o) continue;
                    const ids = p.meta?.roomIds ?? (typeof p.meta?.roomId === "number" ? [p.meta.roomId] : []);
                    if (o === "H") { hCount++; ids.forEach(id => hRooms.add(id)); }
                    if (o === "V") { vCount++; ids.forEach(id => vRooms.add(id)); }
                }

                console.log(
                    `Added ${appended.length} room ${roomMode} proposals (level='${levelName}', rooms=${detailed.length}); merged ${roomProposals.length - appended.length} duplicates. ` +
                    `H=${hCount}(${hRooms.size} rooms) V=${vCount}(${vRooms.size} rooms)`
                );
            }
        } else {
            console.log("Skipping room raycast proposals (could not infer level name).");
        }
    } catch (e) {
        if (String((e as any)?.message ?? e) === "skip-room-proposals") {
            // no-op
        } else {
            console.warn("Room proposals failed; continuing without rooms.", e);
        }
    }

    // --- Grid / Overall Anchors (architect-friendly) ---
    // Add a couple of low-clutter anchors when possible:
    // - Grid chain dims (1 horizontal + 1 vertical)
    // - Overall extents (when exterior walls are available)
    {
        const existing = new Set(mergedProposals.map(p => proposalSignature(p)));
        const addIfNew = (p: DimensionProposal) => {
            const sig = proposalSignature(p);
            if (existing.has(sig)) return false;
            existing.add(sig);
            mergedProposals.push(p);
            return true;
        };

        const OUT0 = 6.0;
        const OUT1 = 10.0;
        const PAD = 6.0;

        const gridAngle = (g: Element) => (g.geometry ? lineAngleDeg(g.geometry) : 0);
        const gridCx = (g: Element) => g.geometry ? (g.geometry.p1.x + g.geometry.p2.x) / 2 : 0;
        const gridCy = (g: Element) => g.geometry ? (g.geometry.p1.y + g.geometry.p2.y) / 2 : 0;

        const vGrids = validGrids.filter(g => g.geometry && isVerticalish(gridAngle(g))).sort((a, b) => gridCx(a) - gridCx(b));
        const hGrids = validGrids.filter(g => g.geometry && isHorizontalish(gridAngle(g))).sort((a, b) => gridCy(a) - gridCy(b));

        if (vGrids.length >= 2) {
            addIfNew({
                type: "Chain",
                elements: vGrids.map(g => g.id),
                description: `GridChain(H): ${vGrids.length} grids`,
                line: { p1: { x: minX - PAD, y: maxY + OUT0, z: 0 }, p2: { x: maxX + PAD, y: maxY + OUT0, z: 0 } },
                meta: { kind: "grid-chain", orientation: "H" },
            });
        }
        if (hGrids.length >= 2) {
            addIfNew({
                type: "Chain",
                elements: hGrids.map(g => g.id),
                description: `GridChain(V): ${hGrids.length} grids`,
                line: { p1: { x: maxX + OUT0, y: minY - PAD, z: 0 }, p2: { x: maxX + OUT0, y: maxY + PAD, z: 0 } },
                meta: { kind: "grid-chain", orientation: "V" },
            });
        }

        const extWalls = validWalls.filter(w => w.geometry && String(w.name ?? "").toLowerCase().includes("exterior"));
        const wallCx = (w: Element) => w.geometry ? (w.geometry.p1.x + w.geometry.p2.x) / 2 : 0;
        const wallCy = (w: Element) => w.geometry ? (w.geometry.p1.y + w.geometry.p2.y) / 2 : 0;
        const wallAngle = (w: Element) => w.geometry ? lineAngleDeg(w.geometry) : 0;

        const vExt = extWalls.filter(w => w.geometry && isVerticalish(wallAngle(w))).sort((a, b) => wallCx(a) - wallCx(b));
        const hExt = extWalls.filter(w => w.geometry && isHorizontalish(wallAngle(w))).sort((a, b) => wallCy(a) - wallCy(b));

        if (vExt.length >= 2) {
            addIfNew({
                type: "Chain",
                elements: [vExt[0].id, vExt[vExt.length - 1].id],
                description: `Overall(H): exterior width`,
                line: { p1: { x: minX - PAD, y: maxY + OUT1, z: 0 }, p2: { x: maxX + PAD, y: maxY + OUT1, z: 0 } },
                meta: { kind: "overall", orientation: "H" },
            });
        }
        if (hExt.length >= 2) {
            addIfNew({
                type: "Chain",
                elements: [hExt[0].id, hExt[hExt.length - 1].id],
                description: `Overall(V): exterior height`,
                line: { p1: { x: maxX + OUT1, y: minY - PAD, z: 0 }, p2: { x: maxX + OUT1, y: maxY + PAD, z: 0 } },
                meta: { kind: "overall", orientation: "V" },
            });
        }
    }

    // --- Wall Repair Proposals (local 2-ref constraints to boost adequacy) ---
    // Goal: increase "cover wall" coverage without creating global stripes.
    // We generate small, explicit (line-placed) 2-ref dimensions between nearby parallel walls (and occasionally to grids)
    // for walls that currently lack a local constraint.
    if (includeWallRepair) {
        const COVER_WALL_MIN_LEN = 4.0; // ft
        const MAX_REPAIR_PROPOSALS = preset === "architect" ? 220 : 750;
        const MIN_OVERLAP = 4.0; // ft along the wall direction
        const MIN_PAIR_DIST = 1.5; // ft (avoid near-duplicate faces)
        const MAX_PAIR_DIST = preset === "architect" ? 35.0 : 55.0; // ft (keep local; selection will still penalize long spans)
        const MAX_GRID_DIST = preset === "architect" ? 35.0 : 55.0; // ft
        const END_PAD = 1.5; // ft extend beyond refs

        const bad = loadBadRefs();
        const existingSigs = new Set<string>(mergedProposals.map(p => proposalSignature(p)));
        const wallById = new Map<number, Element>(validWalls.map(w => [w.id, w]));
        const gridById = new Map<number, Element>(validGrids.map(g => [g.id, g]));

        const isCurtain = (w: Element) => String(w.name ?? "").toLowerCase().includes("curtain");

        type WInfo = {
            id: number;
            w: Element;
            len: number;
            a: number;
            x0: number; x1: number;
            y0: number; y1: number;
            cx: number; cy: number;
        };

        const coverInfos: WInfo[] = [];
        for (const w of validWalls) {
            if (!w.geometry) continue;
            if (isCurtain(w)) continue;
            const len = lineLen(w.geometry);
            if (len < COVER_WALL_MIN_LEN) continue;
            const a = lineAngleDeg(w.geometry);
            const x0 = Math.min(w.geometry.p1.x, w.geometry.p2.x);
            const x1 = Math.max(w.geometry.p1.x, w.geometry.p2.x);
            const y0 = Math.min(w.geometry.p1.y, w.geometry.p2.y);
            const y1 = Math.max(w.geometry.p1.y, w.geometry.p2.y);
            const cx = (w.geometry.p1.x + w.geometry.p2.x) / 2;
            const cy = (w.geometry.p1.y + w.geometry.p2.y) / 2;
            if (!Number.isFinite(x0) || !Number.isFinite(x1) || !Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(cx) || !Number.isFinite(cy)) continue;
            coverInfos.push({ id: w.id, w, len, a, x0, x1, y0, y1, cx, cy });
        }

        const stats = new Map<number, { has2Ref: boolean; minElems: number }>();
        for (const wi of coverInfos) stats.set(wi.id, { has2Ref: false, minElems: Infinity });
        for (const p of mergedProposals) {
            const elems = p.elements || [];
            const n = elems.length;
            if (n < 2) continue;
            for (const id of elems) {
                const st = stats.get(id);
                if (!st) continue;
                if (n < st.minElems) st.minElems = n;
                if (n === 2) st.has2Ref = true;
            }
        }

        const verticalInfos = coverInfos.filter(wi => isVerticalish(wi.a)).sort((a, b) => a.cx - b.cx);
        const horizontalInfos = coverInfos.filter(wi => isHorizontalish(wi.a)).sort((a, b) => a.cy - b.cy);

        type GInfo = {
            id: number;
            g: Element;
            a: number;
            x0: number; x1: number;
            y0: number; y1: number;
            cx: number; cy: number;
        };
        const gridInfos: GInfo[] = [];
        for (const g of validGrids) {
            if (!g.geometry) continue;
            const a = lineAngleDeg(g.geometry);
            const x0 = Math.min(g.geometry.p1.x, g.geometry.p2.x);
            const x1 = Math.max(g.geometry.p1.x, g.geometry.p2.x);
            const y0 = Math.min(g.geometry.p1.y, g.geometry.p2.y);
            const y1 = Math.max(g.geometry.p1.y, g.geometry.p2.y);
            const cx = (g.geometry.p1.x + g.geometry.p2.x) / 2;
            const cy = (g.geometry.p1.y + g.geometry.p2.y) / 2;
            if (!Number.isFinite(x0) || !Number.isFinite(x1) || !Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(cx) || !Number.isFinite(cy)) continue;
            gridInfos.push({ id: g.id, g, a, x0, x1, y0, y1, cx, cy });
        }
        const vGrids = gridInfos.filter(gi => isVerticalish(gi.a)).sort((a, b) => a.cx - b.cx);
        const hGrids = gridInfos.filter(gi => isHorizontalish(gi.a)).sort((a, b) => a.cy - b.cy);

        const canUsePair = (kind: string, ids: number[]) => {
            if (ids.some(id => bad.badWallIds.has(id))) return false;
            if (ids.length === 2) {
                const a = ids.slice().sort((x, y) => x - y).join(",");
                if (bad.badPairs.has(`${kind}|${a}`)) return false;
            }
            return true;
        };

        const addRepair = (p: DimensionProposal) => {
            if (!p.line) return false;
            const sig = proposalSignature(p);
            if (existingSigs.has(sig)) return false;
            existingSigs.add(sig);
            mergedProposals.push(p);
            return true;
        };

        const findBestParallelWall = (src: WInfo, arr: WInfo[], axis: "x" | "y"): WInfo | null => {
            const coord = axis === "x" ? src.cx : src.cy;
            const idx0 = (() => {
                // binary search insertion point in sorted array (by cx/cy)
                let lo = 0, hi = arr.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    const v = axis === "x" ? arr[mid].cx : arr[mid].cy;
                    if (v < coord) lo = mid + 1;
                    else hi = mid;
                }
                return lo;
            })();

            let bestWi: WInfo | null = null;
            let bestDist = Number.POSITIVE_INFINITY;
            const consider = (cand: WInfo) => {
                if (cand.id === src.id) return;
                if (bad.badWallIds.has(cand.id) || bad.badWallIds.has(src.id)) return;
                const dist = axis === "x" ? Math.abs(cand.cx - src.cx) : Math.abs(cand.cy - src.cy);
                if (!(dist >= MIN_PAIR_DIST && dist <= MAX_PAIR_DIST)) return;
                const overlap = axis === "x"
                    ? (Math.min(src.y1, cand.y1) - Math.max(src.y0, cand.y0))
                    : (Math.min(src.x1, cand.x1) - Math.max(src.x0, cand.x0));
                if (!(overlap >= MIN_OVERLAP)) return;
                if (!Number.isFinite(overlap)) return;
                if (dist < bestDist) {
                    bestWi = cand;
                    bestDist = dist;
                }
            };

            // scan outwards from idx0
            for (let step = 0; step < 80; step++) {
                const iL = idx0 - 1 - step;
                const iR = idx0 + step;
                let progressed = false;
                if (iL >= 0) {
                    const v = axis === "x" ? arr[iL].cx : arr[iL].cy;
                    if (Math.abs(v - coord) <= MAX_PAIR_DIST) { consider(arr[iL]); progressed = true; }
                }
                if (iR < arr.length) {
                    const v = axis === "x" ? arr[iR].cx : arr[iR].cy;
                    if (Math.abs(v - coord) <= MAX_PAIR_DIST) { consider(arr[iR]); progressed = true; }
                }
                if (!progressed) break;
            }
            return bestWi;
        };

        const findBestParallelGrid = (src: WInfo, arr: GInfo[], axis: "x" | "y"): GInfo | null => {
            const coord = axis === "x" ? src.cx : src.cy;
            const idx0 = (() => {
                let lo = 0, hi = arr.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    const v = axis === "x" ? arr[mid].cx : arr[mid].cy;
                    if (v < coord) lo = mid + 1;
                    else hi = mid;
                }
                return lo;
            })();
            let bestGi: GInfo | null = null;
            let bestDist = Number.POSITIVE_INFINITY;
            const consider = (cand: GInfo) => {
                const dist = axis === "x" ? Math.abs(cand.cx - src.cx) : Math.abs(cand.cy - src.cy);
                if (!(dist >= MIN_PAIR_DIST && dist <= MAX_GRID_DIST)) return;
                const overlap = axis === "x"
                    ? (Math.min(src.y1, cand.y1) - Math.max(src.y0, cand.y0))
                    : (Math.min(src.x1, cand.x1) - Math.max(src.x0, cand.x0));
                if (!(overlap >= MIN_OVERLAP)) return;
                if (dist < bestDist) {
                    bestGi = cand;
                    bestDist = dist;
                }
            };
            for (let step = 0; step < 120; step++) {
                const iL = idx0 - 1 - step;
                const iR = idx0 + step;
                let progressed = false;
                if (iL >= 0) {
                    const v = axis === "x" ? arr[iL].cx : arr[iL].cy;
                    if (Math.abs(v - coord) <= MAX_GRID_DIST) { consider(arr[iL]); progressed = true; }
                }
                if (iR < arr.length) {
                    const v = axis === "x" ? arr[iR].cx : arr[iR].cy;
                    if (Math.abs(v - coord) <= MAX_GRID_DIST) { consider(arr[iR]); progressed = true; }
                }
                if (!progressed) break;
            }
            return bestGi;
        };

        const repairCandidates = coverInfos
            .filter(wi => {
                if (bad.badWallIds.has(wi.id)) return false;
                const st = stats.get(wi.id);
                if (!st) return true;
                // If it already has a 2-ref dimension, or appears in short chains, treat as locally constrained.
                if (st.has2Ref) return false;
                if (st.minElems <= 4) return false;
                return true;
            })
            .sort((a, b) => {
                const sa = stats.get(a.id)?.minElems ?? Infinity;
                const sb = stats.get(b.id)?.minElems ?? Infinity;
                if (sa !== sb) return sb - sa; // prefer those only in long chains (or never)
                if (a.len !== b.len) return b.len - a.len;
                return a.id - b.id;
            });

        let added = 0;
        let tried = 0;
        for (const wi of repairCandidates) {
            if (mergedProposals.length > 4000) break;
            if (added >= MAX_REPAIR_PROPOSALS) break;
            tried++;

            const w = wi.w;
            const a = wi.a;
            const kind = "wall-repair";

            if (isVerticalish(a)) {
                const partner = findBestParallelWall(wi, verticalInfos, "x");
                if (partner) {
                    const overlap0 = Math.max(wi.y0, partner.y0);
                    const overlap1 = Math.min(wi.y1, partner.y1);
                    const y = (overlap0 + overlap1) / 2;
                    const xA = wi.cx;
                    const xB = partner.cx;
                    const x0 = Math.min(xA, xB) - END_PAD;
                    const x1 = Math.max(xA, xB) + END_PAD;
                    const ids = [wi.id, partner.id];
                    if (canUsePair(kind, ids) && Number.isFinite(y) && x1 > x0) {
                        const p: DimensionProposal = {
                            type: "Chain",
                            elements: ids,
                            description: `Wall repair (H): ${wi.id} ↔ ${partner.id}`,
                            line: { p1: { x: x0, y, z: 0 }, p2: { x: x1, y, z: 0 } },
                            meta: { kind: "wall-repair", orientation: "H" },
                        };
                        if (addRepair(p)) { added++; continue; }
                    }
                }

                // Fallback: wall-to-grid
                const g = findBestParallelGrid(wi, vGrids, "x");
                if (g) {
                    const overlap0 = Math.max(wi.y0, g.y0);
                    const overlap1 = Math.min(wi.y1, g.y1);
                    const y = (overlap0 + overlap1) / 2;
                    const xA = wi.cx;
                    const xB = g.cx;
                    const x0 = Math.min(xA, xB) - END_PAD;
                    const x1 = Math.max(xA, xB) + END_PAD;
                    const ids = [wi.id, g.id];
                    if (Number.isFinite(y) && x1 > x0) {
                        const p: DimensionProposal = {
                            type: "Chain",
                            elements: ids,
                            description: `Wall repair (H) to grid: ${wi.id} ↔ ${g.id}`,
                            line: { p1: { x: x0, y, z: 0 }, p2: { x: x1, y, z: 0 } },
                            meta: { kind: "wall-repair", orientation: "H" },
                        };
                        if (addRepair(p)) { added++; continue; }
                    }
                }
            } else if (isHorizontalish(a)) {
                const partner = findBestParallelWall(wi, horizontalInfos, "y");
                if (partner) {
                    const overlap0 = Math.max(wi.x0, partner.x0);
                    const overlap1 = Math.min(wi.x1, partner.x1);
                    const x = (overlap0 + overlap1) / 2;
                    const yA = wi.cy;
                    const yB = partner.cy;
                    const y0 = Math.min(yA, yB) - END_PAD;
                    const y1 = Math.max(yA, yB) + END_PAD;
                    const ids = [wi.id, partner.id];
                    if (canUsePair(kind, ids) && Number.isFinite(x) && y1 > y0) {
                        const p: DimensionProposal = {
                            type: "Chain",
                            elements: ids,
                            description: `Wall repair (V): ${wi.id} ↔ ${partner.id}`,
                            line: { p1: { x, y: y0, z: 0 }, p2: { x, y: y1, z: 0 } },
                            meta: { kind: "wall-repair", orientation: "V" },
                        };
                        if (addRepair(p)) { added++; continue; }
                    }
                }

                // Fallback: wall-to-grid
                const g = findBestParallelGrid(wi, hGrids, "y");
                if (g) {
                    const overlap0 = Math.max(wi.x0, g.x0);
                    const overlap1 = Math.min(wi.x1, g.x1);
                    const x = (overlap0 + overlap1) / 2;
                    const yA = wi.cy;
                    const yB = g.cy;
                    const y0 = Math.min(yA, yB) - END_PAD;
                    const y1 = Math.max(yA, yB) + END_PAD;
                    const ids = [wi.id, g.id];
                    if (Number.isFinite(x) && y1 > y0) {
                        const p: DimensionProposal = {
                            type: "Chain",
                            elements: ids,
                            description: `Wall repair (V) to grid: ${wi.id} ↔ ${g.id}`,
                            line: { p1: { x, y: y0, z: 0 }, p2: { x, y: y1, z: 0 } },
                            meta: { kind: "wall-repair", orientation: "V" },
                        };
                        if (addRepair(p)) { added++; continue; }
                    }
                }
            }
        }

        if (added > 0) {
            console.log(`Added ${added} wall-repair proposals (tried=${tried}, coverWalls=${coverInfos.length}).`);
        }
    } else {
        console.log("Skipping wall repair proposals (includeWallRepair=false).");
    }

    // --- Placement Logic ---
    mergedProposals.forEach(prop => {
        if (prop.line) return; // respect explicit placement (dense slice proposals)
        // Calculate Chain Properties
        // We need the elements to calculate bounding box of the chain
        const chainElements = prop.elements.map(id => {
            // Find element in loaded list
            return [...validWalls, ...validGrids].find(e => e.id === id);
        }).filter(e => e && e.geometry) as Element[];
        
        if (chainElements.length < 2) return;
        
        let cMinX = Infinity, cMaxX = -Infinity, cMinY = Infinity, cMaxY = -Infinity;
        chainElements.forEach(e => {
            cMinX = Math.min(cMinX, e.geometry!.p1.x, e.geometry!.p2.x);
            cMaxX = Math.max(cMaxX, e.geometry!.p1.x, e.geometry!.p2.x);
            cMinY = Math.min(cMinY, e.geometry!.p1.y, e.geometry!.p2.y);
            cMaxY = Math.max(cMaxY, e.geometry!.p1.y, e.geometry!.p2.y);
        });
        
        const cCenterX = (cMinX + cMaxX) / 2;
        const cCenterY = (cMinY + cMaxY) / 2;
        const width = cMaxX - cMinX;
        const height = cMaxY - cMinY;
        
        // Determine orientation based on referenced element direction.
        // If most referenced elements are vertical-ish, the dimension line should be horizontal (measuring X).
        // If most referenced elements are horizontal-ish, the dimension line should be vertical (measuring Y).
        let verticalish = 0;
        let horizontalish = 0;
        for (const e of chainElements) {
            if (!e.geometry) continue;
            const a = lineAngleDeg(e.geometry);
            if (isVerticalish(a)) verticalish++;
            if (isHorizontalish(a)) horizontalish++;
        }
        const dimLineIsHorizontal = verticalish !== horizontalish ? (verticalish > horizontalish) : (width > height);
        if (!prop.meta) prop.meta = { kind: "ml-merged" };
        if (!prop.meta.orientation) prop.meta.orientation = dimLineIsHorizontal ? "H" : "V";
        
        // Determine "Side" relative to building center
        const bCenterX = (minX + maxX) / 2;
        const bCenterY = (minY + maxY) / 2;
        
        // Check for Global vs Interior
        const hasExteriorWall = chainElements.some(e => e.name && e.name.toLowerCase().includes('exterior'));
        const hasGrid = chainElements.some(e => e.type === 'Grid');
        const kind = prop.meta?.kind ?? "unknown";
        const isGlobal =
            preset === "architect"
                ? (kind === "grid-chain" || kind === "overall")
                : (hasExteriorWall || hasGrid);
        
        let p1: Point, p2: Point;
        
        if (isGlobal) {
            const EXT_OFFSET = 15.0;
            if (dimLineIsHorizontal) {
                if (cCenterY > bCenterY) { // Top
                    const y = maxY + EXT_OFFSET;
                    p1 = { x: cMinX, y, z: 0 };
                    p2 = { x: cMaxX, y, z: 0 };
                } else { // Bottom
                    const y = minY - EXT_OFFSET;
                    p1 = { x: cMinX, y, z: 0 };
                    p2 = { x: cMaxX, y, z: 0 };
                }
            } else { // Vertical dimension line
                if (cCenterX < bCenterX) { // Left
                    const x = minX - EXT_OFFSET;
                    p1 = { x, y: cMinY, z: 0 };
                    p2 = { x, y: cMaxY, z: 0 };
                } else { // Right
                    const x = maxX + EXT_OFFSET;
                    p1 = { x, y: cMinY, z: 0 };
                    p2 = { x, y: cMaxY, z: 0 };
                }
            }
        } else {
            // Interior - Local Offset
            // Keeping this small reduces “plan-wide stripes”; the selection layer will still
            // distribute dims across tiles, but closer placement helps readability.
            const INT_OFFSET = 0.9; 
            if (dimLineIsHorizontal) {
                // Push Up (Y+)
                const y = cCenterY + INT_OFFSET; 
                p1 = { x: cMinX, y, z: 0 }; 
                p2 = { x: cMaxX, y, z: 0 };
            } else {
                // Push Left (X-)
                const x = cCenterX - INT_OFFSET;
                p1 = { x, y: cMinY, z: 0 }; 
                p2 = { x, y: cMaxY, z: 0 };
            }
        }
        
        prop.line = { p1, p2 };
    });

    // Normalize and validate proposals to reduce "Invalid number of references" failures and clutter.
    // - De-dup element ids while preserving order
    // - Remove missing/invalid walls
    // - Enforce wall orientation for H/V proposals (H dims reference vertical-ish walls; V dims reference horizontal-ish walls)
    // - Drop known-problematic wall categories (e.g. curtain walls) from candidates
    {
        const wallById = new Map<number, Element>();
        validWalls.forEach(w => wallById.set(w.id, w));
        const gridIdSet = new Set<number>(validGrids.map(g => g.id));
        const gridById = new Map<number, Element>();
        validGrids.forEach(g => gridById.set(g.id, g));

        const inferOrientation = (p: DimensionProposal): "H" | "V" | null => {
            if (p.line) {
                const dx = Math.abs(p.line.p2.x - p.line.p1.x);
                const dy = Math.abs(p.line.p2.y - p.line.p1.y);
                return dx >= dy ? "H" : "V";
            }
            if (p.meta?.orientation) return p.meta.orientation;
            return null;
        };

        const dedupPreserve = (ids: number[]) => {
            const out: number[] = [];
            const seen = new Set<number>();
            for (const id of ids) {
                if (!Number.isFinite(id)) continue;
                if (seen.has(id)) continue;
                seen.add(id);
                out.push(id);
            }
            return out;
        };

        const normalized: DimensionProposal[] = [];
        const seenSig = new Set<string>();
        const bad = loadBadRefs();
        if (bad.badWallIds.size > 0 || bad.badPairs.size > 0) {
            console.log(`Loaded bad refs: walls=${bad.badWallIds.size} pairs=${bad.badPairs.size} (${bad.path})`);
        }

        const pruneArchitectChain = (p: DimensionProposal, o: "H" | "V"): DimensionProposal => {
            const kind = p.meta?.kind ?? "unknown";
            if (preset !== "architect") return p;
            if (kind !== "ml-merged") return p;
            const ids = p.elements || [];
            if (ids.length <= 24) return p;

            const MAX_REFS = 24;
            const MIN_SPACING = 10.0; // ft (keeps strings human-scale)
            const COORD_DEDUP = 0.5; // ft

            const coordOf = (id: number) => {
                const isGrid = gridIdSet.has(id);
                const el = isGrid ? gridById.get(id) : wallById.get(id);
                const g = el?.geometry;
                if (!g) return null;
                const cx = (g.p1.x + g.p2.x) / 2;
                const cy = (g.p1.y + g.p2.y) / 2;
                const c = o === "H" ? cx : cy;
                if (!Number.isFinite(c)) return null;
                let pri = 0;
                // Grids are useful, but we already add explicit grid chains; don't let them dominate interior strings.
                if (isGrid) pri = 1;
                else {
                    const name = String(el?.name ?? "").toLowerCase();
                    const len = lineLen(g);
                    if (name.includes("exterior")) pri = 2;
                    else if (len >= 20) pri = 1;
                }
                return { id, c, pri };
            };

            // Build a coordinate-sorted, de-duplicated list (prefer higher priority at same coord).
            const byQ = new Map<number, { id: number; c: number; pri: number }>();
            for (const id of ids) {
                const e = coordOf(id);
                if (!e) continue;
                const q = Math.round(e.c / COORD_DEDUP);
                const prev = byQ.get(q);
                if (!prev || e.pri > prev.pri) byQ.set(q, e);
            }
            const entries = [...byQ.values()].sort((a, b) => a.c - b.c);
            if (entries.length <= 2) return p;

            const keep: { id: number; c: number; pri: number }[] = [];
            keep.push(entries[0]);
            for (let i = 1; i < entries.length - 1; i++) {
                const e = entries[i];
                const last = keep[keep.length - 1];
                if (e.pri >= 2) {
                    keep.push(e);
                    continue;
                }
                if (Math.abs(e.c - last.c) >= MIN_SPACING) keep.push(e);
            }
            keep.push(entries[entries.length - 1]);

            // Ensure we have at least 2.
            const uniqIds = [...new Set(keep.map(k => k.id))];
            if (uniqIds.length < 2) return p;

            // Cap to MAX_REFS by taking priority first, then evenly-spaced fill.
            let pruned = keep;
            if (pruned.length > MAX_REFS) {
                const pri2 = pruned.filter(e => e.pri >= 2);
                const pri0 = pruned.filter(e => e.pri < 2);
                const out: typeof pruned = [];
                // Always include extremes
                out.push(pruned[0]);
                for (const e of pri2) out.push(e);
                out.push(pruned[pruned.length - 1]);
                const outUniq = new Map<number, typeof pruned[number]>();
                for (const e of out) outUniq.set(e.id, e);
                const seeded = [...outUniq.values()].sort((a, b) => a.c - b.c);
                if (seeded.length >= MAX_REFS) {
                    pruned = seeded.slice(0, MAX_REFS);
                } else {
                    const need = MAX_REFS - seeded.length;
                    const step = pri0.length > 0 ? Math.max(1, Math.floor(pri0.length / Math.max(1, need))) : 999999;
                    const picks: typeof pruned = [];
                    for (let i = 0; i < pri0.length; i += step) picks.push(pri0[i]);
                    const merged = [...seeded, ...picks].sort((a, b) => a.c - b.c);
                    const ded = new Map<number, typeof pruned[number]>();
                    for (const e of merged) if (!ded.has(e.id)) ded.set(e.id, e);
                    pruned = [...ded.values()].slice(0, MAX_REFS);
                }
            }

            const newIds = pruned.map(e => e.id);
            return { ...p, elements: newIds, description: `${p.description} (pruned ${newIds.length}/${ids.length})` };
        };

        for (const p0 of mergedProposals) {
            const ids0 = dedupPreserve(p0.elements || []);
            if (ids0.length < 2) continue;

            const o = inferOrientation(p0);
            const ids1: number[] = [];
            for (const id of ids0) {
                if (gridIdSet.has(id)) {
                    ids1.push(id);
                    continue;
                }
                const w = wallById.get(id);
                if (!w?.geometry) continue;
                if (w.name && w.name.toLowerCase().includes("curtain")) continue;
                const a = lineAngleDeg(w.geometry);
                if (o === "H" && !isVerticalish(a)) continue;
                if (o === "V" && !isHorizontalish(a)) continue;
                if (lineLen(w.geometry) < MIN_WALL_LEN) continue;
                ids1.push(id);
            }
            if (ids1.length < 2) continue;

            const kind0 = p0.meta?.kind ?? "unknown";
            const badKinds = new Set(["adjacent", "tile-slice", "dense-slice", "room-span", "room-bbox"]);
            if (badKinds.has(kind0)) {
                const hasGrid = ids1.some(id => gridIdSet.has(id));
                if (!hasGrid) {
                    if (ids1.some(id => bad.badWallIds.has(id))) continue;
                    if (ids1.length === 2) {
                        const pair = ids1.slice().sort((a, b) => a - b).join(",");
                        if (bad.badPairs.has(`${kind0}|${pair}`)) continue;
                    }
                }
            }

            // For 2-ref wall dimensions, require walls to be close to parallel to avoid Revit "Invalid number of references".
            if (ids1.length === 2 && !gridIdSet.has(ids1[0]) && !gridIdSet.has(ids1[1])) {
                const w1 = wallById.get(ids1[0]);
                const w2 = wallById.get(ids1[1]);
                if (w1?.geometry && w2?.geometry) {
                    const a1 = lineAngleDeg(w1.geometry);
                    const a2 = lineAngleDeg(w2.geometry);
                    const da = Math.abs(a1 - a2);
                    const diff = Math.min(da, 180 - da);
                    if (diff > 3.0) continue;
                }
            }

            if (p0.line) {
                const dx = p0.line.p2.x - p0.line.p1.x;
                const dy = p0.line.p2.y - p0.line.p1.y;
                if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx * dx + dy * dy) < 1e-6) continue;
            }

            let p1: DimensionProposal = { ...p0, elements: ids1 };
            if (o) p1 = pruneArchitectChain(p1, o);
            const sig = proposalSignature(p1);
            if (seenSig.has(sig)) continue;
            seenSig.add(sig);
            normalized.push(p1);
        }

        mergedProposals.length = 0;
        mergedProposals.push(...normalized);
    }

    // --- Coverage-Driven Selection (avoid over-dimensioning) ---
        const selectProposals = (cands: DimensionProposal[]) => {
        // Coverage should focus on "meaningful" walls; tiny fragments (e.g. around doors/joins)
        // are numerous and not necessary to constrain the plan.
        const COVER_WALL_MIN_LEN = 4.0; // ft
        const TILE_WALL_MIN_LEN = 2.0; // ft (used only for tile-local sweep/repair)
        const coverWallIdSet = new Set(
            validWalls
                .filter(w => w.geometry && lineLen(w.geometry) >= COVER_WALL_MIN_LEN)
                .map(w => w.id)
        );
        const tileWallIdSet = new Set(
            validWalls
                .filter(w => w.geometry && lineLen(w.geometry) >= TILE_WALL_MIN_LEN)
                .map(w => w.id)
        );

        const planBox = (() => {
            let minX = Number.POSITIVE_INFINITY;
            let minY = Number.POSITIVE_INFINITY;
            let maxX = Number.NEGATIVE_INFINITY;
            let maxY = Number.NEGATIVE_INFINITY;
            let any = false;
            const all = [...validWalls, ...validGrids];
            for (const e of all) {
                const l = e.geometry;
                if (!l) continue;
                const xs = [l.p1.x, l.p2.x];
                const ys = [l.p1.y, l.p2.y];
                for (const x of xs) { if (!Number.isFinite(x)) continue; any = true; minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
                for (const y of ys) { if (!Number.isFinite(y)) continue; any = true; minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
            }
            if (!any) return null;
            return { minX, minY, maxX, maxY };
        })();

        const applyArchitectStackConstraints = (selected: DimensionProposal[]) => {
            if (preset !== "architect") return selected;
            if (!planBox) return selected;

            const GAP_FT = 3.0;
            const MAX_SNAP_FT = 6.0;
            const MAX_STACKS_PER_BAND = 3;

            const priority = (k: string) => {
                if (k === "overall") return 50;
                if (k === "grid-chain") return 45;
                if (k === "opening-locator") return 25;
                if (k === "wall-to-wall" || k === "wall-repair") return 20;
                if (k === "ml-merged") return 18;
                if (k === "dense-slice") return 8;
                if (k === "tile-slice") return 6;
                if (k === "adjacent") return 5;
                return 10;
            };

            const lineOrient = (p: DimensionProposal) => getOrientation(p);
            const lineCoord = (p: DimensionProposal, o: "H" | "V") => o === "H" ? (p.line?.p1.y ?? NaN) : (p.line?.p1.x ?? NaN);
            const sideFor = (p: DimensionProposal, o: "H" | "V") => {
                const c = lineCoord(p, o);
                if (!Number.isFinite(c)) return "mid";
                if (o === "H") {
                    if (c < planBox.minY - 0.5) return "min";
                    if (c > planBox.maxY + 0.5) return "max";
                    return "mid";
                }
                if (c < planBox.minX - 0.5) return "min";
                if (c > planBox.maxX + 0.5) return "max";
                return "mid";
            };

            const snap = (v: number, q: number) => Math.round(v / q) * q;
            const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
            const shiftTo = (p: DimensionProposal, o: "H" | "V", targetCoord: number) => {
                if (!p.line) return p;
                const c0 = lineCoord(p, o);
                if (!Number.isFinite(c0) || !Number.isFinite(targetCoord)) return p;
                const clampR = getShiftClamp(p, o);
                const target0 = clamp(targetCoord, c0 - MAX_SNAP_FT, c0 + MAX_SNAP_FT);
                const target = clampR ? clamp(target0, clampR.min, clampR.max) : target0;
                const delta = target - c0;
                if (Math.abs(delta) < 1e-6) return p;
                if (o === "H") {
                    return {
                        ...p,
                        line: {
                            p1: { ...p.line.p1, y: p.line.p1.y + delta },
                            p2: { ...p.line.p2, y: p.line.p2.y + delta },
                        },
                    };
                }
                return {
                    ...p,
                    line: {
                        p1: { ...p.line.p1, x: p.line.p1.x + delta },
                        p2: { ...p.line.p2, x: p.line.p2.x + delta },
                    },
                };
            };

            const v2: DimensionProposal[] = [];
            const keepSig = new Set<string>();
            for (const p of selected) {
                const k = String(p.meta?.kind ?? "");
                if (k === "room-span" || k === "room-bbox") continue;
                if (!p.line) continue;
                const o = lineOrient(p);
                if (!o) continue;
                const side = sideFor(p, o);
                if (side === "mid") continue;
                const ids = (p.elements ?? []).filter(n => Number.isFinite(n)).map(n => Number(n));
                const sig = `${k}|${ids.slice().sort((a, b) => a - b).join(",")}`;
                if (keepSig.has(sig)) continue;
                keepSig.add(sig);
                v2.push(p);
            }

            v2.sort((a, b) => {
                const ka = String(a.meta?.kind ?? "");
                const kb = String(b.meta?.kind ?? "");
                const pa = priority(ka);
                const pb = priority(kb);
                if (pa !== pb) return pb - pa;
                const sa = Number(a.meta?.mlScore ?? 0);
                const sb = Number(b.meta?.mlScore ?? 0);
                if (sb !== sa) return sb - sa;
                return (getSpan(a) ?? Infinity) - (getSpan(b) ?? Infinity);
            });

            // Choose a small set of stack coordinates per outside band (min/max per orientation).
            const stacksByBand = new Map<string, number[]>(); // bandKey => stackCoords[]
            {
                type StackInfo = { coord: number; weight: number; count: number; hasAnchor: boolean };
                const bandToStacks = new Map<string, Map<number, StackInfo>>();

                for (const p of v2) {
                    const k = String(p.meta?.kind ?? "");
                    const o = lineOrient(p);
                    if (!o || !p.line) continue;
                    const side = sideFor(p, o);
                    if (side === "mid") continue;
                    const coord = lineCoord(p, o);
                    if (!Number.isFinite(coord)) continue;

                    const bandKey = `${o}|${side}`;
                    if (!bandToStacks.has(bandKey)) bandToStacks.set(bandKey, new Map());
                    const stacks = bandToStacks.get(bandKey)!;

                    const coordQ = snap(coord, 1.0);
                    const w = priority(k) * 100 + Number(p.meta?.mlScore ?? 0) * 400;
                    const prev = stacks.get(coordQ) ?? { coord: coordQ, weight: 0, count: 0, hasAnchor: false };
                    prev.weight += w;
                    prev.count += 1;
                    const ids = (p.elements ?? []).filter(n => Number.isFinite(n)).map(n => Number(n));
                    const hasGrid = ids.some((id) => gridIdSet.has(id));
                    if (k === "overall" || k === "grid-chain" || (k === "ml-merged" && hasGrid)) prev.hasAnchor = true;
                    stacks.set(coordQ, prev);
                }

                for (const [bandKey, stacks] of bandToStacks.entries()) {
                    const list = [...stacks.values()];
                    if (list.length === 0) continue;

                    const parts = bandKey.split("|");
                    const side = (parts[1] as ("min" | "max")) ?? "mid";
                    const outerToInner = (a: StackInfo, b: StackInfo) => side === "min" ? (a.coord - b.coord) : (b.coord - a.coord);

                    // Prefer an "anchor" stack (overall/grid) at the outside edge.
                    const anchors = list.filter((s) => s.hasAnchor);
                    anchors.sort((a, b) => {
                        const oa = outerToInner(a, b);
                        if (oa !== 0) return oa;
                        return b.weight - a.weight;
                    });
                    const chosen: StackInfo[] = [];
                    if (anchors.length > 0) chosen.push(anchors[0]);
                    else {
                        list.sort((a, b) => b.weight - a.weight);
                        chosen.push(list[0]);
                    }

                    // Add remaining stacks by weight, respecting minimum separation.
                    const remaining = list
                        .filter((s) => !chosen.some((c) => Math.abs(c.coord - s.coord) < 0.25))
                        .sort((a, b) => b.weight - a.weight);

                    for (const s of remaining) {
                        if (chosen.length >= MAX_STACKS_PER_BAND) break;
                        if (chosen.some((c) => Math.abs(c.coord - s.coord) < GAP_FT)) continue;
                        chosen.push(s);
                    }

                    // Sort outer->inner for deterministic snapping.
                    chosen.sort((a, b) => outerToInner(a, b));
                    stacksByBand.set(bandKey, chosen.map((s) => s.coord));
                }
            }

            const wallUse = new Map<number, number>();
            const gridUse = new Map<number, number>();
            const openingUse = new Set<number>();
            const stackUse = new Map<string, number>(); // `${bandKey}|${coord}` => count

            const covWalls = new Set<number>();
            const covGrids = new Set<number>();
            const covOpenings = new Set<number>();

            const kept = new Set<DimensionProposal>();
            const replaced = new Map<DimensionProposal, DimensionProposal>();

            const candidates = v2.map((p) => {
                const k = String(p.meta?.kind ?? "");
                const o = lineOrient(p);
                const coord = o && p.line ? lineCoord(p, o) : NaN;
                const side = o ? sideFor(p, o) : "mid";
                const bandKey = o ? `${o}|${side}` : "none";
                const ids = (p.elements ?? []).filter(n => Number.isFinite(n)).map(n => Number(n));
                const wallIds = ids.filter(id => coverWallIdSet.has(id));
                const gridIds = ids.filter(id => gridIdSet.has(id));
                const openingId = k === "opening-locator" ? (ids.find(id => !coverWallIdSet.has(id) && !gridIdSet.has(id)) ?? null) : null;

                let stackCoord: number | null = null;
                let pShifted: DimensionProposal = p;
                if (o && side !== "mid" && Number.isFinite(coord)) {
                    const stacks = stacksByBand.get(bandKey) ?? [];
                    if (stacks.length > 0) {
                        let best = stacks[0];
                        let bestD = Math.abs(best - coord);
                        for (const sc of stacks) {
                            const d = Math.abs(sc - coord);
                            if (d < bestD) { bestD = d; best = sc; }
                        }
                        if (bestD <= MAX_SNAP_FT + 0.25) {
                            stackCoord = best;
                            pShifted = shiftTo(p, o, best);
                        }
                    }
                }

                return {
                    p,
                    pShifted,
                    k,
                    o,
                    side,
                    bandKey,
                    coord,
                    stackCoord,
                    ml: Number(p.meta?.mlScore ?? 0),
                    span: Number(getSpan(p) ?? Infinity),
                    wallIds,
                    gridIds,
                    openingId,
                };
            }).filter((c) => c.o && c.p.line && c.side !== "mid" && Number.isFinite(c.coord));

            const stackKeyFor = (c: any) => (c.side !== "mid" && Number.isFinite(c.stackCoord)) ? `${c.bandKey}|${c.stackCoord}` : null;
            const capFor = (k: string) =>
                k === "overall" ? 6 :
                    k === "grid-chain" ? 10 :
                        k === "opening-locator" ? 12 :
                            (k === "wall-to-wall" || k === "wall-repair") ? 18 :
                                (k === "dense-slice" || k === "tile-slice" || k === "adjacent") ? 10 :
                            18;

            const MAX_KEEP = 80;
            const remaining = new Set<number>(candidates.map((_, i) => i));
            const keptShiftedSig = new Set<string>();

            while (kept.size < MAX_KEEP && remaining.size > 0) {
                let bestIdx: number | null = null;
                let bestScore = -Infinity;

                for (const idx of remaining) {
                    const c = candidates[idx];
                    if (!c) continue;

                    if (c.stackCoord == null) continue;
                    if (keptShiftedSig.has(proposalSignature(c.pShifted))) continue;

                    // per-stack cap
                    const sk = stackKeyFor(c);
                    if (sk) {
                        const used = stackUse.get(sk) ?? 0;
                        if (used >= capFor(c.k)) continue;
                    }

                    // budgets (per-element)
                    if (c.wallIds.length > 0 && (c.k === "wall-to-wall" || c.k === "wall-repair" || c.k === "overall" || c.k === "ml-merged")) {
                        let ok = true;
                        for (const wid of c.wallIds) {
                            if ((wallUse.get(wid) ?? 0) >= 4) { ok = false; break; }
                        }
                        if (!ok) continue;
                    }
                    if (c.gridIds.length > 0 && (c.k === "grid-chain" || c.k === "ml-merged")) {
                        let ok = true;
                        for (const gid of c.gridIds) {
                            if ((gridUse.get(gid) ?? 0) >= 2) { ok = false; break; }
                        }
                        if (!ok) continue;
                    }
                    if (c.k === "opening-locator" && c.openingId != null) {
                        if (openingUse.has(c.openingId)) continue;
                    }

                    // marginal coverage gain
                    let gainWalls = 0;
                    for (const wid of c.wallIds) if (!covWalls.has(wid)) gainWalls++;
                    let gainGrids = 0;
                    for (const gid of c.gridIds) if (!covGrids.has(gid)) gainGrids++;
                    const gainOpen = c.openingId != null && !covOpenings.has(c.openingId) ? 1 : 0;

                    const introducesStack = sk ? !stackUse.has(sk) : false;
                    const stackPenalty = introducesStack ? 900 : 0;

                    const score =
                        priority(c.k) * 1000 +
                        c.ml * 3000 +
                        gainWalls * 250 +
                        gainGrids * 450 +
                        gainOpen * 800 -
                        stackPenalty -
                        (Number.isFinite(c.span) ? c.span * 0.4 : 0);

                    if (score > bestScore) {
                        bestScore = score;
                        bestIdx = idx;
                    }
                }

                if (bestIdx == null) break;
                const c = candidates[bestIdx];
                remaining.delete(bestIdx);
                if (!c) continue;
                if (bestScore < 0 && kept.size > 8) break;

                const sk = stackKeyFor(c);
                if (sk) stackUse.set(sk, (stackUse.get(sk) ?? 0) + 1);
                keptShiftedSig.add(proposalSignature(c.pShifted));
                if (c.k === "opening-locator" && c.openingId != null) openingUse.add(c.openingId);
                for (const wid of c.wallIds) { wallUse.set(wid, (wallUse.get(wid) ?? 0) + 1); covWalls.add(wid); }
                for (const gid of c.gridIds) { gridUse.set(gid, (gridUse.get(gid) ?? 0) + 1); covGrids.add(gid); }
                if (c.openingId != null) covOpenings.add(c.openingId);

                kept.add(c.p);
                replaced.set(c.p, c.pShifted);
            }

            const v2Set = new Set<DimensionProposal>(v2);
            // Preserve original ordering; only drop out-of-stack outside candidates.
            return selected
                .filter((p) => !v2Set.has(p) || kept.has(p))
                .map((p) => replaced.get(p) ?? p);
        };

        const getOrientation = (p: DimensionProposal): "H" | "V" | null => {
            if (p.line) {
                const dx = Math.abs(p.line.p2.x - p.line.p1.x);
                const dy = Math.abs(p.line.p2.y - p.line.p1.y);
                return dx >= dy ? "H" : "V";
            }
            if (p.meta?.orientation) return p.meta.orientation;
            return null;
        };

        const getSpan = (p: DimensionProposal) => {
            if (!p.line) return Infinity;
            const dx = p.line.p2.x - p.line.p1.x;
            const dy = p.line.p2.y - p.line.p1.y;
            return Math.sqrt(dx * dx + dy * dy);
        };

        const stripeKey = (p: DimensionProposal) => {
            const o = getOrientation(p);
            if (!o || !p.line) return "none";
            const kind = p.meta?.kind ?? "unknown";
            const isRoom = kind === "room-span" || kind === "room-bbox";
            const group = isRoom ? "R" : kind === "wall-repair" ? "W" : "O";
            const coord = o === "H" ? p.line.p1.y : p.line.p1.x;
            const qCoord = isRoom ? 1.0 : 6.0; // ft
            const snappedCoord = Math.round(coord / qCoord) * qCoord;

            // Split long "global" stripes into coarse segments so we can place dimensions in different areas
            // without them competing for the same stripe budget.
            const midAlong = o === "H"
                ? (p.line.p1.x + p.line.p2.x) / 2
                : (p.line.p1.y + p.line.p2.y) / 2;
            const qSeg = isRoom ? 25.0 : 30.0; // ft
            const seg = Math.round(midAlong / qSeg) * qSeg;

            return `${group}:${o}:${snappedCoord}:${seg}`;
        };

        const tileKey = (p: DimensionProposal) => {
            if (!p.line) return "none";
            const kind = p.meta?.kind ?? "unknown";
            const isRoom = kind === "room-span" || kind === "room-bbox";
            const group = isRoom ? "R" : kind === "wall-repair" ? "W" : "O";
            const mx = (p.line.p1.x + p.line.p2.x) / 2;
            const my = (p.line.p1.y + p.line.p2.y) / 2;
            if (!Number.isFinite(mx) || !Number.isFinite(my)) return "none";
            const TILE = 50.0; // ft
            const ix = Math.floor((mx - minX) / TILE);
            const iy = Math.floor((my - minY) / TILE);
            return `T${group}:${ix},${iy}`;
        };

        const gridIdSet = new Set<number>(validGrids.map(g => g.id));
        const wallIdsFor = (p: DimensionProposal) => p.elements.filter(id => coverWallIdSet.has(id));
        const roomIdsFor = (p: DimensionProposal) => p.meta?.roomIds ?? (typeof p.meta?.roomId === "number" ? [p.meta.roomId] : []);
        const roomOrientationFor = (p: DimensionProposal) => {
            const ids = roomIdsFor(p);
            if (ids.length === 0) return null as ("H" | "V" | null);
            return getOrientation(p);
        };

        const roomHasH = new Set<number>();
        const roomHasV = new Set<number>();
        if (enforceRoomConstraints) {
            cands.forEach(p => {
                const ids = roomIdsFor(p);
                if (ids.length === 0) return;
                const o = roomOrientationFor(p);
                if (o === "H") ids.forEach(id => roomHasH.add(id));
                if (o === "V") ids.forEach(id => roomHasV.add(id));
            });
        }

        const roomIds = new Set<number>([...roomHasH, ...roomHasV]);

        // We want at least one horizontal and one vertical constraint per room when candidates exist.
        const roomNeedH = enforceRoomConstraints ? new Set<number>(roomHasH) : new Set<number>();
        const roomNeedV = enforceRoomConstraints ? new Set<number>(roomHasV) : new Set<number>();

        const coveredWalls = new Set<number>();
        // Seed coverage with already-dimensioned walls in this view (if any).
        for (const id of initiallyCoveredWallIds) {
            if (coverWallIdSet.has(id)) coveredWalls.add(id);
        }
        const stripeCounts = new Map<string, number>();
        const tileCounts = new Map<string, number>();

        const BASE_SOFT_MAX = Math.min(440, Math.max(240, roomIds.size * 2 + 16));
        const BASE_HARD_MAX = Math.min(520, BASE_SOFT_MAX + 120);
        const HARD_MAX = typeof maxDimensions === "number" ? Math.max(40, Math.min(520, maxDimensions)) : BASE_HARD_MAX;
        const SOFT_MAX = typeof maxDimensions === "number" ? HARD_MAX : BASE_SOFT_MAX;
        const MAX_PER_STRIPE = preset === "architect" ? 4 : 10;
        const MAX_PER_STRIPE_REPAIR = preset === "architect" ? 6 : 14;
        // When we're below coverage targets, allow a small, *bounded* overflow beyond per-stripe/per-tile caps,
        // but only for candidates that add meaningful new coverage. This prevents the selection loop from getting
        // "stuck" with uncovered walls remaining solely due to local stripe pressure.
        const SUPER_STRIPE_CAP = 22;
        const SUPER_TILE_CAP = 34;
        const MIN_NEW_WALLS_FOR_CAP_OVERRIDE = 1;
        const MAX_SPAN_FOR_CAP_OVERRIDE = 120;
        const MAX_ELEMS_FOR_CAP_OVERRIDE = 10;
        // Target wall coverage is a proxy for "enough constraints to reconstruct the plan".
        // Pushing too high tends to create stripes/clutter; we'll stop once we hit this.
        // With "cover walls" (>=4ft), we can aim higher without forcing dimensions on tiny fragments.
        // Higher target increases "adequacy" (more constraints) while stripe caps prevent global clutter.
        const TARGET_WALL_COVERAGE = targetWallCoverage;

        const pre = cands.map(p => ({
            p,
            o: getOrientation(p),
            s: stripeKey(p),
            t: tileKey(p),
            span: getSpan(p),
            walls: wallIdsFor(p),
            tileWalls: (p.elements || []).filter(id => tileWallIdSet.has(id)),
            hasGrid: p.elements.some(id => gridIdSet.has(id)),
            mlP: null as (number | null),
        }));

        // Add v2 model probability for a small subset of proposal kinds (anchors + wall repair).
        if (preset === "architect" && classifierV2) {
            const geomById = new Map<number, Line>();
            validWalls.forEach(w => { if (w.geometry) geomById.set(w.id, w.geometry); });
            validGrids.forEach(g => { if (g.geometry) geomById.set(g.id, g.geometry); });
            const globalBox = (() => {
                let minX = Number.POSITIVE_INFINITY;
                let minY = Number.POSITIVE_INFINITY;
                let maxX = Number.NEGATIVE_INFINITY;
                let maxY = Number.NEGATIVE_INFINITY;
                let any = false;
                for (const l of geomById.values()) {
                    const xs = [l.p1.x, l.p2.x];
                    const ys = [l.p1.y, l.p2.y];
                    for (const x of xs) { if (!Number.isFinite(x)) continue; any = true; minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
                    for (const y of ys) { if (!Number.isFinite(y)) continue; any = true; minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
                }
                if (!any) return null;
                return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
            })();

            const bboxForIds = (ids: number[]) => {
                let minX = Number.POSITIVE_INFINITY;
                let minY = Number.POSITIVE_INFINITY;
                let maxX = Number.NEGATIVE_INFINITY;
                let maxY = Number.NEGATIVE_INFINITY;
                let any = false;
                for (const id of ids) {
                    const l = geomById.get(id);
                    if (!l) continue;
                    const xs = [l.p1.x, l.p2.x];
                    const ys = [l.p1.y, l.p2.y];
                    for (const x of xs) { if (!Number.isFinite(x)) continue; any = true; minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
                    for (const y of ys) { if (!Number.isFinite(y)) continue; any = true; minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
                }
                if (!any) return null;
                return { minX, minY, maxX, maxY };
            };

            const lineLength = (l: Line) => {
                const dx = l.p2.x - l.p1.x;
                const dy = l.p2.y - l.p1.y;
                return Math.sqrt(dx * dx + dy * dy);
            };

            const absDotLine = (a: Line, b: Line) => {
                const ax = a.p2.x - a.p1.x;
                const ay = a.p2.y - a.p1.y;
                const bx = b.p2.x - b.p1.x;
                const by = b.p2.y - b.p1.y;
                const la = Math.sqrt(ax * ax + ay * ay);
                const lb = Math.sqrt(bx * bx + by * by);
                if (!Number.isFinite(la) || !Number.isFinite(lb) || la < 1e-9 || lb < 1e-9) return 0;
                return Math.abs((ax * bx + ay * by) / (la * lb));
            };

            const perpDistBetweenParallelLines = (a: Line, b: Line) => {
                // Distance from b.p1 to line a.
                const ax = a.p2.x - a.p1.x;
                const ay = a.p2.y - a.p1.y;
                const den = Math.sqrt(ax * ax + ay * ay);
                if (!Number.isFinite(den) || den < 1e-9) return null;
                const nx = -ay / den;
                const ny = ax / den;
                const dx = b.p1.x - a.p1.x;
                const dy = b.p1.y - a.p1.y;
                const d = Math.abs(dx * nx + dy * ny);
                return Number.isFinite(d) ? d : null;
            };

            const intervalOverlap = (a0: number, a1: number, b0: number, b1: number) => {
                const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1));
                const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
                return Math.max(0, hi - lo);
            };

            const predictProbV2 = (kind: string, features: number[]) => {
                try {
                    if (classifierV2.type === "bundle") {
                        const m = classifierV2.models[kind];
                        if (!m) return null;
                        // @ts-ignore - predictProbability is available in v2 but might not be in types
                        const probs = m.predictProbability([features], 1);
                        const p = probs?.[0];
                        return Number.isFinite(p) ? p : null;
                    }
                    // @ts-ignore - predictProbability is available in v2 but might not be in types
                    const probs = classifierV2.model.predictProbability([features], 1);
                    const p = probs?.[0];
                    return Number.isFinite(p) ? p : null;
                } catch {
                    return null;
                }
            };

            const toFeatureVector = (item: typeof pre[number]) => {
                const kind0 = item.p.meta?.kind ?? "unknown";
                const mlKind =
                    kind0 === "grid-chain" ? "grid-chain" :
                        kind0 === "overall" ? "overall" :
                            kind0 === "wall-repair" ? "wall-to-wall" :
                                null;
                if (!mlKind || !item.p.line) return null;

                const kindOneHot = [
                    mlKind === "grid-chain" ? 1 : 0,
                    mlKind === "overall" ? 1 : 0,
                    mlKind === "wall-to-wall" ? 1 : 0,
                    0,
                ];

                const dx = Math.abs(item.p.line.p2.x - item.p.line.p1.x);
                const dy = Math.abs(item.p.line.p2.y - item.p.line.p1.y);
                const orient = dx >= dy ? "horizontal" : "vertical";
                const orientOneHot = [orient === "horizontal" ? 1 : 0, orient === "vertical" ? 1 : 0];

                const ids = item.p.elements ?? [];
                const refPositions: number[] = [];
                for (const id of ids) {
                    const l = geomById.get(id);
                    if (!l) continue;
                    const mx = (l.p1.x + l.p2.x) / 2;
                    const my = (l.p1.y + l.p2.y) / 2;
                    const v = orient === "horizontal" ? mx : my;
                    if (Number.isFinite(v)) refPositions.push(v);
                }
                let refSpan = 0;
                if (refPositions.length >= 2) {
                    let minV = Number.POSITIVE_INFINITY;
                    let maxV = Number.NEGATIVE_INFINITY;
                    for (const v of refPositions) { minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
                    refSpan = Math.max(0, maxV - minV);
                }

                const bb = bboxForIds(ids);
                let offsetAbs = 0;
                if (bb) {
                    if (orient === "horizontal") {
                        const y = item.p.line.p1.y;
                        offsetAbs = Math.min(Math.abs(y - bb.minY), Math.abs(y - bb.maxY));
                    } else {
                        const x = item.p.line.p1.x;
                        offsetAbs = Math.min(Math.abs(x - bb.minX), Math.abs(x - bb.maxX));
                    }
                }

                const hasGrid = item.hasGrid;
                const hasWall = item.walls.length > 0;
                const hasOpening = false;

                // Order: gridLine, wallFaceExterior, wallFaceInterior, wallCoreFaceExterior, wallCoreFaceInterior, wallCenterline,
                // openingEdgeLeft, openingEdgeRight, openingCenter, openingRef
                let gridCount = 0;
                let wallCount = 0;
                for (const id of ids) {
                    if (gridIdSet.has(id)) gridCount++;
                    else if (coverWallIdSet.has(id)) wallCount++;
                }
                const refKindVec = [
                    gridCount,
                    wallCount, // wallFaceExterior
                    0, 0, 0, 0,
                    0, 0, 0, 0
                ];

                const L = lineLength(item.p.line);
                const viewSpan = globalBox ? (orient === "horizontal" ? globalBox.w : globalBox.h) : 0;
                const lineLenToView = viewSpan > 1e-6 ? L / viewSpan : 0;

                // We don't have v2 style offsets here; use typical architectural stack defaults.
                const p50 = 6.0;
                const p90 = 18.0;
                const offsets = [6.0, 12.0, 18.0, 24.0];

                const offsetRelP50 = p50 > 1e-6 ? offsetAbs / p50 : 0;
                const offsetRelP90 = p90 > 1e-6 ? offsetAbs / p90 : 0;
                let best = Number.POSITIVE_INFINITY;
                for (const o of offsets) best = Math.min(best, Math.abs(offsetAbs - o));
                const offsetNearestRelP50 = Number.isFinite(best) ? best / p50 : 0;

                let isOutsideMin = 0;
                let isOutsideMax = 0;
                if (bb) {
                    const lineCoord = orient === "horizontal" ? item.p.line.p1.y : item.p.line.p1.x;
                    const minV = orient === "horizontal" ? bb.minY : bb.minX;
                    const maxV = orient === "horizontal" ? bb.maxY : bb.maxX;
                    if (Number.isFinite(lineCoord) && Number.isFinite(minV) && lineCoord < minV) isOutsideMin = 1;
                    if (Number.isFinite(lineCoord) && Number.isFinite(maxV) && lineCoord > maxV) isOutsideMax = 1;
                }

                let pairPerpDist = 0;
                let pairOverlap = 0;
                let partnerIsGrid = 0;
                let partnerIsWall = 0;
                if (ids.length === 2) {
                    const l0 = geomById.get(ids[0]);
                    const l1 = geomById.get(ids[1]);
                    if (l0 && l1 && absDotLine(l0, l1) >= 0.99) {
                        const d = perpDistBetweenParallelLines(l0, l1);
                        if (typeof d === "number") pairPerpDist = d;
                    }
                    const b0 = bboxForIds([ids[0]]);
                    const b1 = bboxForIds([ids[1]]);
                    if (b0 && b1) {
                        pairOverlap = orient === "horizontal"
                            ? intervalOverlap(b0.minY, b0.maxY, b1.minY, b1.maxY)
                            : intervalOverlap(b0.minX, b0.maxX, b1.minX, b1.maxX);
                    }
                    if (gridIdSet.has(ids[0]) || gridIdSet.has(ids[1])) partnerIsGrid = 1;
                    if (coverWallIdSet.has(ids[0]) || coverWallIdSet.has(ids[1])) partnerIsWall = 1;
                }

                return [
                    ...kindOneHot,
                    ids.length,
                    refSpan,
                    offsetAbs,
                    ...orientOneHot,
                    hasGrid ? 1 : 0,
                    hasWall ? 1 : 0,
                    hasOpening ? 1 : 0,
                    ...refKindVec,
                    L,
                    lineLenToView,
                    offsetRelP50,
                    offsetRelP90,
                    offsetNearestRelP50,
                    isOutsideMin,
                    isOutsideMax,
                    pairPerpDist,
                    pairOverlap,
                    0, // openToPartnerDist
                    0, // openHostMatch
                    partnerIsGrid,
                    partnerIsWall,
                ];
            };

            for (const item of pre) {
                const features = toFeatureVector(item);
                if (!features) continue;
                const rawKind = String(item.p.meta?.kind ?? "");
                const kindV2 = rawKind === "wall-repair" ? "wall-to-wall" : rawKind;
                const v2Kinds = new Set(["grid-chain", "overall", "wall-to-wall", "opening-locator"]);
                if (!v2Kinds.has(kindV2)) continue;
                if (classifierV2.type === "bundle" && !classifierV2.models[kindV2]) continue;
                item.mlP = predictProbV2(kindV2, features);
                if (typeof item.mlP === "number" && item.p.meta) item.p.meta.mlScore = item.mlP;
            }
        }

        const remaining = new Set<number>(pre.map((_, i) => i));
        const selected: DimensionProposal[] = [];
        const signature = (p: DimensionProposal) => proposalSignature(p);
        const selectedSigs = new Set<string>();
        const isRoomProposal = (p: DimensionProposal) => p.meta?.kind === "room-span" || p.meta?.kind === "room-bbox";
        const isCorridorProposal = (p: DimensionProposal) =>
            isRoomProposal(p) && String(p.description ?? "").startsWith("CorridorWidth(");
        const MAX_ROOM_DIMS_ARCH = 18;
        const MAX_CORRIDOR_DIMS_ARCH = 12;
        let selectedRoomDims = 0;
        let selectedCorridorDims = 0;

        const maxStripeFor = (idx: number) => {
            const item = pre[idx];
            const kind = item.p.meta?.kind ?? "unknown";
            if (enforceRoomConstraints && (item.p.meta?.kind === "room-span" || item.p.meta?.kind === "room-bbox") && item.o) {
                const ids = item.p.meta.roomIds ?? (typeof item.p.meta.roomId === "number" ? [item.p.meta.roomId] : []);
                const needs = item.o === "H" ? roomNeedH : roomNeedV;
                const coversNeed = ids.some(id => needs.has(id));
                if (coversNeed) return MAX_PER_STRIPE_REPAIR;
            }
            // Dense slices are already capped in generation; allow a bit more per stripe to improve recall.
            if (kind === "dense-slice") return preset === "architect" ? 4 : 8;
            if (kind === "tile-slice") return preset === "architect" ? 6 : 12;
            if (kind === "adjacent") return preset === "architect" ? 6 : 12;
            if (kind === "wall-repair") return preset === "architect" ? 5 : 8;
            return MAX_PER_STRIPE;
        };

        const maxTileFor = (idx: number) => {
            const item = pre[idx];
            const kind = item.p.meta?.kind ?? "unknown";
            if (enforceRoomConstraints && (item.p.meta?.kind === "room-span" || item.p.meta?.kind === "room-bbox") && item.o) {
                const ids = item.p.meta.roomIds ?? (typeof item.p.meta.roomId === "number" ? [item.p.meta.roomId] : []);
                const needs = item.o === "H" ? roomNeedH : roomNeedV;
                const coversNeed = ids.some(id => needs.has(id));
                if (coversNeed) return 48;
                return 22;
            }
            if (kind === "dense-slice") return preset === "architect" ? 10 : 16;
            if (kind === "tile-slice") return preset === "architect" ? 10 : 20;
            if (kind === "adjacent") return preset === "architect" ? 10 : 20;
            if (kind === "wall-repair") return preset === "architect" ? 14 : 24;
            return 18;
        };

        const canPlace = (idx: number) => {
            if (preset === "architect") {
                const p = pre[idx].p;
                if (isRoomProposal(p)) {
                    if (isCorridorProposal(p)) {
                        if (selectedCorridorDims >= MAX_CORRIDOR_DIMS_ARCH) return false;
                    } else {
                        if (selectedRoomDims >= MAX_ROOM_DIMS_ARCH) return false;
                    }
                }
            }
            // Hard cap: after a room has its H/V span, don't keep adding more room-span constraints (they create stripes).
            const item0 = pre[idx];
            if (enforceRoomConstraints && (item0.p.meta?.kind === "room-span" || item0.p.meta?.kind === "room-bbox") && item0.o) {
                const ids = item0.p.meta.roomIds ?? (typeof item0.p.meta.roomId === "number" ? [item0.p.meta.roomId] : []);
                const needs = item0.o === "H" ? roomNeedH : roomNeedV;
                const coversNeed = ids.some(id => needs.has(id));
                if (!coversNeed) return false;

                // If this dimension covers at least one still-uncovered room in this orientation, allow it even if
                // stripe/tile caps would block it. Collisions are preferable to missing constraints.
                return true;
            }

            const item = pre[idx];
            const s = item.s;
            const t = item.t;

            if (s === "none") return true;

            const stripeCount = stripeCounts.get(s) ?? 0;
            const tileCount = t !== "none" ? (tileCounts.get(t) ?? 0) : 0;

            const stripeOk = stripeCount < maxStripeFor(idx);
            const tileOk = t === "none" || tileCount < maxTileFor(idx);
            if (stripeOk && tileOk) return true;

            // Coverage-driven override: if we're under the wall coverage target, allow a bounded overflow
            // beyond per-stripe/per-tile limits for candidates that add new "cover wall" constraints.
            const wallCoverage = coveredWalls.size / Math.max(1, coverWallIdSet.size);
            const needMoreWalls = wallCoverage < TARGET_WALL_COVERAGE;
            if (!needMoreWalls) return false;

            if (!Number.isFinite(item.span) || item.span > MAX_SPAN_FOR_CAP_OVERRIDE) return false;
            if (item.p.elements.length > MAX_ELEMS_FOR_CAP_OVERRIDE) return false;

            let newWalls = 0;
            for (const w of item.walls) if (!coveredWalls.has(w)) newWalls++;
            if (newWalls < MIN_NEW_WALLS_FOR_CAP_OVERRIDE) return false;

            if (stripeCount >= SUPER_STRIPE_CAP) return false;
            if (t !== "none" && tileCount >= SUPER_TILE_CAP) return false;

            return true;
        };

        const take = (idx: number) => {
            const item = pre[idx];
            selected.push(item.p);
            selectedSigs.add(signature(item.p));
            remaining.delete(idx);
            item.walls.forEach(w => coveredWalls.add(w));
            if (preset === "architect" && isRoomProposal(item.p)) {
                if (isCorridorProposal(item.p)) selectedCorridorDims++;
                else selectedRoomDims++;
            }
            {
                const ids = roomIdsFor(item.p);
                const o = roomOrientationFor(item.p);
                if (o === "H") ids.forEach(id => roomNeedH.delete(id));
                if (o === "V") ids.forEach(id => roomNeedV.delete(id));
            }
            const s = stripeKey(item.p);
            if (s !== "none") stripeCounts.set(s, (stripeCounts.get(s) ?? 0) + 1);
            const t = tileKey(item.p);
            if (t !== "none") tileCounts.set(t, (tileCounts.get(t) ?? 0) + 1);
        };

        const takeAs = (idx: number, cand: DimensionProposal) => {
            const item = pre[idx];
            const sig = signature(cand);
            if (selectedSigs.has(sig)) return false;

            selected.push(cand);
            selectedSigs.add(sig);
            remaining.delete(idx);
            item.walls.forEach(w => coveredWalls.add(w));
            if (preset === "architect" && isRoomProposal(cand)) {
                if (isCorridorProposal(cand)) selectedCorridorDims++;
                else selectedRoomDims++;
            }
            {
                const ids = roomIdsFor(cand);
                const o = roomOrientationFor(cand);
                if (o === "H") ids.forEach(id => roomNeedH.delete(id));
                if (o === "V") ids.forEach(id => roomNeedV.delete(id));
            }
            const s = stripeKey(cand);
            if (s !== "none") stripeCounts.set(s, (stripeCounts.get(s) ?? 0) + 1);
            const t = tileKey(cand);
            if (t !== "none") tileCounts.set(t, (tileCounts.get(t) ?? 0) + 1);
            return true;
        };

        const cloneShifted = (p: DimensionProposal, o: "H" | "V", delta: number): DimensionProposal => {
            if (!p.line) return p;
            if (o === "H") {
                return {
                    ...p,
                    line: {
                        p1: { ...p.line.p1, y: p.line.p1.y + delta },
                        p2: { ...p.line.p2, y: p.line.p2.y + delta }
                    }
                };
            }
            return {
                ...p,
                line: {
                    p1: { ...p.line.p1, x: p.line.p1.x + delta },
                    p2: { ...p.line.p2, x: p.line.p2.x + delta }
                }
            };
        };

        const wallByIdLocal = new Map<number, Element>(validWalls.map(w => [w.id, w]));
        const getShiftClamp = (p: DimensionProposal, o: "H" | "V") => {
            if (!p.line) return null;
            let min = -Infinity;
            let max = Infinity;
            let haveAny = false;
            for (const id of p.elements ?? []) {
                const w = wallByIdLocal.get(id);
                const g = w?.geometry;
                if (!g) continue;
                const a0 = o === "H" ? Math.min(g.p1.y, g.p2.y) : Math.min(g.p1.x, g.p2.x);
                const a1 = o === "H" ? Math.max(g.p1.y, g.p2.y) : Math.max(g.p1.x, g.p2.x);
                if (!Number.isFinite(a0) || !Number.isFinite(a1)) continue;
                haveAny = true;
                if (a0 > min) min = a0;
                if (a1 < max) max = a1;
            }
            if (!haveAny) return null;
            if (!(max > min + 0.75)) return null;
            return { min: min + 0.35, max: max - 0.35 };
        };

        // Always include a small set of low-clutter anchors when available.
        {
            const anchors = pre
                .map((v, i) => ({ v, i }))
                .filter(x => x.v.p.meta?.kind === "grid-chain" || x.v.p.meta?.kind === "overall")
                .sort((a, b) => {
                    const ka = a.v.p.meta?.kind ?? "";
                    const kb = b.v.p.meta?.kind ?? "";
                    if (ka !== kb) return ka.localeCompare(kb);
                    return a.v.span - b.v.span;
                })
                .slice(0, 8)
                .map(x => x.i);
            anchors.forEach(i => {
                if (remaining.has(i) && canPlace(i)) take(i);
            });
        }

        // Keep a small set of global/grid chains to anchor the plan
        if (globalsMode === "always" || (globalsMode === "ifEmpty" && existingDimCount === 0)) {
            const globals = pre
                .map((v, i) => ({ v, i }))
                .filter(x => x.v.p.meta?.kind === "ml-merged" && x.v.hasGrid)
                .sort((a, b) => a.v.span - b.v.span)
                .slice(0, 16)
                .map(x => x.i);
            globals.forEach(i => {
                if (remaining.has(i) && canPlace(i)) take(i);
            });
        } else {
            console.log(`Skipping global/grid anchors (globalsMode='${globalsMode}', existingDims=${existingDimCount}).`);
        }

        while (selected.length < HARD_MAX && remaining.size > 0) {
            const wallCoverage = coveredWalls.size / Math.max(1, coverWallIdSet.size);
            const stillNeedRooms = enforceRoomConstraints && (roomNeedH.size > 0 || roomNeedV.size > 0);
            const needMoreWalls = wallCoverage < TARGET_WALL_COVERAGE;
            if (!stillNeedRooms && !needMoreWalls) break;
            // Only apply the "soft" cap when we also don't need wall coverage.
            if (!stillNeedRooms && !needMoreWalls && selected.length >= SOFT_MAX) break;

            let bestIdx: number | null = null;
            let bestScore = -Infinity;

            for (const idx of remaining) {
                if (!canPlace(idx)) continue;
                const item = pre[idx];

                let score = 0;

                if (enforceRoomConstraints) {
                    const ids = roomIdsFor(item.p);
                    const o = item.o ?? roomOrientationFor(item.p);
                    if (ids.length > 0 && o) {
                        const needs = o === "H" ? roomNeedH : roomNeedV;
                        const newlyCovered = ids.filter(id => needs.has(id)).length;
                        if (newlyCovered > 0) score += 8000 + newlyCovered * 2500;
                        else score -= 15000;
                    }
                }

                let newWalls = 0;
                for (const w of item.walls) if (!coveredWalls.has(w)) newWalls++;
                score += newWalls * 10;

                // When we're still chasing wall coverage, strongly prefer candidates that actually add it.
                // Without this, tile-spread bonuses can consume the budget on proposals that don't increase constraints.
                if (
                    needMoreWalls &&
                    newWalls === 0 &&
                    !(enforceRoomConstraints && (item.p.meta?.kind === "room-span" || item.p.meta?.kind === "room-bbox"))
                ) {
                    score -= 7000;
                }

                // Distribute dimensions across the plan (area-by-area)
                const t = item.t;
                if (t !== "none") {
                    const tc = tileCounts.get(t) ?? 0;
                    const target =
                        enforceRoomConstraints && (item.p.meta?.kind === "room-span" || item.p.meta?.kind === "room-bbox") ? 10 : 6;
                    if (tc < target) score += (target - tc) * 180;
                    if (tc > target + 6) score -= (tc - (target + 6)) * 350;
                }

                // Penalize long spans unless grid-based/global
                score -= (item.hasGrid ? item.span * 0.03 : item.span * 0.10);

                // Penalize excessive references to reduce clutter
                score -= item.p.elements.length * 0.5;

                // Bias away from dense-slice unless we still need wall coverage
                if (item.p.meta?.kind === "dense-slice" && !needMoreWalls) score -= 4000;

                // v2 candidate scorer bump (architect preset only)
                if (preset === "architect" && typeof item.mlP === "number") {
                    const kindV2 = item.p.meta?.kind === "wall-repair" ? "wall-to-wall" : String(item.p.meta?.kind ?? "");
                    let thr =
                        classifierV2 && classifierV2.type === "bundle"
                            ? (classifierV2.thresholds?.[kindV2] ?? 0.2)
                            : 0.2;
                    if (kindV2 === "overall") thr = Math.max(thr, 0.2);
                    if (kindV2 === "grid-chain") thr = Math.max(thr, 0.35);
                    if (kindV2 === "opening-locator") thr = Math.max(thr, 0.25);
                    if (kindV2 === "wall-to-wall") thr = Math.max(thr, 0.05);
                    // Scale around the per-kind best threshold; strongly down-rank below threshold.
                    const d = item.mlP - thr;
                    score += d * 6000;
                    if (d < 0) score -= 1500;
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestIdx = idx;
                }
            }

            if (bestIdx == null) break;
            take(bestIdx);
        }

        // If we're still under the wall-coverage target but stripe/tile caps blocked the main loop,
        // do a conservative fill pass that prefers short/local chains with high new-wall gain.
        {
            const wallCoverage = coveredWalls.size / Math.max(1, coverWallIdSet.size);
            const needMoreWalls = wallCoverage < TARGET_WALL_COVERAGE;
            if (needMoreWalls && remaining.size > 0) {
                const LOOSE_STRIPE_CAP = 18;
                const LOOSE_TILE_CAP = 28;
                const MAX_FILL = Math.min(120, HARD_MAX - selected.length);
                let added = 0;
                const roomExtraH = new Map<number, number>();
                const roomExtraV = new Map<number, number>();
                const EXTRA_PER_ROOM = 1;

                const canPlaceFillCandidate = (idx: number, cand: DimensionProposal) => {
                    const item = pre[idx];
                    const kind = item.p.meta?.kind ?? "unknown";
                    const o = getOrientation(cand);
                    if (!o || !cand.line) return false;

                    // Keep fill local.
                    const span = getSpan(cand);
                    if (!Number.isFinite(span) || span > 70) return false;
                    if (cand.elements.length > 6) return false;

                    if (kind === "room-span" || kind === "room-bbox") {
                        const ids = cand.meta?.roomIds ?? (typeof cand.meta?.roomId === "number" ? [cand.meta.roomId] : []);
                        if (ids.length === 0) return false;
                        const m = o === "H" ? roomExtraH : roomExtraV;
                        const hasBudget = ids.some(id => (m.get(id) ?? 0) < EXTRA_PER_ROOM);
                        if (!hasBudget) return false;
                        if (span > 40) return false;
                    }

                    const s = stripeKey(cand);
                    if (s !== "none" && (stripeCounts.get(s) ?? 0) >= LOOSE_STRIPE_CAP) return false;
                    const t = tileKey(cand);
                    if (t !== "none" && (tileCounts.get(t) ?? 0) >= LOOSE_TILE_CAP) return false;

                    return true;
                };

                const tryTakeFillShifted = (idx: number) => {
                    const item = pre[idx];
                    const base = item.p;
                    const o = item.o;
                    if (!o || !base.line) return false;

                    const clampR = getShiftClamp(base, o);
                    const baseCoord = o === "H" ? base.line.p1.y : base.line.p1.x;
                    const step = 1.5;
                    const deltas: number[] = [0];
                    for (let k = 1; k <= 10; k++) {
                        deltas.push(k * step);
                        deltas.push(-k * step);
                    }

                    for (const d of deltas) {
                        const coord = baseCoord + d;
                        if (clampR && (coord < clampR.min || coord > clampR.max)) continue;
                        const cand = d === 0 ? base : cloneShifted(base, o, d);
                        if (selectedSigs.has(signature(cand))) continue;
                        if (!canPlaceFillCandidate(idx, cand)) continue;
                        if (!takeAs(idx, cand)) continue;

                        if (cand.meta?.kind === "room-span" || cand.meta?.kind === "room-bbox") {
                            const ids = cand.meta.roomIds ?? (typeof cand.meta.roomId === "number" ? [cand.meta.roomId] : []);
                            const m = o === "H" ? roomExtraH : roomExtraV;
                            ids.forEach(id => m.set(id, (m.get(id) ?? 0) + 1));
                        }
                        return true;
                    }
                    return false;
                };

                const candidates = [...remaining].map(idx => {
                    const item = pre[idx];
                    let newWalls = 0;
                    for (const w of item.walls) if (!coveredWalls.has(w)) newWalls++;
                    return { idx, item, newWalls };
                }).filter(x => {
                    if (x.newWalls <= 0) return false;
                    const kind = x.item.p.meta?.kind ?? "unknown";

                    if (kind === "room-span" || kind === "room-bbox") {
                        const o = x.item.o;
                        if (!o) return false;
                        const ids = x.item.p.meta?.roomIds ?? (typeof x.item.p.meta?.roomId === "number" ? [x.item.p.meta.roomId] : []);
                        if (ids.length === 0) return false;
                        const m = o === "H" ? roomExtraH : roomExtraV;
                        const hasBudget = ids.some(id => (m.get(id) ?? 0) < EXTRA_PER_ROOM);
                        if (!hasBudget) return false;
                        // Room-span fill should be very local to avoid stripes.
                        if (!Number.isFinite(x.item.span) || x.item.span > 40) return false;
                    } else {
                        // Avoid long global stripes; fill should be local.
                        if (!Number.isFinite(x.item.span) || x.item.span > 70) return false;
                        // Avoid very long multi-ref chains in fill mode.
                        if (x.item.p.elements.length > 6) return false;
                    }

                    // Avoid very long multi-ref chains in fill mode.
                    return true;
                }).sort((a, b) => {
                    if (b.newWalls !== a.newWalls) return b.newWalls - a.newWalls;
                    if (a.item.span !== b.item.span) return a.item.span - b.item.span;
                    return a.item.p.elements.length - b.item.p.elements.length;
                });

                for (const c of candidates) {
                    if (added >= MAX_FILL) break;
                    if (selected.length >= HARD_MAX) break;
                    const curCoverage = coveredWalls.size / Math.max(1, coverWallIdSet.size);
                    if (curCoverage >= TARGET_WALL_COVERAGE) break;

                    if (!tryTakeFillShifted(c.idx)) continue;
                    added++;
                }
            }
        }
  
        // Repair pass: force at least one H and V per considered room when possible,
        // jittering the dimension line to avoid stripe collisions.
            if (enforceRoomConstraints && (roomNeedH.size > 0 || roomNeedV.size > 0)) {
                const byRoomH = new Map<number, { p: DimensionProposal, o: "H" }[]>();
                const byRoomV = new Map<number, { p: DimensionProposal, o: "V" }[]>();
                for (const item of pre) {
                    const o = item.o;
                    if (!o) continue;
                    const ids = roomIdsFor(item.p);
                    if (ids.length === 0) continue;
                    for (const rId of ids) {
                        if (o === "H") {
                            if (!byRoomH.has(rId)) byRoomH.set(rId, []);
                            byRoomH.get(rId)!.push({ p: item.p, o: "H" });
                        } else if (o === "V") {
                            if (!byRoomV.has(rId)) byRoomV.set(rId, []);
                            byRoomV.get(rId)!.push({ p: item.p, o: "V" });
                        }
                    }
                }

            const chooseBest = (arr: { p: DimensionProposal, o: "H" | "V" }[] | undefined) => {
                if (!arr || arr.length === 0) return null;
                let best: { p: DimensionProposal, o: "H" | "V", span: number } | null = null;
                for (const it of arr) {
                    const span = getSpan(it.p);
                    const score = span + (it.p.elements.length * 2);
                    if (!best || score < (best.span + best.p.elements.length * 2)) best = { ...it, span };
                }
                return best;
            };

            const tryPlaceRepair = (base: { p: DimensionProposal, o: "H" | "V" }) => {
                const o = base.o;
                const deltas: number[] = [0];
                const step = 0.75;
                for (let k = 1; k <= 14; k++) {
                    deltas.push(k * step);
                    deltas.push(-k * step);
                }

                for (const d of deltas) {
                    const cand = d === 0 ? base.p : cloneShifted(base.p, o, d);
                    const sig = signature(cand);
                    if (selectedSigs.has(sig)) continue;
                    const s = stripeKey(cand);
                    const c = s === "none" ? 0 : (stripeCounts.get(s) ?? 0);
                    // Repair is only invoked for truly missing room constraints; allow a bit more stripe pressure here.
                    const limit = Math.max(MAX_PER_STRIPE_REPAIR, SUPER_STRIPE_CAP);
                    if (s !== "none" && c >= limit) continue;
                    selected.push(cand);
                    selectedSigs.add(sig);
                    if (s !== "none") stripeCounts.set(s, c + 1);
                    const t = tileKey(cand);
                    if (t !== "none") tileCounts.set(t, (tileCounts.get(t) ?? 0) + 1);
                    wallIdsFor(cand).forEach(w => coveredWalls.add(w));
                    {
                        const ids = roomIdsFor(cand);
                        const o2 = roomOrientationFor(cand);
                        if (o2 === "H") ids.forEach(id => roomNeedH.delete(id));
                        if (o2 === "V") ids.forEach(id => roomNeedV.delete(id));
                    }
                    return true;
                }
                return false;
            };

            for (const rId of [...roomNeedH]) {
                if (selected.length >= HARD_MAX) break;
                const best = chooseBest(byRoomH.get(rId));
                if (best) tryPlaceRepair(best);
            }
            for (const rId of [...roomNeedV]) {
                if (selected.length >= HARD_MAX) break;
                const best = chooseBest(byRoomV.get(rId));
                if (best) tryPlaceRepair(best);
            }
        }

        // Tile repair: do an area-by-area sweep to ensure each 50ft tile gets at least some
        // non-room constraints (corridors, exterior, general wall-to-wall spacing), even if
        // overall wall coverage and per-room spans are satisfied.
        // In the `architect` preset we skip this to avoid "stripey" clutter.
        if (preset !== "architect") {
            const TILE = 50.0; // ft
            const MIN_TILE_WALLS = 8;
            const TARGET_TILE_COVERAGE = 0.60;
            const MIN_NONROOM_PER_TILE = 4; // per 50ft tile (combined H+V)
            const MAX_TILE_REPAIR_ADD = Math.min(80, HARD_MAX - selected.length);
            const MAX_PER_TILE_ADD = 8;

            const tileCoordKeyFromPoint = (x: number, y: number) => {
                const ix = Math.floor((x - minX) / TILE);
                const iy = Math.floor((y - minY) / TILE);
                return `${ix},${iy}`;
            };

            // Candidate lines may not be tagged to the same tile as the "needy" tile (because tileKey() uses midpoint),
            // but they can still cover walls inside that tile. So we select by intersection with the tile bbox.
            const getTileBounds = (tileKeyCoord: string) => {
                const [ixStr, iyStr] = tileKeyCoord.split(",");
                const ix = Number(ixStr);
                const iy = Number(iyStr);
                const x0 = minX + ix * TILE;
                const y0 = minY + iy * TILE;
                return { x0, y0, x1: x0 + TILE, y1: y0 + TILE };
            };

            const lineIntersectsTile = (line: any, tileKeyCoord: string) => {
                if (!line?.p1 || !line?.p2) return false;
                const b = getTileBounds(tileKeyCoord);
                const minLx = Math.min(line.p1.x, line.p2.x);
                const maxLx = Math.max(line.p1.x, line.p2.x);
                const minLy = Math.min(line.p1.y, line.p2.y);
                const maxLy = Math.max(line.p1.y, line.p2.y);
                return maxLx >= b.x0 && minLx <= b.x1 && maxLy >= b.y0 && minLy <= b.y1;
            };

            const tileKeysForGeom = (g: any): string[] => {
                if (!g?.p1 || !g?.p2) return [];
                const x1 = Number(g.p1.x), y1 = Number(g.p1.y);
                const x2 = Number(g.p2.x), y2 = Number(g.p2.y);
                if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return [];
                const minGX = Math.min(x1, x2), maxGX = Math.max(x1, x2);
                const minGY = Math.min(y1, y2), maxGY = Math.max(y1, y2);
                const ix0 = Math.floor((minGX - minX) / TILE);
                const ix1 = Math.floor((maxGX - minX) / TILE);
                const iy0 = Math.floor((minGY - minY) / TILE);
                const iy1 = Math.floor((maxGY - minY) / TILE);
                const out: string[] = [];
                for (let ix = ix0; ix <= ix1; ix++) {
                    for (let iy = iy0; iy <= iy1; iy++) out.push(`${ix},${iy}`);
                }
                return out;
            };

            const wallTiles = new Map<number, string[]>();
            for (const w of validWalls) {
                if (!tileWallIdSet.has(w.id)) continue;
                if (!w.geometry) continue;
                wallTiles.set(w.id, tileKeysForGeom(w.geometry));
            }

            const tileTotal = new Map<string, number>();
            const tileCovered = new Map<string, number>();
            const coveredTileWalls = new Set<number>();
            for (const p of selected) {
                (p.elements || []).forEach(id => {
                    if (tileWallIdSet.has(id)) coveredTileWalls.add(id);
                });
            }
            for (const w of validWalls) {
                if (!tileWallIdSet.has(w.id)) continue;
                const g = w.geometry;
                if (!g) continue;
                for (const key of (wallTiles.get(w.id) ?? tileKeysForGeom(g))) {
                    tileTotal.set(key, (tileTotal.get(key) ?? 0) + 1);
                    if (coveredTileWalls.has(w.id)) tileCovered.set(key, (tileCovered.get(key) ?? 0) + 1);
                }
            }

            const nonRoomH = new Map<string, number>();
            const nonRoomV = new Map<string, number>();
            for (const p of selected) {
                if (!p.line) continue;
                if (p.meta?.kind === "room-span" || p.meta?.kind === "room-bbox") continue;
                const o = getOrientation(p);
                if (!o) continue;
                const mx = (p.line.p1.x + p.line.p2.x) / 2;
                const my = (p.line.p1.y + p.line.p2.y) / 2;
                if (!Number.isFinite(mx) || !Number.isFinite(my)) continue;
                const key = tileCoordKeyFromPoint(mx, my);
                if (o === "H") nonRoomH.set(key, (nonRoomH.get(key) ?? 0) + 1);
                if (o === "V") nonRoomV.set(key, (nonRoomV.get(key) ?? 0) + 1);
            }

            const parseTile = (t: string) => {
                const m = /^T([RO]):(-?\\d+),(-?\\d+)$/.exec(t);
                if (!m) return null;
                return { group: m[1] as "R" | "O", key: `${m[2]},${m[3]}` };
            };

            const LOOSE_STRIPE_CAP = 18;
            const LOOSE_TILE_CAP = 28;
            const canPlaceLoose = (idx: number) => {
                const item0 = pre[idx];
                if (item0.p.meta?.kind === "room-span" || item0.p.meta?.kind === "room-bbox") return false;
                if (Number.isFinite(item0.span) && item0.span > 80) return false;
                const s = item0.s;
                if (s !== "none" && (stripeCounts.get(s) ?? 0) >= LOOSE_STRIPE_CAP) return false;
                const t = item0.t;
                if (t !== "none" && (tileCounts.get(t) ?? 0) >= LOOSE_TILE_CAP) return false;
                return true;
            };

            const tiles = [...tileTotal.entries()]
                .filter(([, total]) => total >= MIN_TILE_WALLS)
                .map(([key, total]) => {
                    const cov = (tileCovered.get(key) ?? 0) / Math.max(1, total);
                    const h = nonRoomH.get(key) ?? 0;
                    const v = nonRoomV.get(key) ?? 0;
                    const nonRoom = h + v;
                    const needCov = cov < TARGET_TILE_COVERAGE;
                    const needNonRoom = nonRoom < MIN_NONROOM_PER_TILE || h === 0 || v === 0;
                    const score =
                        (needCov ? (TARGET_TILE_COVERAGE - cov) * 1000 : 0) +
                        (needNonRoom ? 300 : 0) +
                        Math.max(0, MIN_NONROOM_PER_TILE - nonRoom) * 120 +
                        (h === 0 ? 120 : 0) +
                        (v === 0 ? 120 : 0);
                    return { key, total, cov, h, v, needCov, needNonRoom, score };
                })
                .filter(t => t.needCov || t.needNonRoom)
                .sort((a, b) => b.score - a.score);

            let added = 0;
            const pickBest = (tileKeyCoord: string, wantO: "H" | "V" | "any", requireNewWalls: boolean) => {
                let bestIdx: number | null = null;
                let bestScore = -Infinity;
                for (const idx of remaining) {
                    const item = pre[idx];
                    if (item.p.meta?.kind === "room-span" || item.p.meta?.kind === "room-bbox") continue;
                    if (!item.o) continue;
                    if (wantO !== "any" && item.o !== wantO) continue;
                    if (!canPlaceLoose(idx)) continue;
                    if (!item.p.line) continue;
                    if (!lineIntersectsTile(item.p.line, tileKeyCoord)) continue;

                    // Prefer proposals that actually reference walls (grid-only chains tend to be global).
                    const wallRefCount = item.tileWalls.length;
                    if (!item.hasGrid && wallRefCount < 2) continue;
                    if (item.hasGrid && wallRefCount < 1) continue;

                    // Count how many *tile-local* new (>=2ft) wall references this adds.
                    let newWallsInTile = 0;
                    for (const wId of item.tileWalls) {
                        if (coveredTileWalls.has(wId)) continue;
                        const keys = wallTiles.get(wId);
                        if (keys && keys.includes(tileKeyCoord)) newWallsInTile++;
                    }

                    // When we're trying to improve tile-local wall coverage, require some gain.
                    // When we're just ensuring the tile has an H/V constraint, allow 0 gain (still valuable as a measurement).
                    if (requireNewWalls && newWallsInTile <= 0) continue;

                    let score = newWallsInTile * 60;
                    const kind = item.p.meta?.kind ?? "unknown";
                    if (kind === "tile-slice") score += 40;
                    if (kind === "adjacent") score += 80;
                    if (kind === "dense-slice") score += 20;
                    if (!requireNewWalls && wantO !== "any") score += 200;
                    // Bias toward short/local spans (avoid stripes)
                    if (Number.isFinite(item.span)) score -= item.span * 0.12;
                    score -= item.p.elements.length * 0.6;

                    if (score > bestScore) {
                        bestScore = score;
                        bestIdx = idx;
                    }
                }
                return bestIdx;
            };

            for (const t of tiles) {
                if (added >= MAX_TILE_REPAIR_ADD) break;
                if (selected.length >= HARD_MAX) break;

                const addOne = (idx: number) => {
                    const item = pre[idx];
                    take(idx);
                    // Update per-tile coverage counts for this specific tile key.
                    for (const wId of item.tileWalls) {
                        const keys = wallTiles.get(wId);
                        if (!keys || !keys.includes(t.key)) continue;
                        if (coveredTileWalls.has(wId)) continue;
                        coveredTileWalls.add(wId);
                        tileCovered.set(t.key, (tileCovered.get(t.key) ?? 0) + 1);
                    }
                    if (item.o === "H") nonRoomH.set(t.key, (nonRoomH.get(t.key) ?? 0) + 1);
                    if (item.o === "V") nonRoomV.set(t.key, (nonRoomV.get(t.key) ?? 0) + 1);
                    added++;
                };

                const maxForThisTile = Math.min(
                    MAX_PER_TILE_ADD,
                    Math.max(3, Math.floor((t.total ?? 0) / 6))
                );

                let addedHere = 0;
                while (added < MAX_TILE_REPAIR_ADD && selected.length < HARD_MAX && addedHere < maxForThisTile) {
                    const curCovered = tileCovered.get(t.key) ?? 0;
                    const curTotal = tileTotal.get(t.key) ?? 0;
                    const curCov = curCovered / Math.max(1, curTotal);
                    const curH = nonRoomH.get(t.key) ?? 0;
                    const curV = nonRoomV.get(t.key) ?? 0;
                    const curNonRoom = curH + curV;

                    const needCov = curCov < TARGET_TILE_COVERAGE;
                    const needNonRoom = curNonRoom < MIN_NONROOM_PER_TILE || curH === 0 || curV === 0;
                    if (!needCov && !needNonRoom) break;

                    let idx: number | null = null;
                    if (curH === 0) {
                        idx = pickBest(t.key, "H", false);
                    } else if (curV === 0) {
                        idx = pickBest(t.key, "V", false);
                    } else if (needCov) {
                        idx = pickBest(t.key, "any", true);
                    } else if (needNonRoom) {
                        const want: "H" | "V" = curH <= curV ? "H" : "V";
                        idx = pickBest(t.key, want, false) ?? pickBest(t.key, "any", false);
                    }

                    if (idx == null) break;
                    addOne(idx);
                    addedHere++;
                }
            }

            if (tiles.length > 0) {
                console.log(`Tile repair: tilesNeeding=${tiles.length} added=${added}`);
            }
        }

        // Debug: selection composition + why we might be stuck under the wall-coverage target.
        {
            const allByKind: Record<string, number> = {};
            const selByKind: Record<string, number> = {};
            pre.forEach(item => {
                const k = item.p.meta?.kind ?? "unknown";
                allByKind[k] = (allByKind[k] ?? 0) + 1;
            });
            selected.forEach(p => {
                const k = p.meta?.kind ?? "unknown";
                selByKind[k] = (selByKind[k] ?? 0) + 1;
            });

            const remIdx = [...remaining];
            const remMl = remIdx.map(i => pre[i]).filter(x => (x.p.meta?.kind ?? "unknown") === "ml-merged");
            const remMlLong = remMl.filter(x => !Number.isFinite(x.span) || x.span > 70).length;
            const remMlMany = remMl.filter(x => x.p.elements.length > 6).length;
            const remMlBlocked = remIdx.filter(i => !canPlace(i)).length;

            const canPlaceReason = (idx: number) => {
                const item0 = pre[idx];
                const kind = item0.p.meta?.kind ?? "unknown";
                const o = item0.o;
                if ((kind === "room-span" || kind === "room-bbox") && o) {
                    const ids = item0.p.meta?.roomIds ?? (typeof item0.p.meta?.roomId === "number" ? [item0.p.meta.roomId] : []);
                    const needs = o === "H" ? roomNeedH : roomNeedV;
                    const coversNeed = ids.some(id => needs.has(id));
                    return coversNeed ? "ok-room-span" : "room-span-already-covered";
                }

                const s = item0.s;
                const t = item0.t;
                if (s === "none") return "ok-no-stripe";

                const stripeCount = stripeCounts.get(s) ?? 0;
                const tileCount = t !== "none" ? (tileCounts.get(t) ?? 0) : 0;
                const stripeOk = stripeCount < maxStripeFor(idx);
                const tileOk = t === "none" || tileCount < maxTileFor(idx);
                if (stripeOk && tileOk) return "ok";

                const wallCoverage = coveredWalls.size / Math.max(1, coverWallIdSet.size);
                const needMoreWalls = wallCoverage < TARGET_WALL_COVERAGE;
                if (!needMoreWalls) {
                    if (!stripeOk && !tileOk) return "cap-stripe+tile-no-need-walls";
                    if (!stripeOk) return "cap-stripe-no-need-walls";
                    return "cap-tile-no-need-walls";
                }

                if (!Number.isFinite(item0.span) || item0.span > MAX_SPAN_FOR_CAP_OVERRIDE) return "cap-override-span-too-large";
                if (item0.p.elements.length > MAX_ELEMS_FOR_CAP_OVERRIDE) return "cap-override-too-many-elements";

                let newWalls = 0;
                for (const w of item0.walls) if (!coveredWalls.has(w)) newWalls++;
                if (newWalls < MIN_NEW_WALLS_FOR_CAP_OVERRIDE) return "cap-override-newWalls-too-low";

                if (stripeCount >= SUPER_STRIPE_CAP) return "super-stripe-cap";
                if (t !== "none" && tileCount >= SUPER_TILE_CAP) return "super-tile-cap";

                return "cap-override-unknown";
            };

            const remReasonCounts: Record<string, number> = {};
            const remNewWallCounts: Record<string, number> = {};
            for (const idx of remIdx) {
                const r = canPlaceReason(idx);
                remReasonCounts[r] = (remReasonCounts[r] ?? 0) + 1;
                const item = pre[idx];
                let newWalls = 0;
                for (const w of item.walls) if (!coveredWalls.has(w)) newWalls++;
                if (newWalls > 0) remNewWallCounts[r] = (remNewWallCounts[r] ?? 0) + 1;
            }

            const topStripe = [...stripeCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12)
                .map(([k, v]) => `${k}:${v}`)
                .join(" ");
            const topTile = [...tileCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12)
                .map(([k, v]) => `${k}:${v}`)
                .join(" ");

            console.log(
                `Selection stats: selected=${selected.length} wallCov=${(coveredWalls.size / Math.max(1, coverWallIdSet.size)).toFixed(3)} ` +
                `remaining=${remaining.size} blocked=${remMlBlocked} allByKind=${JSON.stringify(allByKind)} selByKind=${JSON.stringify(selByKind)} ` +
                `remMl=${remMl.length} remMlLong=${remMlLong} remMlMany=${remMlMany} remReasons=${JSON.stringify(remReasonCounts)} ` +
                `remReasonsNewWall=${JSON.stringify(remNewWallCounts)} topStripe=${topStripe} topTile=${topTile}`
            );
        }

        return applyArchitectStackConstraints(selected);
    };

    const finalProposals = selectProposals(mergedProposals);
    console.log(`Merged ${proposals.length} links into ${mergedProposals.length} chains; selected ${finalProposals.length} for application.`);
    return finalProposals;
}

export async function applyAutoDimension(viewId: number, proposals: DimensionProposal[]) {
    console.log(`Applying ${proposals.length} dimension proposals to view ${viewId}...`);
    
    const results: any[] = [];
    const BATCH_SIZE = 20; // Increased batch size
    let successCount = 0;
    let errorCount = 0;
    const errorSamples: { desc: string; elements: number[]; error: any }[] = [];

    type CreateDimensionResponse = {
        success?: boolean;
        id?: number;
        error?: string;
        [key: string]: any;
    };
    
    const inferOrientation = (p: DimensionProposal): "H" | "V" | null => {
        const o = p.meta?.orientation;
        if (o === "H" || o === "V") return o;
        if (!p.line) return null;
        const dx = Math.abs(p.line.p2.x - p.line.p1.x);
        const dy = Math.abs(p.line.p2.y - p.line.p1.y);
        return dx >= dy ? "H" : "V";
    };

    const shiftProposal = (p: DimensionProposal, o: "H" | "V", delta: number): DimensionProposal => {
        if (!p.line || delta === 0) return p;
        if (o === "H") {
            return {
                ...p,
                line: {
                    p1: { ...p.line.p1, y: p.line.p1.y + delta },
                    p2: { ...p.line.p2, y: p.line.p2.y + delta },
                },
            };
        }
        return {
            ...p,
            line: {
                p1: { ...p.line.p1, x: p.line.p1.x + delta },
                p2: { ...p.line.p2, x: p.line.p2.x + delta },
            },
        };
    };

    const isInvalidRefs = (e: unknown) => {
        const s = String(e ?? "").toLowerCase();
        return s.includes("invalid number of references") || s.includes("zero-length dimension rejected") || s.includes("zero length dimension");
    };
    const jitterDeltas = () => {
        const out: number[] = [];
        for (let d = 0.5; d <= 6.0 + 1e-9; d += 0.5) {
            out.push(d, -d);
        }
        return out;
    };
    const shouldBumpBadRefs = (p: DimensionProposal) => {
        const kind = p.meta?.kind ?? "unknown";
        if (p.elements.length !== 2) return false;
        return kind === "adjacent" || kind === "tile-slice" || kind === "dense-slice" || kind === "room-span" || kind === "room-bbox" || kind === "wall-repair";
    };

    for (let i = 0; i < proposals.length; i += BATCH_SIZE) {
        const batch = proposals.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (prop) => {
            try {
                const tryApply = async (p: DimensionProposal): Promise<CreateDimensionResponse> => {
                    const payload: any = { viewId, elementIds: p.elements };
                    if (p.line) {
                        payload.startPoint = p.line.p1;
                        payload.endPoint = p.line.p2;
                    }
                    return await callRevit<CreateDimensionResponse>("/revit/create-dimension", "POST", payload);
                };

                let res = await tryApply(prop);
                if (res && (res.success === true || typeof res.id === "number")) {
                    results.push(res);
                    successCount++;
                    return;
                }

                // If Revit rejects references, try a small perpendicular jitter to avoid edge/corner cases.
                const err0 = res?.error ?? "";
                if (prop.line && isInvalidRefs(err0)) {
                    const o = inferOrientation(prop);
                    if (o) {
                        for (const d of jitterDeltas()) {
                            const cand = shiftProposal(prop, o, d);
                            const r2 = await tryApply(cand);
                            if (r2 && (r2.success === true || typeof r2.id === "number")) {
                                results.push(r2);
                                successCount++;
                                return;
                            }
                        }
                    }
                }

                if (res?.error && isInvalidRefs(res.error) && shouldBumpBadRefs(prop)) {
                    bumpBadRefs(prop.meta?.kind ?? "unknown", prop.elements);
                }

                results.push(res);
                if (res && res.error) {
                    errorCount++;
                    if (errorSamples.length < 12) errorSamples.push({ desc: prop.description, elements: prop.elements, error: res.error });
                }
            } catch (e) {
                // If callRevit throws, we can still attempt a jitter retry for line-based proposals.
                if (prop.line && isInvalidRefs(e)) {
                    const o = inferOrientation(prop);
                    if (o) {
                        const tryApply = async (p: DimensionProposal): Promise<CreateDimensionResponse> => {
                            const payload: any = { viewId, elementIds: p.elements };
                            if (p.line) {
                                payload.startPoint = p.line.p1;
                                payload.endPoint = p.line.p2;
                            }
                            return await callRevit<CreateDimensionResponse>("/revit/create-dimension", "POST", payload);
                        };
                        for (const d of jitterDeltas()) {
                            try {
                                const cand = shiftProposal(prop, o, d);
                                const r2 = await tryApply(cand);
                                if (r2 && (r2.success === true || typeof r2.id === "number")) {
                                    results.push(r2);
                                    successCount++;
                                    return;
                                }
                            } catch { }
                        }
                    }
                }

                if (isInvalidRefs(e) && shouldBumpBadRefs(prop)) {
                    bumpBadRefs(prop.meta?.kind ?? "unknown", prop.elements);
                }

                console.error(`Failed to apply proposal: ${prop.description}`, e);
                results.push({ error: e });
                errorCount++;
                if (errorSamples.length < 12) errorSamples.push({ desc: prop.description, elements: prop.elements, error: String(e) });
            }
        }));
    }

    console.log(`Dimension apply results: success=${successCount}, error=${errorCount}`);
    if (errorSamples.length > 0) {
        console.log("Sample dimension errors:");
        for (const s of errorSamples) {
            console.log(`- ${s.desc} ids=[${s.elements.join(",")}] err=${String(s.error)}`);
        }
    }
    
    return {
        status: "complete",
        results
    };
}

export async function computeCoverageReport(viewId: number, proposals: DimensionProposal[]) {
    const LIMIT = 100000;
    const walls = await callRevit("/revit/query", "POST", { category: "OST_Walls", viewId, limit: LIMIT }) as Element[];

    const validWalls = (walls || []).filter(w => w.geometry);
    const wallIdSet = new Set(validWalls.map(w => w.id));
    const COVER_WALL_MIN_LEN = 4.0; // ft
    const lineLenLocal = (g: any) => {
        if (!g?.p1 || !g?.p2) return 0;
        const dx = Number(g.p2.x) - Number(g.p1.x);
        const dy = Number(g.p2.y) - Number(g.p1.y);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
        return Math.sqrt(dx * dx + dy * dy);
    };
    const coverWallIdSet = new Set(validWalls.filter(w => w.geometry && lineLenLocal(w.geometry) >= COVER_WALL_MIN_LEN).map(w => w.id));

    const levelCounts = new Map<string, number>();
    validWalls.forEach(w => {
        if (!w.level) return;
        levelCounts.set(w.level, (levelCounts.get(w.level) ?? 0) + 1);
    });
    const inferredLevel = [...levelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

    const coveredWalls = new Set<number>();
    const coveredCoverWalls = new Set<number>();
    proposals.forEach(p => {
        (p.elements || []).forEach(id => {
            if (wallIdSet.has(id)) coveredWalls.add(id);
            if (coverWallIdSet.has(id)) coveredCoverWalls.add(id);
        });
    });

    const proposalsByKind: Record<string, number> = {};
    proposals.forEach(p => {
        const k = p.meta?.kind ?? "unknown";
        proposalsByKind[k] = (proposalsByKind[k] ?? 0) + 1;
    });

    let roomsAll: any[] = [];
    if (inferredLevel) {
        try {
            roomsAll = await callRevit("/revit/rooms", "POST", { action: "list", levelName: inferredLevel }) as any[];
        } catch {
            roomsAll = [];
        }
    }

    const roomFilter = (r: any) => {
        const name = String(r?.name ?? "").toLowerCase();
        const area = Number(r?.area);
        if (!Number.isFinite(area)) return false;
        if (area < 30 || area > 350) return false;
        if (name.includes("corridor")) return false;
        if (name.includes("lobby") || name.includes("waiting") || name.includes("wait")) return false;
        if (name.includes("open")) return false;
        if (name.includes("mechanical") || name.includes("electrical") || name.includes("shaft")) return false;
        if (name.includes("stair") || name.includes("elev")) return false;
        return true;
    };

    const roomsConsidered = (roomsAll || []).filter(roomFilter);

    // Dedupe rooms by stable identity (Revit can return multiple ids for the same named room).
    const roomKey = (r: any) => `${String(r?.number ?? "")}|${String(r?.name ?? "")}|${String(r?.level ?? "")}`;
    const dedupedRoomsConsidered: any[] = [];
    {
        const byKey = new Map<string, any>();
        for (const r of roomsConsidered) {
            const k = roomKey(r);
            const prev = byKey.get(k);
            if (!prev) {
                byKey.set(k, r);
                continue;
            }
            const id = Number(r?.id);
            const prevId = Number(prev?.id);
            if (Number.isFinite(id) && (!Number.isFinite(prevId) || id < prevId)) {
                byKey.set(k, r);
            }
        }
        const ordered = [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b));
        dedupedRoomsConsidered.push(...ordered.map(([, r]) => r));
    }

    const roomNeedH = new Set<number>(dedupedRoomsConsidered.map(r => r.id));
    const roomNeedV = new Set<number>(dedupedRoomsConsidered.map(r => r.id));
    const roomIdsFor = (p: DimensionProposal) =>
        p.meta?.roomIds ?? (typeof p.meta?.roomId === "number" ? [p.meta.roomId] : []);
    const orientationFor = (p: DimensionProposal): "H" | "V" | null => {
        if (p.line) {
            const dx = Math.abs(p.line.p2.x - p.line.p1.x);
            const dy = Math.abs(p.line.p2.y - p.line.p1.y);
            return dx >= dy ? "H" : "V";
        }
        if (p.meta?.orientation) return p.meta.orientation;
        return null;
    };
    proposals.forEach(p => {
        const ids = roomIdsFor(p);
        if (ids.length === 0) return;
        const o = orientationFor(p);
        if (o === "H") ids.forEach(id => roomNeedH.delete(id));
        if (o === "V") ids.forEach(id => roomNeedV.delete(id));
    });

    const uncoveredWallsSample = validWalls
        .filter(w => !coveredWalls.has(w.id))
        .slice(0, 50)
        .map(w => ({
            id: w.id,
            name: w.name,
            level: w.level,
            geometry: w.geometry,
        }));

    const roomIndex = new Map<number, any>();
    (roomsAll || []).forEach(r => {
        if (typeof r?.id === "number") roomIndex.set(r.id, r);
    });

    const toRoomSummary = (id: number) => {
        const r = roomIndex.get(id);
        if (!r) return { id };
        return {
            id,
            number: r.number,
            name: r.name,
            area: r.area,
            level: r.level,
        };
    };

    const roomNeedHSummaries = [...roomNeedH].slice(0, 200).map(toRoomSummary);
    const roomNeedVSummaries = [...roomNeedV].slice(0, 200).map(toRoomSummary);

    return {
        viewId,
        inferredLevel,
        counts: {
            proposals: proposals.length,
            walls: validWalls.length,
            coveredWalls: coveredWalls.size,
            wallCoverage: validWalls.length ? coveredWalls.size / validWalls.length : 0,
            coverWalls: coverWallIdSet.size,
            coveredCoverWalls: coveredCoverWalls.size,
            coverWallCoverage: coverWallIdSet.size ? coveredCoverWalls.size / coverWallIdSet.size : 0,
            roomsAll: roomsAll.length,
            roomsConsidered: dedupedRoomsConsidered.length,
            roomsNeedH: roomNeedH.size,
            roomsNeedV: roomNeedV.size,
        },
        proposalsByKind,
        missing: {
            roomNeedH: roomNeedHSummaries,
            roomNeedV: roomNeedVSummaries,
            uncoveredWallsSample,
        },
    };
}
