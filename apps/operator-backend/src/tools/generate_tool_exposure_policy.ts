import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateToolExposurePolicy,
  renderCanonicalDocument,
  type ToolCertificationEvidenceFile
} from "../capabilities/tool_certification.js";

export function generatePolicyBytes(rawEvidence: string): string {
  const normalized = rawEvidence.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const evidence = JSON.parse(normalized) as ToolCertificationEvidenceFile;
  return renderCanonicalDocument(generateToolExposurePolicy(evidence) as unknown as import("../capabilities/tool_certification.js").JsonValue);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function runCli(): void {
  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const inputPath = path.resolve(argument("--input") ?? path.join(backendRoot, "config", "tool_certification_evidence.v1.json"));
  const outputPath = path.resolve(argument("--output") ?? path.join(backendRoot, "config", "tool_exposure_policy.v1.json"));
  const generated = generatePolicyBytes(fs.readFileSync(inputPath, "utf8"));

  if (process.argv.includes("--check")) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").replace(/\r\n?/g, "\n") : "";
    if (current !== generated) {
      console.error(`Tool exposure policy is stale: ${outputPath}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Tool exposure policy is deterministic and current: ${outputPath}`);
    return;
  }

  if (process.argv.includes("--stdout")) {
    process.stdout.write(generated);
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated, "utf8");
  console.log(`Wrote tool exposure policy: ${outputPath}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) runCli();
