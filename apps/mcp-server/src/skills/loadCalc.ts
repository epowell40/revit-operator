import { RunBundle } from "../lib/RunBundle.js";
import { callRevit } from "../lib/revitClient.js";

export async function runLoadCalcSnapshot(levelName: string, defaultAch: number = 6) {
    const bundle = new RunBundle("load_calc", { levelName, defaultAch });
    await bundle.init();

    try {
        bundle.log(`Starting Load Calc Snapshot for level: ${levelName}`);

        // 1. Resolve Level
        const levelRes: any = await callRevit("/revit/resolve", "POST", { type: "level", query: levelName });
        if (!levelRes) throw new Error(`Level '${levelName}' not found.`);

        // 2. List Rooms
        const roomList: any[] = await callRevit("/revit/rooms", "POST", { action: "list", levelName: levelRes.name }) as any[];
        const roomIds = roomList.map(r => r.id);
        
        // 3. Get Details (Volume)
        const roomDetails: any[] = await callRevit("/revit/rooms", "POST", { action: "detail", roomIds }) as any[];
        
        // 4. Compute
        const calcRows = [];
        calcRows.push(["Room Number", "Name", "Volume (ft3)", "ACH", "Required CFM"]);

        for (const room of roomDetails) {
            const vol = room.volume || 0;
            const cfm = (vol * defaultAch) / 60.0;
            
            calcRows.push([
                room.number,
                room.name,
                vol.toFixed(2),
                defaultAch,
                cfm.toFixed(2)
            ]);
        }

        // 5. Generate CSV
        const csvContent = calcRows.map(row => row.map(c => `"${c}"`).join(",")).join("\n");
        const csvPath = await bundle.saveArtifact("load_calc_snapshot.csv", csvContent);

        const result = {
            totalRooms: roomDetails.length,
            reportPath: csvPath
        };

        await bundle.complete(result);
        return result;

    } catch (error) {
        await bundle.fail(error);
        throw error;
    }
}
