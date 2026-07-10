using System;
using System.Collections.Generic;
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
            public long? viewId { get; set; }
            public string? viewName { get; set; }
            public string? viewQuery { get; set; }
            public bool? viewExact { get; set; }
            public bool? createDraftingView { get; set; }
            public bool? placeOnSheet { get; set; }
            public bool? moveIfAlreadyPlaced { get; set; }
            public bool? directSheetImport { get; set; }
            public int? viewScale { get; set; }
            public string? placement { get; set; } // origin|center
            public double? x { get; set; } // sheet feet for viewport placement
            public double? y { get; set; }
            public double? xInches { get; set; } // sheet inches for viewport placement
            public double? yInches { get; set; }
            public string? importUnit { get; set; } // Default|Foot|Inch|Meter|...
            public double? customScale { get; set; } // 1.0 = one-to-one when supported by Revit API
            public bool? link { get; set; } // default true (link if API supports)
            public bool? preflightOnly { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var dryRun = p.dryRun ?? false;
            var wantLink = p.link ?? true;

            if (dryRun && (p.preflightOnly ?? false))
            {
                return Task.FromResult<object>(CadLinkPreflightCapability.CreateResponse());
            }

            var doc = app.ActiveUIDocument.Document;

            var src = (p.sourcePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(src)) throw new InvalidOperationException("link-cad.sourcePath is required.");

            var sheet = ResolveSheet(doc, p.sheetViewId, (p.sheetNumber ?? "").Trim());
            var directSheetImport = p.directSheetImport ?? false;
            var targetView = directSheetImport
                ? (sheet as View)
                : ResolveExistingTargetView(doc, p);
            var plannedDraftingViewName = targetView == null && !directSheetImport && sheet != null && (p.createDraftingView ?? true)
                ? ResolvePlannedDraftingViewName(p, src, sheet)
                : null;
            if (targetView == null && string.IsNullOrWhiteSpace(plannedDraftingViewName))
                throw new InvalidOperationException("link-cad requires a target view (viewId/viewName/viewQuery) or sheetViewId/sheetNumber so a drafting view can be created.");
            if (sheet == null && targetView is ViewSheet targetSheet)
                sheet = targetSheet;

            var full = ResolveSourcePath(src);
            var ext = (Path.GetExtension(full) ?? "").Trim().ToLowerInvariant();
            if (ext != ".dwg") throw new InvalidOperationException("link-cad only supports .dwg files.");

            var shouldPlaceOnSheet = sheet != null && (targetView == null || !(targetView is ViewSheet)) && (p.placeOnSheet ?? true);
            var viewportPoint = sheet == null ? XYZ.Zero : ResolveViewportPoint(sheet, p);
            var existingViewport = shouldPlaceOnSheet
                ? (targetView == null ? null : SheetPlacementHelper.FindViewportOnSheet(doc, sheet!.Id, targetView.Id))
                : null;
            var canPlaceViewport = !shouldPlaceOnSheet || targetView == null || existingViewport != null || Viewport.CanAddViewToSheet(doc, sheet!.Id, targetView.Id);
            var moveIfAlreadyPlaced = p.moveIfAlreadyPlaced ?? true;

            var plan = new
            {
                sourcePath = src,
                sourceFullPath = full,
                targetMode = directSheetImport ? "direct_sheet_import" : "view_then_sheet",
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(targetView?.Id),
                viewName = targetView?.Name ?? plannedDraftingViewName,
                viewType = targetView?.ViewType.ToString() ?? (plannedDraftingViewName == null ? null : "DraftingView"),
                viewCreated = targetView == null && plannedDraftingViewName != null,
                viewScale = targetView == null ? p.viewScale ?? 1 : SafeViewScale(targetView),
                sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet?.Id),
                sheetNumber = sheet?.SheetNumber,
                sheetName = sheet?.Name,
                placeOnSheet = shouldPlaceOnSheet,
                existingViewportId = existingViewport == null ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(existingViewport.Id),
                canPlaceViewport,
                viewportPoint = shouldPlaceOnSheet ? new { x = viewportPoint.X, y = viewportPoint.Y } : null,
                placement = (p.placement ?? "origin").Trim().ToLowerInvariant(),
                directSheetImport,
                importUnit = string.IsNullOrWhiteSpace(p.importUnit) ? null : p.importUnit.Trim(),
                customScale = p.customScale,
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

                var targetViewCreatedInTransaction = false;
                if (!directSheetImport)
                    targetView = ResolveTargetView(doc, p, src, sheet, out targetViewCreatedInTransaction);
                var targetViewCreated = !directSheetImport && targetViewCreatedInTransaction;
                if (targetView == null)
                    throw new InvalidOperationException("link-cad could not resolve or create a target view.");

                TrySetScale(targetView, p.viewScale);

                var options = new DWGImportOptions();
                try { options.ThisViewOnly = true; } catch { }
                try { options.Placement = ImportPlacement.Origin; } catch { }
                ApplyImportUnit(options, p.importUnit);
                ApplyCustomScale(options, p.customScale);

                var ok = false;
                ElementId importedId = ElementId.InvalidElementId;
                var mode = "import";

                if (wantLink)
                {
                    ok = TryLinkOrImport(doc, "Link", full, options, targetView, out importedId);
                    if (ok) mode = "link";
                }

                if (!ok)
                {
                    ok = TryLinkOrImport(doc, "Import", full, options, targetView, out importedId);
                    mode = "import";
                }

                if (!ok || importedId == null || importedId == ElementId.InvalidElementId)
                    throw new InvalidOperationException("CAD link/import failed (no element id returned).");

                var placement = (p.placement ?? "origin").Trim().ToLowerInvariant();
                if (placement == "center")
                {
                    try { TryMoveElementToViewCenter(doc, targetView, importedId); } catch { }
                }

                long? viewportId = null;
                object? viewportBox = null;
                if (shouldPlaceOnSheet)
                {
                    Viewport viewport;
                    if (existingViewport != null)
                    {
                        viewport = existingViewport;
                        if (moveIfAlreadyPlaced)
                            SheetPlacementHelper.TrySetViewportCenter(viewport, viewportPoint.X, viewportPoint.Y, out _);
                    }
                    else
                    {
                        if (!Viewport.CanAddViewToSheet(doc, sheet!.Id, targetView.Id))
                            throw new InvalidOperationException("CAD target view cannot be placed on the requested sheet.");
                        viewport = Viewport.Create(doc, sheet!.Id, targetView.Id, viewportPoint);
                    }
                    viewportId = RevitBridge.Common.ElementIdCompat.GetValue(viewport.Id);
                    viewportBox = TryGetViewportBox(viewport);
                }

                t.Commit();

                var cadCategories = BuildCadCategoryState(doc, importedId);
                var elementBoxInOwnerView = TryGetBoundingBox(doc.GetElement(importedId), targetView);
                var elementBoxOnSheet = sheet == null ? null : TryGetBoundingBox(doc.GetElement(importedId), sheet);

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    mode,
                    targetMode = directSheetImport ? "direct_sheet_import" : "view_then_sheet",
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(targetView.Id),
                    viewName = targetView.Name,
                    viewType = targetView.ViewType.ToString(),
                    viewCreated = targetViewCreated,
                    viewScale = SafeViewScale(targetView),
                    sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet?.Id),
                    sheetNumber = sheet?.SheetNumber,
                    viewportId,
                    viewportBox,
                    elementId = RevitBridge.Common.ElementIdCompat.GetValue(importedId),
                    ownerViewId = RevitBridge.Common.ElementIdCompat.GetValue(targetView.Id),
                    elementBoundingBoxInOwnerView = elementBoxInOwnerView,
                    elementBoundingBoxOnSheet = elementBoxOnSheet,
                    sourcePath = src,
                    cadCategories
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

        private static View? ResolveTargetView(Document doc, Params p, string sourcePath, ViewSheet? sheet, out bool created)
        {
            created = false;

            var existing = ResolveExistingTargetView(doc, p);
            if (existing != null) return existing;

            var name = ResolvePlannedDraftingViewName(p, sourcePath, sheet);
            if (name.Length > 0 && (p.createDraftingView ?? true))
            {
                return CreateDraftingView(doc, name, p.viewScale ?? 1, out created);
            }

            return null;
        }

        private static View? ResolveExistingTargetView(Document doc, Params p)
        {
            if (p.viewId.HasValue && p.viewId.Value > 0)
            {
                var byId = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
                if (byId != null && !byId.IsTemplate) return byId;
            }

            var name = (p.viewName ?? "").Trim();
            if (name.Length > 0)
            {
                var existing = FindViewByName(doc, name, exact: true);
                if (existing != null) return existing;
            }

            var query = (p.viewQuery ?? "").Trim();
            if (query.Length > 0)
            {
                var existing = FindViewByName(doc, query, p.viewExact ?? false);
                if (existing != null) return existing;
            }

            return null;
        }

        private static string ResolvePlannedDraftingViewName(Params p, string sourcePath, ViewSheet? sheet)
        {
            var explicitName = (p.viewName ?? "").Trim();
            if (explicitName.Length > 0) return explicitName.Length <= 120 ? explicitName : explicitName.Substring(0, 120).Trim();
            if (sheet == null) return "";
            return BuildDefaultDraftingViewName(sourcePath, sheet);
        }

        private static View? FindViewByName(Document doc, string nameOrQuery, bool exact)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Where(v => v != null && !v.IsTemplate)
                .Where(v =>
                {
                    var name = (v.Name ?? "").Trim();
                    return exact
                        ? name.Equals(nameOrQuery, StringComparison.OrdinalIgnoreCase)
                        : name.IndexOf(nameOrQuery, StringComparison.OrdinalIgnoreCase) >= 0;
                })
                .OrderBy(v => v.ViewType == ViewType.DraftingView ? 0 : 1)
                .ThenBy(v => v.Name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        private static ViewDrafting CreateDraftingView(Document doc, string requestedName, int? scale, out bool created)
        {
            var vft = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewFamilyType))
                .Cast<ViewFamilyType>()
                .FirstOrDefault(x => x.ViewFamily == ViewFamily.Drafting);
            if (vft == null) throw new InvalidOperationException("No ViewFamilyType for Drafting views found.");

            var view = ViewDrafting.Create(doc, vft.Id);
            view.Name = EnsureUniqueViewName(doc, requestedName);
            TrySetScale(view, scale);
            created = true;
            return view;
        }

        private static string BuildDefaultDraftingViewName(string sourcePath, ViewSheet sheet)
        {
            var file = Path.GetFileNameWithoutExtension(sourcePath);
            if (string.IsNullOrWhiteSpace(file)) file = "Linked CAD";
            var name = $"CAD {file} for {sheet.SheetNumber}";
            return name.Length <= 120 ? name : name.Substring(0, 120).Trim();
        }

        private static string EnsureUniqueViewName(Document doc, string name)
        {
            var clean = (name ?? "Linked CAD").Trim();
            if (clean.Length == 0) clean = "Linked CAD";
            if (clean.Length > 120) clean = clean.Substring(0, 120).Trim();

            var existing = new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Where(v => v != null && !v.IsTemplate)
                .Select(v => v.Name ?? "")
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

            if (!existing.Contains(clean)) return clean;
            for (var i = 2; i <= 50; i++)
            {
                var suffix = $" ({i})";
                var prefix = clean.Length + suffix.Length <= 120 ? clean : clean.Substring(0, 120 - suffix.Length).Trim();
                var candidate = prefix + suffix;
                if (!existing.Contains(candidate)) return candidate;
            }
            return clean.Substring(0, Math.Min(clean.Length, 113)).Trim() + " " + Guid.NewGuid().ToString("N").Substring(0, 6);
        }

        private static void TrySetScale(View view, int? scale)
        {
            if (!scale.HasValue) return;
            var value = scale.Value;
            if (value < 1 || value > 2400) return;
            try { view.Scale = value; } catch { }
        }

        private static int? SafeViewScale(View view)
        {
            try { return view.Scale; } catch { return null; }
        }

        private static XYZ ResolveViewportPoint(ViewSheet sheet, Params p)
        {
            if (p.x.HasValue || p.y.HasValue)
                return new XYZ(p.x ?? 0.0, p.y ?? 0.0, 0);

            if (p.xInches.HasValue || p.yInches.HasValue)
                return new XYZ((p.xInches ?? 0.0) / 12.0, (p.yInches ?? 0.0) / 12.0, 0);

            var placement = (p.placement ?? "center").Trim().ToLowerInvariant();
            if (placement == "origin") return XYZ.Zero;

            try
            {
                var o = sheet.Outline;
                return new XYZ((o.Min.U + o.Max.U) * 0.5, (o.Min.V + o.Max.V) * 0.5, 0);
            }
            catch
            {
                return XYZ.Zero;
            }
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

        private static void ApplyImportUnit(DWGImportOptions options, string? rawUnit)
        {
            var unit = (rawUnit ?? "").Trim();
            if (unit.Length == 0) return;

            var unitProp = typeof(DWGImportOptions).GetProperty("Unit", BindingFlags.Instance | BindingFlags.Public);
            if (unitProp == null || !unitProp.CanWrite) return;

            var propType = unitProp.PropertyType;
            try
            {
                if (propType.IsEnum)
                {
                    var parsed = Enum.Parse(propType, unit, ignoreCase: true);
                    unitProp.SetValue(options, parsed, null);
                }
            }
            catch
            {
                // Older Revit API versions vary here; leave default units when unsupported.
            }
        }

        private static void ApplyCustomScale(DWGImportOptions options, double? customScale)
        {
            if (!customScale.HasValue) return;
            if (customScale.Value <= 0 || double.IsNaN(customScale.Value) || double.IsInfinity(customScale.Value))
                throw new InvalidOperationException("link-cad.customScale must be a positive number.");

            var scaleProp = typeof(DWGImportOptions).GetProperty("CustomScale", BindingFlags.Instance | BindingFlags.Public);
            if (scaleProp == null || !scaleProp.CanWrite) return;

            try { scaleProp.SetValue(options, customScale.Value, null); }
            catch
            {
                // Leave default scale when this Revit API surface does not support CustomScale.
            }
        }

        private static object[] BuildCadCategoryState(Document doc, ElementId importId)
        {
            var elem = doc.GetElement(importId);
            var root = elem?.Category;
            if (root == null) return Array.Empty<object>();

            return EnumerateCategoryTree(root, 0)
                .Select(c => new
                {
                    categoryId = RevitBridge.Common.ElementIdCompat.GetValue(c.Category.Id),
                    categoryName = c.Category.Name,
                    depth = c.Depth
                })
                .Cast<object>()
                .ToArray();
        }

        private static System.Collections.Generic.IEnumerable<(Category Category, int Depth)> EnumerateCategoryTree(Category category, int depth)
        {
            yield return (category, depth);
            CategoryNameMap? subCategories = null;
            try { subCategories = category.SubCategories; } catch { }
            if (subCategories == null) yield break;

            foreach (Category sub in subCategories)
            {
                foreach (var nested in EnumerateCategoryTree(sub, depth + 1))
                    yield return nested;
            }
        }

        private static object? TryGetViewportBox(Viewport viewport)
        {
            try
            {
                var o = viewport.GetBoxOutline();
                return new
                {
                    minU = o.MinimumPoint.X,
                    minV = o.MinimumPoint.Y,
                    maxU = o.MaximumPoint.X,
                    maxV = o.MaximumPoint.Y
                };
            }
            catch
            {
                return null;
            }
        }

        private static object? TryGetBoundingBox(Element? element, View view)
        {
            if (element == null) return null;
            try
            {
                var bb = element.get_BoundingBox(view);
                if (bb == null) return null;
                return new
                {
                    min = new { x = bb.Min.X, y = bb.Min.Y, z = bb.Min.Z },
                    max = new { x = bb.Max.X, y = bb.Max.Y, z = bb.Max.Z }
                };
            }
            catch
            {
                return null;
            }
        }

        private static void TryMoveElementToViewCenter(Document doc, View view, ElementId elementId)
        {
            var elem = doc.GetElement(elementId);
            if (elem == null) return;
            try
            {
                if (elem.Pinned) return;
            }
            catch
            {
                // Some imported elements do not expose Pinned reliably. If it cannot be read,
                // let the normal move path decide and keep this best-effort placement.
            }

            var bbox = elem.get_BoundingBox(view);
            if (bbox == null) return;
            var elemCenter = (bbox.Min + bbox.Max) * 0.5;

            var target = new XYZ(0, 0, elemCenter.Z);
            try
            {
                var crop = view.CropBox;
                if (crop != null)
                {
                    var c = (crop.Min + crop.Max) * 0.5;
                    target = new XYZ(c.X, c.Y, elemCenter.Z);
                }
            }
            catch
            {
                // Some views do not expose a usable crop box. Origin is still a deterministic fallback.
            }

            var delta = target - elemCenter;
            if (delta.GetLength() < 1e-6) return;
            ElementTransformUtils.MoveElement(doc, elementId, delta);
        }
    }
}

