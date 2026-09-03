import fs from "node:fs";
import path from "node:path";
import { validateEpic0437NativeBuildManifest } from "../capabilities/epic_0437_source_provenance.js";

const candidateSourceHash = process.argv[2];
if (!candidateSourceHash || !/^sha256:[0-9a-f]{64}$/.test(candidateSourceHash)) {
  throw new Error("Expected one exact EPIC-0437 candidate source hash");
}

const requestedRepoRoot = process.argv[3];
if (!requestedRepoRoot || !path.isAbsolute(requestedRepoRoot)) {
  throw new Error("Expected one explicit absolute repository root");
}
const repoRoot = path.resolve(requestedRepoRoot);
if (!fs.existsSync(path.join(repoRoot, "apps", "operator-backend", "config", "tool_exposure_policy.v1.json"))) {
  throw new Error(`EPIC-0437 repository root is invalid: ${repoRoot}`);
}
const validated = validateEpic0437NativeBuildManifest(repoRoot, candidateSourceHash);
console.log(`Validated final EPIC-0437 source/native manifest: ${validated.sha256}`);
