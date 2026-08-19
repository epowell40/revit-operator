import { getMacroSkillsDirs, loadMacroSkill, saveMacroSkill, type MacroSkill } from "./macro_skills.js";

const DEFAULT_SKILLS: MacroSkill[] = [
  {
    id: "import_drawing_spec",
    name: "Import Drawing Spec (Word/Text)",
    description:
      "Import a .docx or .txt spec from Workspace into a drafting view as multi-column text notes (8.5x11-style columns).",
    inputs: [
      {
        name: "sourcePath",
        required: true,
        description: "Path under Workspace (e.g. artifacts/specs/Project_Spec.docx)."
      },
      { name: "viewName", required: false, default: "Drawing Spec", description: "Drafting view name to create." },
      { name: "columns", required: false, default: 4, description: "Number of columns to fill left-to-right." },
      { name: "columnWidthInches", required: false, default: 8.5, description: "Column width in inches." },
      { name: "columnHeightInches", required: false, default: 11.0, description: "Column height in inches." },
      { name: "gutterInches", required: false, default: 0.25, description: "Gap between columns in inches." },
      { name: "marginInches", required: false, default: 0.25, description: "Inset margin inside each column in inches." },
      { name: "textTypeName", required: false, description: "Optional TextNoteType name to use." }
    ],
    actions: [
      {
        method: "POST",
        path: "/revit/import-drawing-spec",
        title: "Import drawing spec",
        body: {
          sourcePath: "{{sourcePath}}",
          viewName: "{{viewName}}",
          columns: "{{columns}}",
          columnWidthInches: "{{columnWidthInches}}",
          columnHeightInches: "{{columnHeightInches}}",
          gutterInches: "{{gutterInches}}",
          marginInches: "{{marginInches}}",
          textTypeName: "{{textTypeName}}"
        }
      }
    ],
    requiresApproval: true,
    tags: ["drafting", "spec", "docx", "text"]
  }
  ,
  {
    id: "import_excel_table",
    name: "Import Excel Table (Drafting)",
    description: "Import an .xlsx A1 range from Workspace into a Drafting View as a drafting table (grid + text).",
    inputs: [
      { name: "sourcePath", required: true, description: "Path under Workspace (e.g. artifacts/uploads/VentTable.xlsx)." },
      { name: "sheetName", required: false, description: "Worksheet name (default: first sheet)." },
      { name: "range", required: true, description: "A1 range like A1:G40." },
      { name: "viewName", required: false, default: "Excel Table", description: "Drafting view name to create/reuse." },
      { name: "cellWidthInches", required: false, default: 1.0, description: "Cell width in inches." },
      { name: "cellHeightInches", required: false, default: 0.25, description: "Cell height in inches." },
      { name: "marginInches", required: false, default: 0.06, description: "Text margin inset in inches." },
      { name: "textTypeName", required: false, description: "Optional TextNoteType name to use." },
      { name: "lineStyleName", required: false, description: "Optional line style name (subcategory under Lines)." },
      { name: "sheetNumber", required: false, description: "Optional sheet number to place the view onto." }
    ],
    actions: [
      {
        method: "POST",
        path: "/revit/import-excel-table",
        title: "Import Excel table",
        body: {
          sourcePath: "{{sourcePath}}",
          sheetName: "{{sheetName}}",
          range: "{{range}}",
          viewName: "{{viewName}}",
          cellWidthInches: "{{cellWidthInches}}",
          cellHeightInches: "{{cellHeightInches}}",
          marginInches: "{{marginInches}}",
          textTypeName: "{{textTypeName}}",
          lineStyleName: "{{lineStyleName}}",
          sheetNumber: "{{sheetNumber}}"
        }
      }
    ],
    requiresApproval: true,
    tags: ["drafting", "excel", "table", "documentation"]
  }
  ,
  {
    id: "align_room_tops_to_ceilings",
    name: "Align Room Tops To Ceilings",
    description:
      "Compare each room's top elevation to the primary ceiling bottom elevation in the same room footprint, and adjust room height to match (dry-run supported).",
    inputs: [
      { name: "levelNameContains", required: false, description: "Optional filter for rooms by level name substring (e.g. Level 2)." },
      { name: "roomNumbers", required: false, default: [], description: "Optional explicit room numbers list (e.g. [\"0201\",\"0202\"])." },
      { name: "maxRooms", required: false, default: 20000, description: "Maximum rooms to scan." },
      { name: "dryRun", required: false, default: true, description: "If true, rolls back changes and returns what would change." },
      { name: "behavior", required: false, default: "bestEffort", description: "bestEffort (skip failures) or allOrNothing (rollback on any failure)." },
      { name: "toleranceFt", required: false, default: 0.0104, description: "Tolerance in feet (default ~1/8 inch)." }
    ],
    actions: [
      {
        method: "POST",
        path: "/revit/align-room-tops-to-ceilings",
        title: "Align room tops to ceilings",
        body: {
          levelNameContains: "{{levelNameContains}}",
          roomNumbers: "{{roomNumbers}}",
          maxRooms: "{{maxRooms}}",
          dryRun: "{{dryRun}}",
          behavior: "{{behavior}}",
          toleranceFt: "{{toleranceFt}}"
        }
      }
    ],
    requiresApproval: true,
    tags: ["rooms", "ceilings", "plenum", "qa"]
  }
];

const DEFAULT_SKILLS_RECHECK_MS = 60_000;
const ensuredWorkspaceRoots = new Map<string, number>();

export function __testOnlyResetDefaultMacroSkillsCache(): void {
  ensuredWorkspaceRoots.clear();
}

export function ensureDefaultMacroSkills(): void {
  const workspaceRoot = getMacroSkillsDirs().core;
  const now = Date.now();
  if ((ensuredWorkspaceRoots.get(workspaceRoot) ?? 0) > now) return;
  for (const s of DEFAULT_SKILLS) {
    try {
      const existing = loadMacroSkill(s.id);
      if (existing) continue;
      saveMacroSkill(s);
    } catch {
      // best-effort
    }
  }
  ensuredWorkspaceRoots.set(workspaceRoot, now + DEFAULT_SKILLS_RECHECK_MS);
}
