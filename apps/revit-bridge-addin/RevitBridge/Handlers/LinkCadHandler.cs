using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class LinkCadHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sourcePath { get; set; }
            public string? sheetNumber { get; set; }
            public long? sheetViewId { get; set; }
            public string? placement { get; set; } // origin|center
            public bool? link { get; set; } // default true (link if API supports)
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var src = (p.sourcePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(src)) throw new InvalidOperationException("link-cad.sourcePath is required.");

            var dryRun = p.dryRun ?? false;
            var wantLink = p.link ?? true;

            var sheet = ResolveSheet(doc, p.sheetViewId, (p.sheetNumber ?? "").Trim());
            if (sheet == null) throw new InvalidOperationException("link-cad requires sheetViewId or sheetNumber.");

            var full = ResolveSourcePath(src);
            var ext = (Path.GetExtension(full) ?? "").Trim().ToLowerInvariant();
            if (ext != ".dwg") throw new InvalidOperationException("link-cad only supports .dwg files.");

            var plan = new
            {
                sourcePath = src,
                sourceFullPath = full,
                sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                sheetNumber = sheet.SheetNumber,
                sheetName = sheet.Name,
                placement = (p.placement ?? "origin").Trim().ToLowerInvariant(),
                link = wantLink,
                dryRun
            };

            if (dryRun)
            {
                return Task.FromResult<object>(new { status = "Dry Run", dryRun = true, plan });
            }

            using (var t = new Transaction(doc, wantLink ? "Link CAD (DWG)" : "Import CAD (DWG)"))
            {
                t.Start();

                var options = new DWGImportOptions();
                try { options.ThisViewOnly = true; } catch { }
                try { options.Placement = ImportPlacement.Origin; } catch { }

                var ok = false;
                ElementId importedId = ElementId.InvalidElementId;
                var mode = "import";

                if (wantLink)
                {
                    ok = TryLinkOrImport(doc, "Link", full, options, sheet, out importedId);
                    if (ok) mode = "link";
                }

                if (!ok)
                {
                    ok = TryLinkOrImport(doc, "Import", full, options, sheet, out importedId);
                    mode = "import";
                }

                if (!ok || importedId == null || importedId == ElementId.InvalidElementId)
                    throw new InvalidOperationException("CAD link/import failed (no element id returned).");

                var placement = (p.placement ?? "origin").Trim().ToLowerInvariant();
                if (placement == "center")
                {
                    try { TryMoveElementToSheetCenter(doc, sheet, importedId); } catch { }
                }

                t.Commit();

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    mode,
                    sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                    sheetNumber = sheet.SheetNumber,
                    elementId = RevitBridge.Common.ElementIdCompat.GetValue(importedId),
                    sourcePath = src
                });
            }
        }

        private static ViewSheet? ResolveSheet(Document doc, long? sheetViewId, string sheetNumber)
        {
            if (sheetViewId.HasValue && sheetViewId.Value > 0)
            {
                var v = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(sheetViewId.Value)) as ViewSheet;
                if (v != null) return v;
            }

            if (!string.IsNullOrWhiteSpace(sheetNumber))
            {
                return new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .FirstOrDefault(s => string.Equals(s.SheetNumber, sheetNumber, StringComparison.OrdinalIgnoreCase));
            }

            return null;
        }

        private static string ResolveSourcePath(string userProvided)
        {
            // Workspace relative path preferred for safety.
            try
            {
                return WorkspacePaths.ResolveExistingFileUnderWorkspace(userProvided);
            }
            catch
            {
                // External reference mode: allowed roots only (explicitly configured).
                return OperatorSecurity.ResolveExistingExternalFileUnderAllowedRoots(userProvided);
            }
        }

        private static bool TryLinkOrImport(Document doc, string methodName, string filePath, DWGImportOptions options, View view, out ElementId elementId)
        {
            elementId = ElementId.InvalidElementId;

            // Reflection keeps us resilient across API versions (some expose Document.Link for CAD).
            var flags = BindingFlags.Instance | BindingFlags.Public;
            var candidates = typeof(Document)
                .GetMethods(flags)
                .Where(m => string.Equals(m.Name, methodName, StringComparison.Ordinal) && m.GetParameters().Length == 4)
                .ToList();

            foreach (var m in candidates)
            {
                try
                {
                    var ps = m.GetParameters();
                    if (ps[0].ParameterType != typeof(string)) continue;
                    if (!ps[1].ParameterType.IsAssignableFrom(typeof(DWGImportOptions))) continue;
                    if (!typeof(View).IsAssignableFrom(ps[2].ParameterType)) continue;
                    if (!ps[3].IsOut) continue;

                    object?[] args = new object?[] { filePath, options, view, ElementId.InvalidElementId };
                    var ret = m.Invoke(doc, args);
                    var ok = ret is bool b ? b : true;
                    if (args[3] is ElementId id) elementId = id;
                    return ok;
                }
                catch
                {
                    continue;
                }
            }

            return false;
        }

        private static void TryMoveElementToSheetCenter(Document doc, ViewSheet sheet, ElementId elementId)
        {
            var elem = doc.GetElement(elementId);
            if (elem == null) return;

            var bbox = elem.get_BoundingBox(sheet);
            if (bbox == null) return;
            var elemCenter = (bbox.Min + bbox.Max) * 0.5;

            // ViewSheet.Outline is in sheet coordinates (UV). Convert to XYZ.
            try
            {
                var o = sheet.Outline;
                if (o == null) return;
                var cx = (o.Min.U + o.Max.U) * 0.5;
                var cy = (o.Min.V + o.Max.V) * 0.5;
                var target = new XYZ(cx, cy, elemCenter.Z);
                var delta = target - elemCenter;
                if (delta.GetLength() < 1e-6) return;
                ElementTransformUtils.MoveElement(doc, elementId, delta);
            }
            catch
            {
                // If Outline isn't available/usable, skip.
            }
        }
    }
}

