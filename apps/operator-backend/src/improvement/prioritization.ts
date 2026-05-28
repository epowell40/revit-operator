export type ImprovementPrioritizationSignal = {
  fingerprint?: string | null;
  source: string;
  subsystem?: string | null;
  rating?: string | null;
  occurrence_count?: number;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  severity?: number | null;
  confidence?: number | null;
  tools?: string[] | null;
  issue_keys?: string[] | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeCount(value: number | undefined | null, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Number(value));
}

function parseIsoMs(value: string | null | undefined): number | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function ratingSeverity(rating: string | null | undefined): number {
  const normalized = (rating ?? "").trim().toLowerCase();
  if (normalized === "failed") return 0.95;
  if (normalized === "partial") return 0.7;
  if (normalized === "worked") return 0.2;
  return 0.5;
}

function sourceWeight(source: string): number {
  const normalized = (source ?? "").trim().toLowerCase();
  if (normalized === "feedback") return 1;
  if (normalized === "github_issue") return 0.95;
  if (normalized === "nightly_triage") return 0.85;
  if (normalized === "upload_queue") return 0.8;
  if (normalized === "manual") return 0.6;
  return 0.7;
}

function recencyScore(lastSeenAt: string | null | undefined): number {
  const lastSeenMs = parseIsoMs(lastSeenAt);
  if (lastSeenMs === null) return 0.45;
  const ageHours = Math.max(0, (Date.now() - lastSeenMs) / (1000 * 60 * 60));
  if (ageHours <= 12) return 1;
  if (ageHours <= 48) return 0.85;
  if (ageHours <= 24 * 7) return 0.65;
  if (ageHours <= 24 * 14) return 0.5;
  return 0.35;
}

function frequencyScore(count: number): number {
  if (count <= 0) return 0.1;
  return clamp(Math.log2(count + 1) / 3, 0.15, 1);
}

function toolBreadthScore(tools: string[] | null | undefined, issueKeys: string[] | null | undefined): number {
  const toolCount = Array.isArray(tools) ? tools.filter(Boolean).length : 0;
  const issueCount = Array.isArray(issueKeys) ? issueKeys.filter(Boolean).length : 0;
  const total = toolCount + issueCount;
  if (total <= 0) return 0.2;
  return clamp(total / 6, 0.25, 1);
}

export function computeImpactScore(input: ImprovementPrioritizationSignal): number {
  const count = safeCount(input.occurrence_count, 1);
  const severity = clamp(Number.isFinite(input.severity) ? Number(input.severity) : ratingSeverity(input.rating), 0, 1);
  const confidence = clamp(Number.isFinite(input.confidence) ? Number(input.confidence) : 0.6, 0, 1);
  const frequency = frequencyScore(count);
  const recency = recencyScore(input.last_seen_at ?? input.first_seen_at ?? null);
  const breadth = toolBreadthScore(input.tools, input.issue_keys);
  const source = sourceWeight(input.source);

  const raw =
    severity * 0.34 +
    frequency * 0.24 +
    recency * 0.18 +
    confidence * 0.12 +
    breadth * 0.07 +
    source * 0.05;

  return Math.round(clamp(raw, 0, 1) * 1000) / 10;
}

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function takeTop(values: string[], max = 3): string[] {
  return values.slice(0, Math.max(1, max));
}

export type ImprovementCluster = {
  key: string;
  fingerprint_keys: string[];
  issue_keys: string[];
  tools: string[];
  source_mix: string[];
  occurrence_count: number;
  weighted_impact_score: number;
};

export function clusterImprovementSignals(signals: ImprovementPrioritizationSignal[]): ImprovementCluster[] {
  const buckets = new Map<
    string,
    {
      key: string;
      fingerprints: Set<string>;
      issueKeys: Set<string>;
      tools: Set<string>;
      sources: Set<string>;
      occurrence: number;
      weightedScore: number;
    }
  >();

  for (const signal of signals ?? []) {
    const subsystem = normalizeKey(signal?.subsystem);
    const issueKey = normalizeKey(Array.isArray(signal?.issue_keys) ? String(signal.issue_keys[0] ?? "") : "");
    const toolKey = normalizeKey(Array.isArray(signal?.tools) ? String(signal.tools[0] ?? "") : "");
    const group = subsystem || issueKey || toolKey || normalizeKey(signal?.source) || "unknown";
    if (!buckets.has(group)) {
      buckets.set(group, {
        key: group,
        fingerprints: new Set<string>(),
        issueKeys: new Set<string>(),
        tools: new Set<string>(),
        sources: new Set<string>(),
        occurrence: 0,
        weightedScore: 0
      });
    }
    const bucket = buckets.get(group)!;
    const signalOccurrence = safeCount(signal?.occurrence_count, 1);
    const signalScore = computeImpactScore(signal);
    bucket.occurrence += signalOccurrence;
    bucket.weightedScore += signalScore * signalOccurrence;
    const fp = normalizeKey(signal?.fingerprint);
    if (fp) bucket.fingerprints.add(fp);
    for (const issue of signal?.issue_keys ?? []) {
      const normalized = normalizeKey(issue);
      if (normalized) bucket.issueKeys.add(issue.trim());
    }
    for (const tool of signal?.tools ?? []) {
      const normalized = normalizeKey(tool);
      if (normalized) bucket.tools.add(tool.trim());
    }
    const source = normalizeKey(signal?.source);
    if (source) bucket.sources.add(source);
  }

  return Array.from(buckets.values())
    .map(bucket => ({
      key: bucket.key,
      fingerprint_keys: Array.from(bucket.fingerprints),
      issue_keys: takeTop(Array.from(bucket.issueKeys), 5),
      tools: takeTop(Array.from(bucket.tools), 5),
      source_mix: Array.from(bucket.sources),
      occurrence_count: bucket.occurrence,
      weighted_impact_score: bucket.occurrence > 0 ? Math.round((bucket.weightedScore / bucket.occurrence) * 10) / 10 : 0
    }))
    .sort((a, b) => b.weighted_impact_score - a.weighted_impact_score || b.occurrence_count - a.occurrence_count || a.key.localeCompare(b.key));
}

export type ImprovementCampaign = {
  campaign_key: string;
  subsystem: string;
  job_count: number;
  total_occurrences: number;
  avg_impact_score: number;
  top_issue_keys: string[];
  top_tools: string[];
};

export function buildIssueCampaigns(signals: ImprovementPrioritizationSignal[]): ImprovementCampaign[] {
  return clusterImprovementSignals(signals)
    .filter(cluster => cluster.fingerprint_keys.length > 1 || cluster.occurrence_count > 1)
    .map(cluster => ({
      campaign_key: `campaign/${cluster.key}`,
      subsystem: cluster.key,
      job_count: Math.max(cluster.fingerprint_keys.length, 1),
      total_occurrences: cluster.occurrence_count,
      avg_impact_score: cluster.weighted_impact_score,
      top_issue_keys: takeTop(cluster.issue_keys, 3),
      top_tools: takeTop(cluster.tools, 3)
    }))
    .sort((a, b) => b.avg_impact_score - a.avg_impact_score || b.total_occurrences - a.total_occurrences);
}
