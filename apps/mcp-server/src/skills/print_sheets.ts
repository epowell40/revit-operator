import fs from "node:fs";
import path from "node:path";
import { callRevit } from "../lib/revitClient.js";
import { RunBundle } from "../lib/RunBundle.js";

type PrintMode = "bound" | "individual";

export interface PrintSheetsInput {
  query: string;
  mode?: PrintMode;
  setName?: string;
  outputFolder?: string;
  fileNameTemplate?: string;
  individualTemplate?: string;
  color?: boolean;
  dryRun?: boolean;
}

type Recipe = {
  sheetNumberPrefixes?: string[];
  nameIncludes?: string[];
};

function resolveRepoRelativePath(relPath: string): string {
  const cwd = process.cwd();
  const c0 = path.resolve(cwd, relPath);
  const c1 = path.resolve(cwd, "..", relPath);
  const c2 = path.resolve(cwd, "..", "..", relPath);
  const isMcpServerCwd = path.basename(cwd).toLowerCase() === "mcp-server";
  const candidates = isMcpServerCwd ? [c1, c0, c2] : [c0, c1, c2];
  const existing = candidates.find(p => fs.existsSync(p));
  return existing ?? (isMcpServerCwd ? c1 : c0);
}

function loadPrintRecipes(): Record<string, Recipe> {
  const candidates = [path.join("skills", "assets", "printSets.default.json")];
  try {
    const p = candidates.map(rel => resolveRepoRelativePath(rel)).find(full => fs.existsSync(full));
    if (!p) return {};
    const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, Recipe>;
  } catch {
    return {};
  }
}

function getBuiltInRecipes(): Record<string, Recipe> {
  // Minimal defaults when no repo recipe file is present.
  // These are conventions (can vary by firm/project), so they should be used as hints only.
  return {
    Mechanical: { sheetNumberPrefixes: ["M"] },
    Electrical: { sheetNumberPrefixes: ["E"] },
    Plumbing: { sheetNumberPrefixes: ["P"] },
    Architectural: { sheetNumberPrefixes: ["A"] },
    Structural: { sheetNumberPrefixes: ["S"] },
    Civil: { sheetNumberPrefixes: ["C"] },
    FireProtection: { sheetNumberPrefixes: ["FP"] },
  };
}

function normalize(s: unknown): string {
  return (s ?? "").toString().trim();
}

function normalizeLower(s: unknown): string {
  return normalize(s).toLowerCase();
}

