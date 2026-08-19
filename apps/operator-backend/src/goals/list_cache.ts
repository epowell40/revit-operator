import fs from "node:fs";

type ListedRecord = {
  id: string;
  updated_at: string;
};

type ListCache<RecordType extends ListedRecord> = {
  rootVersion: string | null;
  knownIds: Set<string>;
  pendingIds: Set<string>;
  records: Map<string, RecordType>;
  ordered: RecordType[] | null;
};

const MAX_CACHED_ROOTS = 64;
const caches = new Map<string, ListCache<ListedRecord>>();

function directoryVersion(root: string): string {
  const stat = fs.statSync(root, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function touch<RecordType extends ListedRecord>(root: string, cache: ListCache<RecordType>): void {
  caches.delete(root);
  caches.set(root, cache as ListCache<ListedRecord>);
  while (caches.size > MAX_CACHED_ROOTS) caches.delete(caches.keys().next().value!);
}

function getCache<RecordType extends ListedRecord>(root: string): ListCache<RecordType> {
  let cache = caches.get(root) as ListCache<RecordType> | undefined;
  if (!cache) {
    cache = {
      rootVersion: null,
      knownIds: new Set<string>(),
      pendingIds: new Set<string>(),
      records: new Map<string, RecordType>(),
      ordered: null
    };
  }
  touch(root, cache);
  return cache;
}

export function resetGoalListCaches(): void {
  caches.clear();
}

export function observeListedGoal<RecordType extends ListedRecord>(root: string, record: RecordType): void {
  const cache = caches.get(root) as ListCache<RecordType> | undefined;
  if (!cache) return;
  cache.knownIds.add(record.id);
  cache.pendingIds.delete(record.id);
  cache.records.set(record.id, record);
  cache.ordered = null;
  touch(root, cache);
}

export function listCachedGoals<RecordType extends ListedRecord>(
  root: string,
  readRecord: (id: string) => RecordType | null
): RecordType[] {
  const cache = getCache<RecordType>(root);
  const version = directoryVersion(root);
  if (version !== cache.rootVersion) {
    const ids = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    const present = new Set(ids);
    for (const id of cache.knownIds) {
      if (!present.has(id)) {
        cache.knownIds.delete(id);
        cache.records.delete(id);
        cache.ordered = null;
      }
    }
    for (const id of cache.pendingIds) {
      if (!present.has(id)) cache.pendingIds.delete(id);
    }
    for (const id of ids) {
      if (!cache.knownIds.has(id)) cache.pendingIds.add(id);
    }
    cache.rootVersion = version;
  }
  for (const id of [...cache.pendingIds]) {
    const record = readRecord(id);
    if (!record) continue;
    cache.pendingIds.delete(id);
    cache.knownIds.add(id);
    cache.records.set(id, record);
    cache.ordered = null;
  }
  if (!cache.ordered) {
    cache.ordered = [...cache.records.values()]
      .sort((a, b) => `${b.updated_at}|${b.id}`.localeCompare(`${a.updated_at}|${a.id}`));
  }
  return [...cache.ordered];
}
