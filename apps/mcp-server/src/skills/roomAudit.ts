import { RunBundle } from "../lib/RunBundle.js";
import { callRevit } from "../lib/revitClient.js";

export async function runRoomAudit(levelName: string) {
    const bundle = new RunBundle("room_audit", { levelName });
    await bundle.init();

    try {
        bundle.log(`Starting Room Audit for level: ${levelName}`);

        // 1. Resolve Level
        const levelRes: any = await callRevit("/revit/resolve", "POST", { type: "level", query: levelName });
        if (!levelRes) {
            throw new Error(`Level '${levelName}' not found.`);
        }
        bundle.log("Level resolved", levelRes);

        // 2. List Rooms
        const rooms: any[] = await callRevit("/revit/rooms", "POST", { action: "list", levelName: levelRes.name }) as any[];
        bundle.log(`Found ${rooms.length} rooms.`);

        // 3. Audit Logic
        const auditRows = [];
        auditRows.push(["Room Number", "Name", "Area", "Status", "Issues"]);

        for (const room of rooms) {
            const issues = [];
            let status = "OK";

            if (room.area <= 0) {
                issues.push("Not Enclosed / Zero Area");
                status = "Error";
            }
            if (!room.name || room.name === "Room") {
                issues.push("Default Name");
                status = "Warning";
            }

            auditRows.push([
                room.number,
                room.name,
                room.area,
                status,
                issues.join("; ")
            ]);
        }

        // 4. Generate CSV
        const csvContent = auditRows.map(row => row.map(c => `"${c}"`).join(",")).join("\n");
        const csvPath = await bundle.saveArtifact("room_audit.csv", csvContent);

        const result = {
            totalRooms: rooms.length,
            reportPath: csvPath,
            level: levelRes.name
        };

        await bundle.complete(result);
        return result;

    } catch (error) {
        await bundle.fail(error);
        throw error;
    }
}
