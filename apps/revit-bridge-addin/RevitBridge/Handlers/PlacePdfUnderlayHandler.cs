using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class PlacePdfUnderlayHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sourcePath { get; set; }
            public string? sourceUrl { get; set; }
            public string? sourceFileName { get; set; }

            // Target view: defaults to the active view; when viewName is provided and viewId is not,
            // a Drafting View will be created/reused by that name.
            public long? viewId { get; set; }
            public string? viewName { get; set; } // used only when viewId is not set

            // Optional: place the resulting view on a sheet.
            public string? sheetNumber { get; set; }
            public long? sheetViewId { get; set; }

            public int? pageNumber { get; set; } // 1-based (best-effort)
            public string? placement { get; set; } // origin|center (affects import placement; and viewport placement when sheet is specified)
            public double? xInches { get; set; } // optional explicit point (view coords for import; sheet coords for viewport)
            public double? yInches { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var src = (p.sourcePath ?? "").Trim();
            var full = ResolveSourcePdf(p);
            var ext = (Path.GetExtension(full) ?? "").Trim().ToLowerInvariant();
            if (ext != ".pdf") throw new InvalidOperationException("place-pdf-underlay only supports .pdf.");

            var dryRun = p.dryRun ?? false;
            var placement = (p.placement ?? "origin").Trim().ToLowerInvariant();
            var page = p.pageNumber.HasValue && p.pageNumber.Value > 0 ? p.pageNumber.Value : 1;

            // Resolve/create target view.
            var targetView = ResolveTargetView(app, doc, p.viewId, (p.viewName ?? "").Trim());
            if (targetView == null)
                throw new InvalidOperationException("place-pdf-underlay requires an active view, a valid viewId, or a viewName to create/reuse a Drafting View.");

            var wantsSheet = !string.IsNullOrWhiteSpace(p.sheetNumber) || (p.sheetViewId.HasValue && p.sheetViewId.Value > 0);
            ViewSheet? sheet = null;
            if (wantsSheet)
            {
                sheet = ResolveSheet(doc, p.sheetViewId, (p.sheetNumber ?? "").Trim());
                if (sheet == null) throw new InvalidOperationException("place-pdf-underlay sheet not found (sheetViewId/sheetNumber).");
            }

            var plan = new
            {
                sourcePath = src,
                sourceUrl = string.IsNullOrWhiteSpace(p.sourceUrl) ? null : p.sourceUrl,
                sourceFullPath = full,
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(targetView.Id),
                viewName = targetView.Name,
                viewType = targetView.ViewType.ToString(),
                sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet?.Id),
                sheetNumber = sheet?.SheetNumber,
                sheetName = sheet?.Name,
                pageNumber = page,
                placement,
                xInches = p.xInches,
                yInches = p.yInches,
                dryRun
            };

            if (dryRun)
            {
                // Best-effort: validate that PDF import APIs exist in this Revit build.
                var ok = TryGetPdfImportApi(out var apiErr);
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    plan,
                    pdfImportApi = ok ? "available" : "missing",
                    pdfImportApiError = ok ? null : apiErr
                });
            }

            using (var t = new Transaction(doc, "Place PDF Underlay"))
            {
                t.Start();

                // If viewId was not provided, ResolveTargetView may have created a new view. Import into it either way.
                if (!TryImportPdf(doc, full, targetView, page, out var importedId, out var err))
                    throw new InvalidOperationException("PDF import failed: " + err);

                if (placement == "center")
                {
                    try { TryMoveElementToViewCenter(doc, targetView, importedId); } catch { }
                }
                else if (p.xInches.HasValue && p.yInches.HasValue)
                {
                    try { TryMoveElementToPointInView(doc, targetView, importedId, p.xInches.Value, p.yInches.Value); } catch { }
                }

                long? viewportId = null;
                if (sheet != null)
                {
                    var pt = ResolveViewportPoint(sheet, placement, p.xInches, p.yInches);
                    if (Viewport.CanAddViewToSheet(doc, sheet.Id, targetView.Id))
                    {
                        var vp = Viewport.Create(doc, sheet.Id, targetView.Id, pt);
                        viewportId = RevitBridge.Common.ElementIdCompat.GetValue(vp.Id);
                    }
                    else
                    {
                        // If already placed, don't fail the import; just return a warning.
                    }
                }

                t.Commit();

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    dryRun = false,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(targetView.Id),
                    importedElementId = RevitBridge.Common.ElementIdCompat.GetValue(importedId),
                    sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet?.Id),
                    sheetNumber = sheet?.SheetNumber,
                    viewportId,
                    sourcePath = src
                });
            }
        }

        private static string ResolveSourcePdf(Params p)
        {
            var src = (p.sourcePath ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(src))
            {
                try
                {
                    return WorkspacePaths.ResolveExistingFileUnderWorkspace(src);
                }
                catch (FileNotFoundException)
                {
                    // Fall through to sourceUrl if provided.
                }
            }

            var sourceUrl = (p.sourceUrl ?? "").Trim();
            if (string.IsNullOrWhiteSpace(sourceUrl))
                throw new InvalidOperationException("place-pdf-underlay requires sourcePath under Workspace or sourceUrl.");

            if (!Uri.TryCreate(sourceUrl, UriKind.Absolute, out var uri) ||
                !(uri.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase) || uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("place-pdf-underlay.sourceUrl must be an absolute http/https URL.");

            var fileName = SanitizePdfFileName(p.sourceFileName, src, uri);
            var downloadsDir = WorkspacePaths.EnsureDir("artifacts", "downloads", "zippybim");
            var full = Path.Combine(downloadsDir, fileName);
            using (var client = new WebClient())
            {
                client.DownloadFile(uri, full);
            }
            return WorkspacePaths.ResolveExistingFileUnderWorkspace(Path.Combine("artifacts", "downloads", "zippybim", fileName));
        }

        private static string SanitizePdfFileName(string? explicitName, string sourcePath, Uri sourceUrl)
        {
            var raw = (explicitName ?? "").Trim();
            if (string.IsNullOrWhiteSpace(raw) && !string.IsNullOrWhiteSpace(sourcePath))
                raw = Path.GetFileName(sourcePath.Trim());
            if (string.IsNullOrWhiteSpace(raw))
                raw = Path.GetFileName(sourceUrl.AbsolutePath.Trim());
            if (string.IsNullOrWhiteSpace(raw))
                raw = "floor_plan_underlay.pdf";

            foreach (var c in Path.GetInvalidFileNameChars())
                raw = raw.Replace(c, '_');
            raw = raw.Replace('/', '_').Replace('\\', '_').Trim();
            if (!raw.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
                raw += ".pdf";
            return raw.Length <= 180 ? raw : raw.Substring(0, 176) + ".pdf";
        }

        private static View? ResolveTargetView(UIApplication app, Document doc, long? viewId, string viewName)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                var v = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
                if (v != null) return v;
                return null;
            }

            if (string.IsNullOrWhiteSpace(viewName))
            {
                try
                {
                    var active = app.ActiveUIDocument?.ActiveView;
                    if (active != null) return active;
                }
                catch
                {
                    // ignore
                }
            }

            if (string.IsNullOrWhiteSpace(viewName)) viewName = "PDF Underlay";
            if (viewName.Length > 120) viewName = viewName.Substring(0, 120).Trim();

            var existing = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewDrafting))
                .Cast<ViewDrafting>()
                .FirstOrDefault(v => v != null && !v.IsTemplate && string.Equals(v.Name, viewName, StringComparison.OrdinalIgnoreCase));
            if (existing != null) return existing;

            var vft = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewFamilyType))
                .Cast<ViewFamilyType>()
                .FirstOrDefault(x => x.ViewFamily == ViewFamily.Drafting);
            if (vft == null) throw new InvalidOperationException("No ViewFamilyType for Drafting views found.");

            var dv = ViewDrafting.Create(doc, vft.Id);
            dv.Name = EnsureUniqueViewName(doc, viewName);
            return dv;
        }

        private static string EnsureUniqueViewName(Document doc, string name)
        {
            var existing = new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Where(v => v != null && !v.IsTemplate)
                .Select(v => v.Name ?? "")
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

            if (!existing.Contains(name)) return name;
            for (int i = 2; i <= 50; i++)
            {
                var cand = $"{name} ({i})";
                if (!existing.Contains(cand)) return cand;
            }
            return $"{name} ({Guid.NewGuid().ToString("N").Substring(0, 6)})";
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

        private static XYZ ResolveViewportPoint(ViewSheet sheet, string placement, double? xInches, double? yInches)
        {
            if (xInches.HasValue && yInches.HasValue)
                return new XYZ(xInches.Value / 12.0, yInches.Value / 12.0, 0);

            if (placement == "center")
            {
                try
                {
                    var o = sheet.Outline;
                    var cx = (o.Min.U + o.Max.U) * 0.5;
                    var cy = (o.Min.V + o.Max.V) * 0.5;
                    return new XYZ(cx, cy, 0);
                }
                catch { }
            }

            return new XYZ(0, 0, 0);
        }

        private static bool TryGetPdfImportApi(out string error)
        {
            error = "";
            try
            {
                var apiAsm = typeof(Document).Assembly;
                var optType = apiAsm.GetType("Autodesk.Revit.DB.PDFImportOptions");
                if (optType == null)
                {
                    error = "Autodesk.Revit.DB.PDFImportOptions type not found (PDF import API not available in this Revit version).";
                    return false;
                }

                var flags = BindingFlags.Instance | BindingFlags.Public;
                var import = typeof(Document).GetMethods(flags)
                    .FirstOrDefault(m =>
                    {
                        if (!string.Equals(m.Name, "Import", StringComparison.Ordinal)) return false;
                        var ps = m.GetParameters();
                        if (ps.Length != 4) return false;
                        if (ps[0].ParameterType != typeof(string)) return false;
                        if (ps[1].ParameterType != optType) return false;
                        if (!typeof(View).IsAssignableFrom(ps[2].ParameterType)) return false;
                        if (!ps[3].IsOut) return false;
                        return true;
                    });

                if (import == null)
                {
                    error = "Document.Import(string, PDFImportOptions, View, out ElementId) not found.";
                    return false;
                }

                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static bool TryImportPdf(Document doc, string pdfFullPath, View view, int pageNumber, out ElementId elementId, out string error)
        {
            elementId = ElementId.InvalidElementId;
            error = "";

            var apiAsm = typeof(Document).Assembly;
            var optType = apiAsm.GetType("Autodesk.Revit.DB.PDFImportOptions");
            if (optType == null)
            {
                error = "PDF import API not available (PDFImportOptions missing).";
                return false;
            }

            object? options = null;
            try { options = Activator.CreateInstance(optType); } catch { }
            if (options == null)
            {
                error = "Failed to construct PDFImportOptions.";
                return false;
            }

            // Best-effort property sets (API differs by Revit version).
            try
            {
                var pn = optType.GetProperty("PageNumber", BindingFlags.Instance | BindingFlags.Public);
                if (pn != null && pn.CanWrite) pn.SetValue(options, pageNumber);
            }
            catch { }

            MethodInfo? import = null;
            try
            {
                var flags = BindingFlags.Instance | BindingFlags.Public;
                import = typeof(Document).GetMethods(flags)
                    .FirstOrDefault(m =>
                    {
                        if (!string.Equals(m.Name, "Import", StringComparison.Ordinal)) return false;
                        var ps = m.GetParameters();
                        if (ps.Length != 4) return false;
                        if (ps[0].ParameterType != typeof(string)) return false;
                        if (ps[1].ParameterType != optType) return false;
                        if (!typeof(View).IsAssignableFrom(ps[2].ParameterType)) return false;
                        if (!ps[3].IsOut) return false;
                        return true;
                    });
            }
            catch { }

            if (import == null)
            {
                error = "Document.Import overload for PDF not found.";
                return false;
            }

            try
            {
                object?[] args = new object?[] { pdfFullPath, options, view, ElementId.InvalidElementId };
                var ret = import.Invoke(doc, args);
                var ok = ret is bool b ? b : true;
                if (args[3] is ElementId id) elementId = id;
                if (!ok || elementId == null || elementId == ElementId.InvalidElementId)
                {
                    error = "Import returned failure or invalid elementId.";
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                error = ex.InnerException?.Message ?? ex.Message;
                return false;
            }
        }

        private static void TryMoveElementToViewCenter(Document doc, View view, ElementId elementId)
        {
            var elem = doc.GetElement(elementId);
            if (elem == null) return;

            var bbox = elem.get_BoundingBox(view);
            if (bbox == null) return;
            var elemCenter = (bbox.Min + bbox.Max) * 0.5;

            XYZ target = new XYZ(0, 0, elemCenter.Z);
            try
            {
                var crop = view.CropBox;
                if (crop != null)
                {
                    var c = (crop.Min + crop.Max) * 0.5;
                    target = new XYZ(c.X, c.Y, elemCenter.Z);
                }
            }
            catch { }

            var delta = target - elemCenter;
            if (delta.GetLength() < 1e-6) return;
            ElementTransformUtils.MoveElement(doc, elementId, delta);
        }

        private static void TryMoveElementToPointInView(Document doc, View view, ElementId elementId, double xInches, double yInches)
        {
            var elem = doc.GetElement(elementId);
            if (elem == null) return;

            var bbox = elem.get_BoundingBox(view);
            if (bbox == null) return;
            var elemCenter = (bbox.Min + bbox.Max) * 0.5;
            var target = new XYZ(xInches / 12.0, yInches / 12.0, elemCenter.Z);
            var delta = target - elemCenter;
            if (delta.GetLength() < 1e-6) return;
            ElementTransformUtils.MoveElement(doc, elementId, delta);
        }
    }
}

