import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

async function compiledTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await compiledTests(candidate));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(candidate);
  }
  return files;
}

const testDirectory = "dist";
const files = await compiledTests(testDirectory);
if (files.length === 0) {
  console.error(`No compiled test files found under ${testDirectory}. Run npm run build first.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
