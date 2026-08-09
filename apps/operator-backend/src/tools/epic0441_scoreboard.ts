import path from "node:path";
import fs from "node:fs";
import { loadEpic0441Campaign } from "../benchmark/epic0441_campaign.js";
import { createEpic0441EvidenceManifestSkeleton, epic0441ReviewerPacketSha256, scoreEpic0441Campaign } from "../benchmark/epic0441_scoreboard.js";
import { writeJsonFile } from "../benchmark/files.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  console.error([
    "EPIC-0441 scorer-owned scoreboard",
    "",
    "  npm run benchmark:epic0441 -- init --campaign-seed <seed> --reviewer-packet <private-file> --output <evidence.json>",
    "  npm run benchmark:epic0441 -- score --manifest <evidence.json> --evidence-root <dir> --reviewer-packet <private-file> --output-dir <dir>"
  ].join("\n"));
  process.exit(2);
}

if (process.argv[2] === "init") {
  const campaignSeed = flag("--campaign-seed");
  const reviewerPacketPath = flag("--reviewer-packet");
  const outputPath = flag("--output");
  if (!campaignSeed || !reviewerPacketPath || !outputPath) usage();
  const reviewerBytes = fs.readFileSync(path.resolve(reviewerPacketPath));
  const manifest = createEpic0441EvidenceManifestSkeleton({
    campaign: loadEpic0441Campaign(), campaignSeed,
    reviewerPacketSha256: epic0441ReviewerPacketSha256(reviewerBytes),
    ...(process.argv.includes("--baseline-current-runtime") ? { dynamicSupportedTaskIds: ["r04_bulk_status_rule", "r12_move_device"] } : {})
  });
  writeJsonFile(path.resolve(outputPath), manifest);
  console.log(JSON.stringify({ output: path.resolve(outputPath), row_count: manifest.rows.length, reviewer_packet_sha256: manifest.reviewer_packet_sha256 }, null, 2));
  process.exit(0);
}
if (process.argv[2] !== "score") usage();
const evidenceManifestPath = flag("--manifest");
const evidenceRoot = flag("--evidence-root");
const reviewerPacketPath = flag("--reviewer-packet");
const outputDir = flag("--output-dir");
if (!evidenceManifestPath || !evidenceRoot || !reviewerPacketPath || !outputDir) usage();

const scored = scoreEpic0441Campaign({
  campaign: loadEpic0441Campaign(),
  evidenceManifestPath: path.resolve(evidenceManifestPath),
  evidenceRoot: path.resolve(evidenceRoot),
  reviewerPacketPath: path.resolve(reviewerPacketPath)
});
const resolvedOutput = path.resolve(outputDir);
writeJsonFile(path.join(resolvedOutput, "epic0441_scorer_owned_results.v1.json"), scored.results);
writeJsonFile(path.join(resolvedOutput, "epic0441_scoreboard.v1.json"), scored.scoreboard);
console.log(JSON.stringify({
  output_dir: resolvedOutput,
  row_count: scored.scoreboard.row_count,
  sealed_not_yet_run_count: scored.scoreboard.sealed_not_yet_run_count,
  mixed_tier_pair_count: scored.scoreboard.mixed_tier_pair_count,
  broad_live_acceptance_claimable: scored.scoreboard.broad_live_acceptance_claimable,
  reviewer_packet_sha256: scored.scoreboard.reviewer_packet_sha256,
  results_sha256: scored.scoreboard.results_sha256
}, null, 2));
