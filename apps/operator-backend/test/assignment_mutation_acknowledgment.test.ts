import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Execute the same generic UI protocol tests in either source or compiled
// layout. The public package is independent of the private Sidecar shell.
let directory = path.dirname(fileURLToPath(import.meta.url));
let sharedTests = "";
for (let depth = 0; depth < 7; depth++) {
  const candidate = path.join(directory, "packages/operator-assistant-ui/assignment_mutation.test.mjs");
  if (fs.existsSync(candidate)) { sharedTests = candidate; break; }
  directory = path.dirname(directory);
}
if (!sharedTests) throw new Error("Shared assignment acknowledgment protocol tests are missing.");
await import(pathToFileURL(sharedTests).href);
