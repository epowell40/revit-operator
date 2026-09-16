import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const testDirectory = path.join("dist", "test");
const selected = process.argv.slice(2);
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

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
  stdio: "inherit",
  // A workstation's .env.local can enable a real provider and V2. Tests start
  // from the legacy baseline; fixtures opt into their intended provider/kernel
  // explicitly. Never launch a real model merely to warm an HTTP test server.
  env: { ...process.env, OPERATOR_BRAIN: "rule", OPERATOR_ASSIGNMENT_KERNEL_V2: "0" }
});

process.exit(result.status ?? 1);
