import * as fs from 'fs';
import * as path from 'path';

export class RunBundle {
    public runId: string;
    public dirPath: string;
    public artifactsPath: string;
    private logEntries: any[] = [];
    private startTime: Date;
    private skillName: string;
    private inputs: any = {};

    constructor(skillName: string, inputs: any = {}) {
        this.skillName = skillName;
        this.inputs = inputs;
        this.startTime = new Date();
        const timestamp = this.startTime.toISOString().replace(/[:.]/g, '-');
        this.runId = `${timestamp}_${skillName}`;
        
        // CWD is expected to be Repo Root
        this.dirPath = path.join(process.cwd(), 'runs', this.runId);
        this.artifactsPath = path.join(this.dirPath, 'artifacts');
    }

    public async init() {
        if (!fs.existsSync(this.dirPath)) {
            await fs.promises.mkdir(this.dirPath, { recursive: true });
        }
        if (!fs.existsSync(this.artifactsPath)) {
            await fs.promises.mkdir(this.artifactsPath, { recursive: true });
        }
        
        this.log("RunBundle initialized", { runId: this.runId, path: this.dirPath });
    }

    public log(message: string, data?: any) {
        const entry = {
            timestamp: new Date().toISOString(),
            message,
            data
        };
        this.logEntries.push(entry);
        try {
            process.stderr.write(`[${this.skillName}] ${message}\n`);
        } catch {
            // ignore
        }
    }

    public async saveArtifact(filename: string, content: Buffer | string) {
        const filePath = path.join(this.artifactsPath, filename);
        await fs.promises.writeFile(filePath, content);
        this.log(`Artifact saved: ${filename}`);
        return filePath;
    }

    public async complete(result: any) {
        const duration = new Date().getTime() - this.startTime.getTime();
        const runData = {
            schemaVersion: "1.0",
            runId: this.runId,
            skill: this.skillName,
            status: "success",
            startTime: this.startTime.toISOString(),
            durationMs: duration,
            inputs: this.inputs,
            result,
            logs: this.logEntries
        };
        
        await fs.promises.writeFile(path.join(this.dirPath, 'run.json'), JSON.stringify(runData, null, 2));
        this.log("RunBundle completed successfully.");
    }

    public async fail(error: any) {
        const duration = new Date().getTime() - this.startTime.getTime();
         const runData = {
            schemaVersion: "1.0",
            runId: this.runId,
            skill: this.skillName,
            status: "failed",
            startTime: this.startTime.toISOString(),
            durationMs: duration,
            inputs: this.inputs,
            error: error instanceof Error ? error.message : String(error),
            logs: this.logEntries
        };
        
        await fs.promises.writeFile(path.join(this.dirPath, 'run.json'), JSON.stringify(runData, null, 2));
        this.log("RunBundle failed.");
    }
}
