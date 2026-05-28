import { RunBundle } from "../lib/RunBundle.js";
import { callRevit } from "../lib/revitClient.js";

export async function runDoorFireRatingCheck() {
    const bundle = new RunBundle("door_fire_rating_check");
    await bundle.init();

    try {
        bundle.log("Starting Door Fire Rating Check...");

        // 1. Get all levels to ensure we scan the whole building
        const levels: any[] = await callRevit("/revit/query", "POST", { category: "OST_Levels" }) as any[];
        bundle.log(`Found ${levels.length} levels.`);

        const auditRows: string[][] = [];
        auditRows.push(["Level", "Room Number", "Room Name", "Door Mark", "Rating", "Hardware", "Closer", "Status"]);

        let totalFireRatedDoors = 0;
        let doorsMissingClosers = 0;

        for (const level of levels) {
            bundle.log(`Scanning Level: ${level.name}`);

            // 2. List Rooms on this level
            const rooms: any[] = await callRevit("/revit/rooms", "POST", { action: "list", levelName: level.name }) as any[];
            if (!rooms || rooms.length === 0) continue;

            // 3. Get Room Details (which now includes doors via our modified RoomHandler)
            const roomIds = rooms.map(r => r.id);
            const details: any[] = await callRevit("/revit/rooms", "POST", { action: "detail", roomIds }) as any[];

            for (const room of details) {
                if (!room.doors || room.doors.length === 0) continue;

                for (const door of room.doors) {
                    const rating = (door.rating || "").toUpperCase();
                    // Basic heuristic for fire-rated doors
                    const isFireRated = rating.includes("MIN") || rating.includes("HR") || /^[1-9]/.test(rating);

                    if (isFireRated) {
                        totalFireRatedDoors++;
                        const hasCloser = door.doorControl === "CR";
                        const status = hasCloser ? "OK" : "MISSING CLOSER?";
                        
                        if (!hasCloser) doorsMissingClosers++;

                        auditRows.push([
                            level.name,
                            room.number,
                            room.name,
                            door.mark,
                            door.rating,
                            door.hardware || "-",
                            door.doorControl || "-",
                            status
                        ]);
                    }
                }
            }
        }

        // 4. Generate CSV Artifact
        const csvContent = auditRows.map(row => row.map(cell => `"${cell}"`).join(",")).join("\n");
        const csvPath = await bundle.saveArtifact("fire_rating_audit.csv", csvContent);

        // 5. Generate Markdown Summary
        let mdSummary = `# Fire Rating Audit Summary\n\n`;
        mdSummary += `- **Total Fire Rated Doors Found:** ${totalFireRatedDoors}\n`;
        mdSummary += `- **Doors Potentially Missing Closers:** ${doorsMissingClosers}\n\n`;
        mdSummary += `| Level | Room | Door | Rating | Hardware | Closer | Status |\n`;
        mdSummary += `| --- | --- | --- | --- | --- | --- | --- |\n`;
        
        // Add top 20 issues to the MD summary for quick viewing
        auditRows.slice(1).forEach(row => {
            mdSummary += `| ${row[0]} | ${row[1]} | ${row[3]} | ${row[4]} | ${row[5]} | ${row[6]} | ${row[7]} |\n`;
        });
        
        const mdPath = await bundle.saveArtifact("summary.md", mdSummary);

        const result = {
            totalFireRatedDoors,
            doorsMissingClosers,
            csvReport: csvPath,
            mdReport: mdPath,
            bundleDir: bundle.dirPath
        };

        await bundle.complete(result);
        return result;

    } catch (error) {
        bundle.log("Audit failed: " + String(error));
        await bundle.fail(error);
        throw error;
    }
}