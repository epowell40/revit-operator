import fs from "node:fs";

type IndexedJob = {
  id: string;
  status: string;
};

type ActiveJobIndex<Job extends IndexedJob> = {
  rootVersion: string | null;
  knownIds: Set<string>;
  activeJobs: Map<string, Job>;
  unresolvedUntil: Map<string, number>;
};

const UNRESOLVED_JOB_RETRY_MS = 5_000;
const indexes = new Map<string, ActiveJobIndex<IndexedJob>>();

function isTerminal(job: IndexedJob): boolean {
  return job.status === "succeeded" || job.status === "failed";
}

function rootVersion(root: string): string {
  const stat = fs.statSync(root, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function getIndex<Job extends IndexedJob>(root: string): ActiveJobIndex<Job> {
  let index = indexes.get(root) as ActiveJobIndex<Job> | undefined;
  if (!index) {
    index = {
      rootVersion: null,
      knownIds: new Set<string>(),
      activeJobs: new Map<string, Job>(),
      unresolvedUntil: new Map<string, number>()
    };
    indexes.set(root, index as ActiveJobIndex<IndexedJob>);
  }
  return index;
}

export function resetActiveJobIndexes(): void {
  indexes.clear();
}

export function observeIndexedJob<Job extends IndexedJob>(root: string, job: Job): void {
  const index = indexes.get(root) as ActiveJobIndex<Job> | undefined;
  if (!index) return;
  index.knownIds.add(job.id);
  index.unresolvedUntil.delete(job.id);
  if (isTerminal(job)) index.activeJobs.delete(job.id);
  else index.activeJobs.set(job.id, job);
}

export function enumerateActiveJobs<Job extends IndexedJob>(
  root: string,
  readJob: (id: string) => Job | null
): Job[] {
  const now = Date.now();
  const index = getIndex<Job>(root);
  try {
    const version = rootVersion(root);
    if (version !== index.rootVersion) {
      const ids = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^[a-zA-Z0-9._:-]+$/.test(entry.name))
        .map(entry => entry.name);
      const present = new Set(ids);
      for (const id of index.knownIds) {
        if (!present.has(id)) {
          index.knownIds.delete(id);
          index.activeJobs.delete(id);
          index.unresolvedUntil.delete(id);
        }
      }
      for (const id of ids) {
        if (index.knownIds.has(id)) continue;
        const job = readJob(id);
        if (!job) index.unresolvedUntil.set(id, now + UNRESOLVED_JOB_RETRY_MS);
        else observeIndexedJob(root, job);
      }
      index.rootVersion = version;
    }
    for (const [id, deadline] of index.unresolvedUntil) {
      const job = readJob(id);
      if (job) observeIndexedJob(root, job);
      else if (deadline <= now) {
        index.unresolvedUntil.delete(id);
        index.knownIds.add(id);
      }
    }
    for (const id of [...index.activeJobs.keys()]) {
      const job = readJob(id);
      if (!job || isTerminal(job)) index.activeJobs.delete(id);
      else index.activeJobs.set(id, job);
    }
    return [...index.activeJobs.values()];
  } catch {
    return [];
  }
}
