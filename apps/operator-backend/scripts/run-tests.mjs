import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const testDirectory = path.join("dist", "test");
const files = (await readdir(testDirectory))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDirectory, name));

if (files.length === 0) {
  console.error(`No compiled test files found in ${testDirectory}. Run npm run build first.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