function normalizeSheetQueryHint(s: string): string {
  return normalizeLower(s)
    .replace(/[^\w\s\-\*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferPrefixFromSeriesPhrase(queryRaw: string): string | null {
  // Examples:
  // - "m100 series sheets" => "m1"
  // - "M100s" => "m1"
  // - "M1xx" => "m1"
  // - "mech sheets" => null (handled elsewhere)
  const q = normalizeSheetQueryHint(queryRaw);
  if (!q) return null;

  // If the query explicitly says "series"/"set"/"xx"/"m100s", treat as series intent.
  const hasSeriesIntent =
    /\b(series|set)\b/.test(q) ||
    /\b[0-9]+s\b/.test(q) ||
    /\b[0-9]xx\b/.test(q) ||
    /\b[0-9]x{2,}\b/.test(q);
  if (!hasSeriesIntent) return null;

  // Find a sheet-like token and reduce it to letters + first digit (e.g. M100 -> M1).
  const m = q.match(/\b([a-z]{1,6})\s*[-_ ]?\s*(\d)\d{0,3}\b/i) || q.match(/\b([a-z]{1,6})(\d)x{2,}\b/i);
  if (!m) return null;
  const letters = (m[1] ?? "").trim();
  const firstDigit = (m[2] ?? "").trim();
  if (!letters || !firstDigit) return null;
  return `${letters}${firstDigit}`;
}

function safeFileName(s: string): string {
  const raw = normalize(s);
  const cleaned = raw.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : "Print";
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatYyyyMmDd(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function applyTemplate(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

function parseQueryToRecipeKeyOrSelector(queryRaw: string, recipes: Record<string, Recipe>): { setName?: string; recipe?: Recipe; selector: { prefixes: string[]; nameIncludes: string[] } } {
  const q = normalize(queryRaw);
  const qLower = q.toLowerCase();

  const selector = { prefixes: [] as string[], nameIncludes: [] as string[] };

  // If the user phrasing implies a series like "M100 series" or "M1xx", infer prefix "M1".
  const seriesPrefix = inferPrefixFromSeriesPhrase(q);
  if (seriesPrefix) {
    selector.prefixes.push(seriesPrefix);
    return { setName: safeFileName(q), selector };
  }

  // Recipe key direct match.
  for (const [k, v] of Object.entries(recipes)) {
    if (k.toLowerCase() === qLower) return { setName: k, recipe: v, selector: { prefixes: v.sheetNumberPrefixes ?? [], nameIncludes: v.nameIncludes ?? [] } };
  }

  // Common synonyms.
  const synonymMap: Record<string, string> = {
    mech: "Mechanical",
    mechanical: "Mechanical",
    "mechanical sheets": "Mechanical",
    "mech sheets": "Mechanical",
    "m sheets": "Mechanical",
    lighting: "Lighting",
    lights: "Lighting",
    "site plan": "SitePlan",
    siteplan: "SitePlan",
    site: "SitePlan"
  };
  const synKey = synonymMap[qLower];
  if (synKey && recipes[synKey]) return { setName: synKey, recipe: recipes[synKey], selector: { prefixes: recipes[synKey]?.sheetNumberPrefixes ?? [], nameIncludes: recipes[synKey]?.nameIncludes ?? [] } };

  // Heuristic fallback for common discipline words when recipes are missing.
  const builtIn = getBuiltInRecipes();
  for (const [k, v] of Object.entries(builtIn)) {
    const kLower = k.toLowerCase();
    if (qLower === kLower || qLower === `${kLower} sheets` || qLower === `${kLower} set`) {
      selector.prefixes.push(...(v.sheetNumberPrefixes ?? []));
      return { setName: k, selector };
    }
  }
  if (/\bmechanical\b/.test(qLower) || /\bmech\b/.test(qLower)) {
    selector.prefixes.push("M");
    return { setName: "Mechanical", selector };
  }

  // Prefix pattern (e.g. "M*", "M1*", "A2.00*", "FP-1*").
  // Treat a trailing "*" as a prefix-wildcard (aligned with /revit/sheets behavior).
  const star = q.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,30})\*$/);
  if (star) selector.prefixes.push(star[1]!);
  else if (/^[A-Za-z]{1,6}$/.test(q) && q.length <= 4) selector.prefixes.push(q);

  // title:/name: filters
  const title = q.match(/^(title|name)\s*:\s*(.+)$/i);
  if (title) selector.nameIncludes.push(title[2]!.trim());

  // Fall back: treat as "contains in name or number".
  if (selector.prefixes.length === 0 && selector.nameIncludes.length === 0) selector.nameIncludes.push(q);

  return { selector };
}

function matchSheet(sheet: any, selector: { prefixes: string[]; nameIncludes: string[] }): boolean {
  const num = normalizeLower(sheet?.sheetNumber ?? "");
  const name = normalizeLower(sheet?.name ?? "");

  const prefixOk =
    selector.prefixes.length === 0 ||
    selector.prefixes.some(p => num.startsWith(normalizeLower(p)));

  const nameOk =
    selector.nameIncludes.length === 0 ||
    selector.nameIncludes.some(t => {
      const n = normalizeLower(t);
      return n.length > 0 && (name.includes(n) || num.includes(n));
    });

  return prefixOk && nameOk;
}

export async function runPrintSheets(input: PrintSheetsInput) {
  const bundle = new RunBundle("print_sheets", input);
  await bundle.init();

  try {
    const recipes = { ...getBuiltInRecipes(), ...loadPrintRecipes() };
    const query = normalize(input.query);
    if (!query) throw new Error("query is required.");

    const mode: PrintMode = (input.mode ?? "bound") as PrintMode;
    if (mode !== "bound" && mode !== "individual") throw new Error("mode must be 'bound' or 'individual'.");

    const dryRun = !!input.dryRun;
    const color = input.color !== false;
    const colorMode = color ? "Color" : "BlackLine";

    const parsed = parseQueryToRecipeKeyOrSelector(query, recipes);
    const setName = safeFileName(normalize(input.setName) || parsed.setName || query);

    const now = new Date();
    const yyyyMMdd = formatYyyyMmDd(now);

    let project = "Project";
    const fileNameTemplate = normalize(input.fileNameTemplate) || "{project}_{setName}_{yyyyMMdd}";
    if (fileNameTemplate.includes("{project}")) {
      try {
        const ctx: any = await callRevit("/revit/context");
        project = safeFileName(normalize(ctx?.document?.title ?? ctx?.document?.name ?? ctx?.document?.path ?? "Project"));
      } catch {
        project = "Project";
      }
    }

    // Revit Bridge enforces writes under the per-user Workspace. If omitted, it defaults to artifacts/prints.
    const outputFolderRaw = normalize(input.outputFolder);
    const outputFolder = outputFolderRaw.length > 0 ? outputFolderRaw : undefined;
    const individualTemplate = normalize(input.individualTemplate) || "{sheetNumber}_{sheetName}";

    bundle.log("Loading sheets from Revit…");
    const sheets: any[] = [];
    const limit = 200;
    for (let offset = 0; offset < 2000; ) {
      const sheetsResp: any = await callRevit("/revit/sheets", "POST", { offset, limit });
      const items = Array.isArray(sheetsResp?.items) ? sheetsResp.items : [];
      sheets.push(...items);
      const hasMore = !!sheetsResp?.hasMore;
      const nextOffset = typeof sheetsResp?.nextOffset === "number" ? sheetsResp.nextOffset : offset + items.length;
      if (!hasMore) break;
      if (nextOffset <= offset) break;
      offset = nextOffset;
    }

    const selector = parsed.recipe ? { prefixes: parsed.recipe.sheetNumberPrefixes ?? [], nameIncludes: parsed.recipe.nameIncludes ?? [] } : parsed.selector;

    const matched = sheets
      .filter((s: any) => matchSheet(s, selector))
      .sort((a: any, b: any) => String(a?.sheetNumber ?? "").localeCompare(String(b?.sheetNumber ?? ""), undefined, { numeric: true }) || String(a?.name ?? "").localeCompare(String(b?.name ?? "")));

    if (matched.length === 0) {
      const hint = Object.keys(recipes).length > 0 ? `Available recipes: ${Object.keys(recipes).join(", ")}` : "No recipes file found.";
      throw new Error(`No sheets matched query "${query}". ${hint}`);
    }

    const baseFileName = safeFileName(
      applyTemplate(fileNameTemplate, { project, setName, yyyyMMdd })
    );

    const plan = matched.map((s: any) => ({
      viewId: s?.viewId ?? s?.id,
      id: s?.id,
      sheetNumber: s?.sheetNumber,
      name: s?.name,
      fileName:
        mode === "bound"
          ? `${baseFileName}.pdf`
          : `${safeFileName(applyTemplate(individualTemplate, { sheetNumber: safeFileName(String(s?.sheetNumber ?? "")), sheetName: safeFileName(String(s?.name ?? "")) }))}.pdf`
    }));

    if (dryRun) {
      const result = {
        dryRun: true,
        query,
        mode,
        setName,
        outputFolder,
        colorMode,
        matchedCount: matched.length,
        matchedSheets: plan
      };
      await bundle.complete(result);
      return result;
    }

    const viewIds = plan.map((p: any) => Number(p.viewId)).filter((n: number) => Number.isFinite(n));
    if (viewIds.length === 0) throw new Error("No valid viewIds were selected.");

    bundle.log(`Exporting ${viewIds.length} sheet(s) to PDF (${mode})…`);

    const exportReq: any = {
      viewIds,
      combine: mode === "bound",
      outputFolder,
      baseFileName,
      perSheetFileNameTemplate: individualTemplate,
      colorMode,
      dryRun: false
    };

    const exportResp: any = await callRevit("/revit/export-pdf", "POST", exportReq);
    const result = {
      dryRun: false,
      query,
      mode,
      setName,
      outputFolder,
      colorMode,
      matchedCount: matched.length,
      export: exportResp
    };

    await bundle.complete(result);
    return result;
  } catch (e) {
    await bundle.fail(e);
    throw e;
  }
}
