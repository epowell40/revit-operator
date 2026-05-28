import { handleFireDamperAudit } from "../skills/fireDamperAudit.js";
import * as fs from 'fs';
import * as path from 'path';

async function run() {
    console.log("Starting Fire Damper Audit Test...");

    const auditArgs = {
        mode: "audit",
        config: {
            // Using generic names, assuming they might exist or we just want to see the missing list
            fireDamperFamily: "Fire Damper",
            smokeDamperFamily: "Smoke Damper",
            comboDamperFamily: "Fire Smoke Damper",
            minDuctWidthInches: 14.0
        }
    };

    const response = await handleFireDamperAudit(auditArgs);

    if (response.isError) {
        console.error("Audit failed:", response.content[0].text);
    } else {
        console.log("Audit successful. parsing results...");
        const resultText = response.content[0].text;
        const result = JSON.parse(resultText);

        const penetrations = result.penetrations || [];
        console.log(`Found ${penetrations.length} penetrations.`);

        const missing = penetrations.filter((p: any) => p.status.includes("Missing"));
        const undersized = penetrations.filter((p: any) => p.status.includes("Undersized"));

        console.log(`- Missing Dampers: ${missing.length}`);
        console.log(`- Undersized Ducts: ${undersized.length}`);

        // Save report
        const reportDir = path.resolve(process.cwd(), '../local-work/EPIC-0005_fire-damper-audit');
        fs.mkdirSync(reportDir, { recursive: true });
        const reportPath = path.join(reportDir, 'audit_report.json');
        fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
        console.log(`Full report saved to ${reportPath}`);
    }
}

run();
