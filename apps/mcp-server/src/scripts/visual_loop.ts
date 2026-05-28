import { callRevit } from "../lib/revitClient.js";
import { planAutoDimension, applyAutoDimension, computeCoverageReport } from "../skills/autoDimension.js";
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from "child_process";

async function runVisualLoop() {
    const VIEW_NAME_SOURCE = "LEVEL 01 DIMENSION PLAN";
    const VIEW_NAME_TARGET = "AI_TEST_LEVEL_01";
    const WORK_DIR = path.resolve(process.cwd(), "../local-work/EPIC-0004_auto-dimensioning/iterations");

    console.log("Starting Visual Verification Loop...");
    console.log(`Work Directory: ${WORK_DIR}`);

    if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

    // 1. Find Source View ID
    console.log(`Resolving view: ${VIEW_NAME_SOURCE}...`);
    let views;
    try {
        views = await callRevit("/revit/views");
    } catch (e) {
        console.error("Failed to list views. Is Revit connected?", e);
        process.exit(1);
    }

    const sourceView = views.find((v: any) => v.name === VIEW_NAME_SOURCE);

    if (!sourceView) {
        console.error(`Source view '${VIEW_NAME_SOURCE}' not found!`);
        process.exit(1);
    }
    console.log(`Found Source View: ${sourceView.id}`);

    // 2. Duplicate View (Clean Slate)
    console.log(`Duplicating to '${VIEW_NAME_TARGET}'...`);
    const targetViewExisting = views.find((v: any) => v.name === VIEW_NAME_TARGET);
    if (targetViewExisting) {
        console.log("Deleting existing target view...");
        try {
            await callRevit("/revit/delete", "POST", { ids: [targetViewExisting.id], apply: true });
        } catch (e) {
            console.warn("Failed to delete existing view (might be active?). Proceeding anyway.", e);
        }
    }

    let testViewId: number;
    try {
        const dupResult = await callRevit("/revit/duplicate-view", "POST", { 
            viewId: sourceView.id, 
            newName: VIEW_NAME_TARGET,
            withDetailing: false // False = Clean Geometry only
        });
        testViewId = dupResult.viewId;
    } catch (e) {
        console.error("Failed to duplicate view.", e);
        process.exit(1);
    }
    console.log(`Created Test View: ${testViewId}`);

    // 3. Plan Dimensions
    console.log("Running Auto-Dimension Logic...");
    const proposals = await planAutoDimension(testViewId, {
        respectExistingDimensions: true,
        roomMode: "bbox",
        includeAdjacent: false,
        includeDenseSlices: false,
        includeTileSlices: false,
    });

    // 4. Prep Iteration Folder + Coverage Report
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const iterDir = path.join(WORK_DIR, timestamp);
    fs.mkdirSync(iterDir, { recursive: true });

    try {
        const coverage = await computeCoverageReport(testViewId, proposals);
        fs.writeFileSync(path.join(iterDir, "coverage.json"), JSON.stringify(coverage, null, 2));
    } catch (e) {
        console.warn("Failed to write coverage.json", e);
    }

    // 5. Apply Dimensions
    console.log("Applying Dimensions...");
    await applyAutoDimension(testViewId, proposals);

    // 6. Capture Images
    console.log("Capturing Images...");
    const humanImageRes = await callRevit("/revit/export-image", "POST", { 
        viewId: sourceView.id, 
        imageSize: 6000,
        folder: iterDir
    });
    
    const aiImageRes = await callRevit("/revit/export-image", "POST", { 
        viewId: testViewId, 
        imageSize: 6000,
        folder: iterDir 
    });

    const report = {
        timestamp,
        sourceView: VIEW_NAME_SOURCE,
        testView: VIEW_NAME_TARGET,
        humanImage: humanImageRes.path,
        aiImage: aiImageRes.path,
        proposalsCount: proposals.length
    };

    const reportPath = path.join(iterDir, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    // 7. Create area-by-area tiles for quick visual auditing
    try {
        const psScript = path.resolve(process.cwd(), "src/scripts/tile_images.ps1");
        execFileSync("powershell", [
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", psScript,
            "-iterDir", iterDir,
            "-aiViewName", VIEW_NAME_TARGET,
            "-humanViewName", VIEW_NAME_SOURCE,
            "-cols", "3",
            "-rows", "3",
            "-padding", "0"
        ], { stdio: "inherit" });
    } catch (e) {
        console.warn("Failed to tile images for auditing.", e);
    }

    console.log("---------------------------------------------------");
    console.log("ITERATION COMPLETE");
    console.log(`Report: ${reportPath}`);
    console.log(`Human Baseline: ${humanImageRes.path}`);
    console.log(`AI Result:      ${aiImageRes.path}`);
    console.log("---------------------------------------------------");
}

runVisualLoop();
