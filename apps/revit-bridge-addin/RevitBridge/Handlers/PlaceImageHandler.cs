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
    public sealed class PlaceImageHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sourcePath { get; set; }
            public long? viewId { get; set; } // optional: place in any view (drafting, sheet, etc.)
            public string? sheetNumber { get; set; }
            public long? sheetViewId { get; set; }
            public string? placement { get; set; } // origin|center
            public double? xInches { get; set; } // optional explicit point in sheet coordinates
            public double? yInches { get; set; }
            public double? widthInches { get; set; }
            public double? heightInches { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var src = (p.sourcePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(src)) throw new InvalidOperationException("place-image.sourcePath is required (path under Workspace).");

            var full = WorkspacePaths.ResolveExistingFileUnderWorkspace(src);
            var ext = (Path.GetExtension(full) ?? "").Trim().ToLowerInvariant();
            if (ext != ".png" && ext != ".jpg" && ext != ".jpeg") throw new InvalidOperationException("place-image only supports .png/.jpg/.jpeg.");

            var view = ResolveTargetView(doc, p.viewId, p.sheetViewId, (p.sheetNumber ?? "").Trim());
            if (view == null) throw new InvalidOperationException("place-image requires viewId, sheetViewId, or sheetNumber.");

            var dryRun = p.dryRun ?? false;
            var placement = (p.placement ?? "origin").Trim().ToLowerInvariant();

            var plan = new
            {
                sourcePath = src,
                sourceFullPath = full,
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                viewName = view.Name,
                viewType = view.ViewType.ToString(),
                placement,
                xInches = p.xInches,
                yInches = p.yInches,
                widthInches = p.widthInches,
                heightInches = p.heightInches,
                dryRun
            };
            if (dryRun)
            {
                return Task.FromResult<object>(new { status = "Dry Run", dryRun = true, plan });
            }

            using (var t = new Transaction(doc, "Place Image"))
            {
                t.Start();

                var imageTypeId = CreateImageType(doc, full);
                var point = ResolvePlacementPoint(view, placement, p.xInches, p.yInches);
                var imageInstanceId = CreateImageInstance(doc, view, imageTypeId, point);

                var img = doc.GetElement(imageInstanceId);
                if (img != null)
                {
                    if (p.widthInches.HasValue)
                        TrySetDoubleParam(img, new[] { "Width", "Image Width" }, p.widthInches.Value / 12.0);
                    if (p.heightInches.HasValue)
                        TrySetDoubleParam(img, new[] { "Height", "Image Height" }, p.heightInches.Value / 12.0);
                }

                t.Commit();

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    imageTypeId = RevitBridge.Common.ElementIdCompat.GetValue(imageTypeId),
                    imageInstanceId = RevitBridge.Common.ElementIdCompat.GetValue(imageInstanceId),
                    sourcePath = src
                });
            }
        }

        private static View? ResolveTargetView(Document doc, long? viewId, long? sheetViewId, string sheetNumber)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                var v = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
                if (v != null) return v;
            }

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

        private static XYZ ResolvePlacementPoint(View view, string placement, double? xInches, double? yInches)
        {
            if (xInches.HasValue && yInches.HasValue)
            {
                return new XYZ(xInches.Value / 12.0, yInches.Value / 12.0, 0);
            }

            if (placement == "center")
            {
                try
                {
                    if (view is ViewSheet sheet)
                    {
                        var o = sheet.Outline;
                        var cx = (o.Min.U + o.Max.U) * 0.5;
                        var cy = (o.Min.V + o.Max.V) * 0.5;
                        return new XYZ(cx, cy, 0);
                    }

                    var bbox = view.CropBox;
                    if (bbox != null)
                    {
                        var center = (bbox.Min + bbox.Max) * 0.5;
                        return new XYZ(center.X, center.Y, 0);
                    }
                }
                catch
                {
                    // ignore
                }
            }

            return new XYZ(0, 0, 0);
        }

        private static ElementId CreateImageType(Document doc, string fullPath)
        {
            // Use reflection to keep compatibility across Revit API versions.
            var optionsType = typeof(ImageTypeOptions);
            object? options = null;
            try
            {
                options = Activator.CreateInstance(optionsType, new object[] { fullPath });
            }
            catch
            {
                // Fallback: try parameterless then set Path property if present.
                options = Activator.CreateInstance(optionsType);
                var prop = optionsType.GetProperty("Path", BindingFlags.Instance | BindingFlags.Public);
                if (prop != null && prop.CanWrite) prop.SetValue(options, fullPath);
            }

            if (options == null) throw new InvalidOperationException("Failed to construct ImageTypeOptions.");

            var m = typeof(ImageType).GetMethods(BindingFlags.Public | BindingFlags.Static)
                .FirstOrDefault(x => string.Equals(x.Name, "Create", StringComparison.Ordinal) && x.GetParameters().Length == 2);
            if (m == null) throw new InvalidOperationException("ImageType.Create API not found.");

            var id = m.Invoke(null, new object?[] { doc, options }) as ElementId;
            if (id == null || id == ElementId.InvalidElementId) throw new InvalidOperationException("ImageType.Create returned invalid id.");
            return id;
        }

        private static ElementId CreateImageInstance(Document doc, View view, ElementId imageTypeId, XYZ point)
        {
            var m = typeof(ImageInstance).GetMethods(BindingFlags.Public | BindingFlags.Static)
                .FirstOrDefault(x =>
                    string.Equals(x.Name, "Create", StringComparison.Ordinal) &&
                    x.GetParameters().Length == 4 &&
                    x.GetParameters()[0].ParameterType == typeof(Document) &&
                    typeof(View).IsAssignableFrom(x.GetParameters()[1].ParameterType));
            if (m == null) throw new InvalidOperationException("ImageInstance.Create API not found.");

            var id = m.Invoke(null, new object?[] { doc, view, imageTypeId, point }) as ElementId;
            if (id == null || id == ElementId.InvalidElementId) throw new InvalidOperationException("ImageInstance.Create returned invalid id.");
            return id;
        }

        private static void TrySetDoubleParam(Element e, string[] candidateNames, double valueFeet)
        {
            try
            {
                foreach (var name in candidateNames)
                {
                    var p = e.LookupParameter(name);
                    if (p == null) continue;
                    if (p.StorageType != StorageType.Double) continue;
                    p.Set(valueFeet);
                    return;
                }
            }
            catch
            {
                // ignore
            }
        }
    }
}
