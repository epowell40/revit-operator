import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function assertGeneralRevitExportIsolationPolicy(requested: boolean, declared: unknown, rescoreOnly: boolean): void {
  if (!rescoreOnly && requested !== (declared === true)) {
    throw new Error("Export isolation CLI and protocol envelope policy must match.");
  }
}

export function retainedGeneralRevitExportIsolation(prior: unknown, rescoreOnly: boolean): Record<string, unknown> | null {
  return rescoreOnly && prior !== null && typeof prior === "object" && !Array.isArray(prior)
    ? { ...prior as Record<string, unknown> } : null;
}

// Native export defaults only. Durable assignments, uploads, compilation
// caches, and verification stores are not disposable export directories.
export const GENERAL_REVIT_EXPORT_FOLDERS = ["prints", "schedules", "dwg", "ifc", "xlsx", "reports", "captures"] as const;
type FileReceipt = { source_path: string; retained_path: string; size_bytes: number; sha256: string };
function within(parent: string, child: string): string {
  const result = path.resolve(parent, child), relative = path.relative(path.resolve(parent), result);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("export_isolation_path_escape");
  return result;
}
function noLinks(file: string): void {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("export_isolation_link_rejected:" + file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const parent = path.dirname(file);
  if (parent !== file) noLinks(parent);
}
function inventory(source: string, destination: string): FileReceipt[] {
  noLinks(source);
  if (!fs.existsSync(source)) return [];
  const files: FileReceipt[] = [];
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const file = within(source, entry.name), retained = within(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error("export_isolation_link_rejected:" + file);
    if (entry.isDirectory()) files.push(...inventory(file, retained));
    else if (entry.isFile()) files.push({ source_path: file, retained_path: retained,
      size_bytes: fs.statSync(file).size, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
    else throw new Error("export_isolation_nonregular_file:" + file);
  }
  return files.sort((a, b) => a.source_path.localeCompare(b.source_path));
}

export class GeneralRevitExportIsolation {
  readonly root: string;
  readonly retained: string;
  private readonly originals: string[] = [];
  private readonly originalReceipts: FileReceipt[] = [];
  private active: string | null = null;
  private readonly completed = new Set<string>();
  private readonly journal: string;
  constructor(workspaceRoot: string, retainedRoot: string) {
    if (!path.isAbsolute(workspaceRoot) || !path.isAbsolute(retainedRoot)) throw new Error("export_isolation_requires_absolute_roots");
    this.root = within(workspaceRoot, "artifacts");
    this.retained = path.resolve(retainedRoot);
    if (this.retained === this.root || path.relative(this.root, this.retained).split(path.sep)[0] !== "..") throw new Error("export_isolation_retention_inside_live_root");
    noLinks(workspaceRoot);
    fs.mkdirSync(this.root, { recursive: true }); noLinks(this.root);
    // Refuse a prior run, including an interrupted partial setup. Its journal
    // and originals must be recovered explicitly, never overwritten on resume.
    if (fs.existsSync(this.retained)) throw new Error("export_isolation_retention_already_exists");
    noLinks(this.retained); fs.mkdirSync(this.retained, { recursive: true });
    this.journal = within(this.retained, "journal.jsonl");
    fs.writeFileSync(this.journal, "", { flag: "wx" });
    const originalRoot = within(this.retained, "originals"); fs.mkdirSync(originalRoot);
    const before = GENERAL_REVIT_EXPORT_FOLDERS.flatMap(folder => inventory(within(this.root, folder), within(originalRoot, folder)));
    this.originalReceipts.push(...before);
    this.record({ event: "initialize", live_root: this.root, folders: GENERAL_REVIT_EXPORT_FOLDERS, files: before });
    for (const folder of GENERAL_REVIT_EXPORT_FOLDERS) {
      const live = within(this.root, folder), saved = within(originalRoot, folder);
      if (fs.existsSync(live)) {
        this.record({ event: "retain_original", live, saved });
        fs.renameSync(live, saved); this.originals.push(folder);
      }
      fs.mkdirSync(live);
    }
    this.record({ event: "ready", originals: this.originals });
  }
  private record(value: unknown): void { fs.appendFileSync(this.journal, JSON.stringify({ at: new Date().toISOString(), ...value as object }) + "\n"); }
  begin(caseId: string): void {
    if (this.active || this.completed.has(caseId) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,160}$/.test(caseId)) throw new Error("export_isolation_case_identity_invalid");
    for (const folder of GENERAL_REVIT_EXPORT_FOLDERS) {
      const live = within(this.root, folder); noLinks(live);
      if (fs.readdirSync(live).length) throw new Error("export_isolation_start_not_empty:" + live);
    }
    this.active = caseId; this.record({ event: "case_started_empty", case_id: caseId });
  }
  finish(caseId: string, quiescent: boolean): { case_id: string; files: FileReceipt[]; initial_state: string; scope: readonly string[] } {
    if (this.active !== caseId || !quiescent) throw new Error("export_isolation_requires_exact_quiescent_case");
    const destination = within(this.retained, "cases/" + caseId);
    noLinks(destination);
    if (fs.existsSync(destination)) throw new Error("export_isolation_case_already_retained");
    const files = GENERAL_REVIT_EXPORT_FOLDERS.flatMap(folder => inventory(within(this.root, folder), within(destination, folder)));
    this.record({ event: "retain_case", case_id: caseId, files });
    fs.mkdirSync(destination, { recursive: true }); noLinks(destination);
    for (const folder of GENERAL_REVIT_EXPORT_FOLDERS) {
      fs.renameSync(within(this.root, folder), within(destination, folder));
      fs.mkdirSync(within(this.root, folder));
    }
    for (const file of files) {
      if (createHash("sha256").update(fs.readFileSync(file.retained_path)).digest("hex") !== file.sha256) throw new Error("export_isolation_retained_hash_mismatch");
    }
    const receipt = { case_id: caseId, files, initial_state: "empty_native_export_folders", scope: GENERAL_REVIT_EXPORT_FOLDERS };
    fs.writeFileSync(within(destination, "manifest.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    this.active = null; this.completed.add(caseId); this.record({ event: "case_retained", case_id: caseId });
    return receipt;
  }
  restore(): void {
    if (this.active) throw new Error("export_isolation_active_case_requires_recovery");
    const originals = GENERAL_REVIT_EXPORT_FOLDERS.flatMap(folder => inventory(within(this.retained, "originals/" + folder), within(this.root, folder)));
    if (originals.length !== this.originalReceipts.length || originals.some(file => !this.originalReceipts.some(
      expected => expected.retained_path === file.source_path && expected.sha256 === file.sha256))) throw new Error("export_isolation_originals_changed");
    for (const folder of GENERAL_REVIT_EXPORT_FOLDERS) {
      const live = within(this.root, folder); noLinks(live);
      if (fs.readdirSync(live).length) throw new Error("export_isolation_restore_would_overwrite:" + live);
    }
    this.record({ event: "restore_originals", originals: this.originals });
    for (const folder of GENERAL_REVIT_EXPORT_FOLDERS) {
      const live = within(this.root, folder), saved = within(this.retained, "originals/" + folder);
      fs.rmdirSync(live); // Verified empty, exact owned directory; never recursive.
      if (this.originals.includes(folder)) fs.renameSync(saved, live);
    }
    this.record({ event: "restored" });
  }
}
