import { readdir, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const testDirectory = path.join("dist", "test");
const args = process.argv.slice(2);
const jobOptions = args.filter((value) => value.startsWith("--jobs="));
if (jobOptions.length > 1) throw new Error("Specify --jobs only once.");
const jobs = jobOptions.length ? Number(jobOptions[0].slice("--jobs=".length)) : 1;
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) throw new Error("--jobs must be an integer from 1 to 8.");
const selected = args.filter((value) => !value.startsWith("--jobs="));
const files = selected.length ? selected : (await readdir(testDirectory))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDirectory, name));

for (const file of files) {
  const relative = path.relative(path.resolve(testDirectory), path.resolve(file));
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".test.js")) {
    throw new Error(`Expected a compiled test beneath ${testDirectory}: ${file}`);
  }
}

if (files.length === 0) {
  console.error(`No compiled test files found in ${testDirectory}. Run npm run build first.`);
  process.exit(1);
}

const batchRoot = await mkdtemp(path.join(os.tmpdir(), "operator-test-batch-"));
// A workstation's .env.local can enable a real provider and V2. Tests start
// from the legacy baseline; fixtures opt into their intended provider/kernel
// explicitly. Never launch a real model merely to warm an HTTP test server.
const baselineEnv = { ...process.env, OPERATOR_BRAIN: "rule", OPERATOR_ASSIGNMENT_KERNEL_V2: "0" };
let code;
if (jobs === 1) {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    stdio: "inherit",
    env: { ...baselineEnv, OPERATOR_WORKSPACE_ROOT: batchRoot }
  });
  code = result.status ?? 1;
} else {
  // Node isolates test files in processes, but the Operator also writes into
  // OPERATOR_WORKSPACE_ROOT. Give each file a different root before allowing
  // bounded parallel execution; a shared test database would make this unsafe.
  let next = 0;
  let failures = 0;
  async function runFile(file, index) {
    const workspaceRoot = path.join(batchRoot, String(index).padStart(4, "0"));
    await mkdir(workspaceRoot);
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--test", file], {
        env: { ...baselineEnv, OPERATOR_WORKSPACE_ROOT: workspaceRoot },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "";
      let settled = false;
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        process.stderr.write(`TEST_FILE_FAILED ${file}: ${error.message}\n`);
        resolve(1);
      });
      child.on("close", (status) => {
        if (settled) return;
        settled = true;
        process.stdout.write(`\n== TEST_FILE ${file} ==\n${output}`);
        resolve(status ?? 1);
      });
    });
  }
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, async () => {
    while (next < files.length) {
      const index = next++;
      if (await runFile(files[index], index) !== 0) failures++;
    }
  }));
  code = failures ? 1 : 0;
  process.stdout.write(`\nTEST_BATCH files=${files.length} jobs=${jobs} failures=${failures}\n`);
}
if (code === 0) {
  const owned = path.resolve(batchRoot);
  if (path.dirname(owned) !== path.resolve(os.tmpdir()) || !path.basename(owned).startsWith("operator-test-batch-")) {
    throw new Error("Refusing cleanup outside the owned test workspace.");
  }
  await rm(owned, { recursive: true, force: true });
} else console.error(`Failed test workspace retained: ${batchRoot}`);
process.exit(code);
