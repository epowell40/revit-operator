export type LiveLevelIdentity = { id: number; name: string };
export type ResolvedLevelIdentity = LiveLevelIdentity & { requested: string; match: "exact" | "canonical_alias" };
export type LevelIdentityResolution = { status: "resolved"; levels: ResolvedLevelIdentity[]; blockers: [] } | { status: "blocked"; levels: []; blockers: string[] };

function clean(value: unknown): string { return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : ""; }

export function canonicalLevelAlias(value: string): string | null {
  const text = clean(value).toLocaleLowerCase();
  let match = /^(?:level|lvl)\s+([a-z0-9]+)(.*)$/.exec(text);
  if (!match) match = /^l([0-9]+)(.*)$/.exec(text);
  if (!match) return null;
  const suffix = clean(match[2]).replace(/^[\s:–—-]+/, "").replace(/[^a-z0-9]+/g, " ").trim();
  return `${match[1]}${suffix ? `|${suffix}` : ""}`;
}

export function resolveLevelIdentities(requestedValues: unknown, liveValues: unknown): LevelIdentityResolution {
  if (!Array.isArray(requestedValues) || requestedValues.length < 1 || requestedValues.length > 8) return { status: "blocked", levels: [], blockers: ["Requested level scope must contain 1-8 names."] };
  if (!Array.isArray(liveValues) || liveValues.length < 1 || liveValues.length >= 500) return { status: "blocked", levels: [], blockers: ["The bounded live level inventory is empty or may be truncated."] };
  const requested = requestedValues.map(clean);
  if (requested.some(value => !value || value.length > 160)) return { status: "blocked", levels: [], blockers: ["Requested level scope contains an invalid name."] };
  const live = liveValues.flatMap(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const row = raw as Record<string, unknown>;
    const name = clean(row.name);
    return Number.isSafeInteger(row.id) && (row.id as number) > 0 && name ? [{ id: row.id as number, name }] : [];
  });
  if (live.length !== liveValues.length || new Set(live.map(level => level.id)).size !== live.length) return { status: "blocked", levels: [], blockers: ["Live level inventory contains malformed or duplicate identities."] };

  const resolved: ResolvedLevelIdentity[] = [];
  for (const value of requested) {
    const exact = live.filter(level => level.name.toLocaleLowerCase() === value.toLocaleLowerCase());
    if (exact.length === 1) { resolved.push({ ...exact[0], requested: value, match: "exact" }); continue; }
    if (exact.length > 1) return { status: "blocked", levels: [], blockers: [`Level '${value}' is ambiguous in the live model.`] };
    const key = canonicalLevelAlias(value);
    const aliases = key ? live.filter(level => canonicalLevelAlias(level.name) === key) : [];
    if (aliases.length === 1) { resolved.push({ ...aliases[0], requested: value, match: "canonical_alias" }); continue; }
    return { status: "blocked", levels: [], blockers: [aliases.length > 1 ? `Level alias '${value}' is ambiguous in the live model.` : `Level '${value}' was not found in the live model.`] };
  }
  if (new Set(resolved.map(level => level.id)).size !== resolved.length) return { status: "blocked", levels: [], blockers: ["Multiple requested level names resolve to the same live level."] };
  return { status: "resolved", levels: resolved, blockers: [] };
}
