import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";
import { listImprovementJobs, type ImprovementJobRecord } from "./job_store.js";

export type SkillCandidate = {
  id: string;
  title: string;
  source_job_fingerprints: string[];
  issue_keys: string[];
  tool_names: string[];
  occurrence_count: number;
  avg_impact_score: number;
  file_path: string;
};

function slugify(value: string): string {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function dedupe(values: Array<string | null | undefined>, maxItems: number, maxLen: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const clipped = text.length > maxLen ? `${text.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…` : text;
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= maxItems) break;
  }
  return out;
}

function clusterKey(job: ImprovementJobRecord): string {
  const firstIssue = (job.issue_keys?.[0] || "").trim().toLowerCase();
  const firstTool = (job.tool_names?.[0] || "").trim().toLowerCase();
  if (firstIssue) return `issue:${firstIssue}`;
  if (firstTool) return `tool:${firstTool}`;
  const title = (job.title || "").trim().toLowerCase();
  return title ? `title:${title}` : `job:${job.id}`;
}

function toMarkdown(args: {
  title: string;
  issueKeys: string[];
  tools: string[];
  jobs: ImprovementJobRecord[];
  avgImpact: number;
  totalOccurrence: number;
}): string {
  const lines = [
    `# ${args.title}`,
    "",
    "## Purpose",
    `Draft remediation skill synthesized from recurring improvement jobs (${args.jobs.length} jobs, ${args.totalOccurrence} occurrences).`,
    "",
    "## Trigger signals",
    ...args.issueKeys.map(key => `- issue: ${key}`),
    ...args.tools.map(tool => `- tool: ${tool}`),
    "",
    "## Suggested operator workflow",
    "1. Reproduce the failing scenario using the latest run bundle/session traces.",
    "2. Apply scoped mitigation in backend prompts/tool bridge with explicit dry-run safety where supported.",
    "3. Validate with targeted replay/unit tests before opening PR.",
    "4. Monitor recurrence across the next 10 similar sessions.",
    "",
    "## Failure modes",
    "- False-positive clustering can combine adjacent but distinct issue keys.",
    "- Missing run bundle artifacts can block deterministic replay.",
    "- Prompt-only mitigations can regress when tool contracts change.",
    "",
    "## When not to use",
    "- Do not use for one-off incidents with occurrence count = 1 unless severity is critical.",
    "- Do not use for auth/deployment/security-sensitive infrastructure tasks (human-only lane).",
    "",
    "## Tool contract version",
    "- tool_contract_version: v1",
    "",
    "## Provenance",
    `- avg_impact_score: ${args.avgImpact.toFixed(1)}`,
    ...args.jobs.slice(0, 12).map(job => `- fingerprint: ${job.fingerprint} (occurrence_count=${job.occurrence_count}, state=${job.state})`)
  ];
  return `${lines.join("\n")}\n`;
}

export function mineSkillCandidates(options?: { min_occurrence_count?: number; min_impact_score?: number; limit?: number }): SkillCandidate[] {
  const minOccurrence = Math.max(1, Math.trunc(Number(options?.min_occurrence_count ?? 2)));
  const minImpact = Math.max(0, Math.min(100, Number(options?.min_impact_score ?? 55)));
  const limit = Math.max(1, Math.trunc(Number(options?.limit ?? 5)));

  const jobs = listImprovementJobs({ limit: 500 }).filter(
    job => (job.occurrence_count ?? 0) >= minOccurrence && (job.impact_score ?? 0) >= minImpact
  );
  if (!jobs.length) return [];

  const clusters = new Map<string, ImprovementJobRecord[]>();
  for (const job of jobs) {
    const key = clusterKey(job);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key)!.push(job);
  }

  const layout = ensureWorkspaceLayout();
  const stagingDir = path.join(layout.skills, "local", ".staging");
  fs.mkdirSync(stagingDir, { recursive: true });

  const sortedClusters = Array.from(clusters.entries())
    .map(([key, clusterJobs]) => {
      const totalOccurrence = clusterJobs.reduce((sum, job) => sum + Math.max(1, job.occurrence_count || 1), 0);
      const weightedImpact = clusterJobs.reduce(
        (sum, job) => sum + Math.max(0, Number(job.impact_score || 0)) * Math.max(1, job.occurrence_count || 1),
        0
      );
      const avgImpact = totalOccurrence > 0 ? weightedImpact / totalOccurrence : 0;
      return { key, clusterJobs, totalOccurrence, avgImpact };
    })
    .sort((a, b) => b.avgImpact - a.avgImpact || b.totalOccurrence - a.totalOccurrence)
    .slice(0, limit);

  const out: SkillCandidate[] = [];
  for (const entry of sortedClusters) {
    const issueKeys = dedupe(entry.clusterJobs.flatMap(job => job.issue_keys ?? []), 6, 200);
    const tools = dedupe(entry.clusterJobs.flatMap(job => job.tool_names ?? []), 6, 120);
    const fingerprints = dedupe(entry.clusterJobs.map(job => job.fingerprint), 24, 120);
    const titleBase = issueKeys[0] || tools[0] || entry.clusterJobs[0]?.title || entry.key;
    const id = `candidate-${slugify(titleBase) || "improvement"}`;
    const filePath = path.join(stagingDir, `${id}.md`);
    const title = `Skill Candidate: ${titleBase}`;

    const markdown = toMarkdown({
      title,
      issueKeys,
      tools,
      jobs: entry.clusterJobs,
      avgImpact: entry.avgImpact,
      totalOccurrence: entry.totalOccurrence
    });
    fs.writeFileSync(filePath, markdown, "utf8");

    out.push({
      id,
      title,
      source_job_fingerprints: fingerprints,
      issue_keys: issueKeys,
      tool_names: tools,
      occurrence_count: entry.totalOccurrence,
      avg_impact_score: Math.round(entry.avgImpact * 10) / 10,
      file_path: filePath
    });
  }

  return out;
}
