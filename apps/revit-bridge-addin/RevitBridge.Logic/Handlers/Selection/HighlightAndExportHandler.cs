using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class HighlightAndExportHandler : IRequestHandler
    {
        public class OverrideStyle
        {
            public int? lineWeight { get; set; }
            public int? r { get; set; }
            public int? g { get; set; }
            public int? b { get; set; }
        }

        public class HighlightGroup
        {
            public string? name { get; set; }
            public List<long> elementIds { get; set; } = new List<long>();
            public OverrideStyle? overrideStyle { get; set; }
        }

        public class LabelSpec
        {
            public string text { get; set; } = "";
            public double[]? pointXyz { get; set; } // [x,y,z] in model feet
        }

        public class Params
        {
            public long? viewId { get; set; }
            public List<long> elementIds { get; set; } = new List<long>();
            public int imageSize { get; set; } = 2200;
            public string folder { get; set; } = "";
            public string highlightMode { get; set; } = "temporary_override";
            public OverrideStyle? overrideStyle { get; set; }
            public List<HighlightGroup>? highlightGroups { get; set; }
            public List<LabelSpec>? labels { get; set; }

            // Optional: export a focused image by temporarily cropping the view to the union of these elements' view bboxes.
            // (Rolled back after export.)
            public List<long>? focusElementIds { get; set; }
            public double focusPaddingFt { get; set; } = 2.0;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            if (p == null) throw new ArgumentException("Invalid JSON payload.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new Exception("No active UI document.");
            var doc = uidoc.Document;

            View? view = null;
            if (p.viewId.HasValue && p.viewId.Value != 0)
                view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
            else
                view = doc.ActiveView;
            if (view == null) throw new Exception("View not found.");

            if (!string.Equals(p.highlightMode, "temporary_override", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException($"Unsupported highlightMode '{p.highlightMode}'. Only 'temporary_override' is supported.");

            var folder = SelectionUtil.EnsureDefaultSelectionCaptureFolder(p.folder);
            var exportId = Guid.NewGuid().ToString("N");
            var stem = $"Revit_{RevitBridge.Common.ElementIdCompat.GetValue(view.Id)}_{exportId}_highlight";

            var groups = (p.highlightGroups != null && p.highlightGroups.Count > 0)
                ? p.highlightGroups
                : new List<HighlightGroup> { new HighlightGroup { name = "default", elementIds = p.elementIds ?? new List<long>(), overrideStyle = p.overrideStyle } };

            if (groups.All(g => g == null || g.elementIds == null || g.elementIds.Count == 0))
                throw new ArgumentException("highlight-and-export requires elementIds or highlightGroups[].elementIds.");

            string path;
            var warnings = new List<string>();
            using (var tg = new TransactionGroup(doc, "Highlight and Export"))
            {
                tg.Start();

                using (var t = new Transaction(doc, "Apply Temporary Overrides"))
                {
                    t.Start();

                    foreach (var group in groups)
                    {
                        if (group == null) continue;
                        var ogs = BuildOgs(group.overrideStyle ?? p.overrideStyle);
                        foreach (var id in (group.elementIds ?? new List<long>()))
                        {
                            try { view.SetElementOverrides(RevitBridge.Common.ElementIdCompat.Create(id), ogs); } catch { /* ignore */ }
                        }
                    }

                    TryCreateLabels(doc, view, p.labels);
                    TryApplyFocusCrop(doc, view, p.focusElementIds, p.focusPaddingFt, warnings);
                    t.Commit();
                }

                path = SelectionUtil.ExportViewImage(doc, view, p.imageSize, folder, stem);

                // Roll back overrides to leave the model unchanged.
                tg.RollBack();
            }

            var (widthPx, heightPx) = SelectionUtil.ReadImageSize(path);

            return Task.FromResult<object>(new
            {
                path,
                widthPx,
                heightPx,
                warnings
            });
        }

        private static void TryApplyFocusCrop(Document doc, View view, List<long>? focusElementIds, double paddingFt, List<string> warnings)
        {
            if (view == null) return;
            if (focusElementIds == null || focusElementIds.Count == 0) return;
            if (view.ViewType == ViewType.DrawingSheet)
            {
                warnings.Add("Focus crop requested, but sheet views do not support crop-box focusing. Exported full sheet.");
                return;
            }

            var ids = focusElementIds.Where(x => x != 0).Distinct().Select(x => RevitBridge.Common.ElementIdCompat.Create(x)).ToList();
            if (ids.Count == 0) return;

            BoundingBoxXYZ? union = null;
            foreach (var id in ids)
            {
                var e = doc.GetElement(id);
                if (e == null) continue;
                BoundingBoxXYZ? bb = null;
                try { bb = e.get_BoundingBox(view); } catch { bb = null; }
                if (bb == null) continue;

                if (union == null)
                {
                    union = new BoundingBoxXYZ();
                    union.Min = bb.Min;
                    union.Max = bb.Max;
                }
                else
                {
                    union.Min = new XYZ(Math.Min(union.Min.X, bb.Min.X), Math.Min(union.Min.Y, bb.Min.Y), Math.Min(union.Min.Z, bb.Min.Z));
                    union.Max = new XYZ(Math.Max(union.Max.X, bb.Max.X), Math.Max(union.Max.Y, bb.Max.Y), Math.Max(union.Max.Z, bb.Max.Z));
                }
            }

            if (union == null)
            {
                warnings.Add("Focus crop requested, but no element bounding boxes were available in this view.");
                return;
            }

            var pad = Math.Max(0, Math.Min(1000, paddingFt));
            var min = new XYZ(union.Min.X - pad, union.Min.Y - pad, union.Min.Z - pad);
            var max = new XYZ(union.Max.X + pad, union.Max.Y + pad, union.Max.Z + pad);

            try
            {
                var existing = view.CropBox;
                var newBox = new BoundingBoxXYZ();
                newBox.Transform = existing != null ? existing.Transform : Transform.Identity;
                newBox.Min = min;
                newBox.Max = max;

                view.CropBoxActive = true;
                view.CropBoxVisible = false;
                view.CropBox = newBox;
            }
            catch (Exception ex)
            {
                warnings.Add($"Focus crop failed: {ex.Message}");
            }
        }

        private static OverrideGraphicSettings BuildOgs(OverrideStyle? style)
        {
            var ogs = new OverrideGraphicSettings();
            if (style?.lineWeight != null)
                ogs.SetProjectionLineWeight(Math.Max(1, style.lineWeight.Value));
            if (style?.r != null && style?.g != null && style?.b != null)
            {
                var r = (byte)Math.Max(0, Math.Min(255, style.r.Value));
                var g = (byte)Math.Max(0, Math.Min(255, style.g.Value));
                var b = (byte)Math.Max(0, Math.Min(255, style.b.Value));
                ogs.SetProjectionLineColor(new Color(r, g, b));
            }
            return ogs;
        }

        private static void TryCreateLabels(Document doc, View view, List<LabelSpec>? labels)
        {
            if (labels == null || labels.Count == 0) return;
            ElementId typeId;
            try { typeId = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).FirstElementId(); }
            catch { return; }
            if (typeId == ElementId.InvalidElementId) return;

            foreach (var l in labels)
            {
                try
                {
                    if (l == null) continue;
                    var text = (l.text ?? "").Trim();
                    if (text.Length == 0) continue;
                    if (l.pointXyz == null || l.pointXyz.Length < 3) continue;
                    var pt = new XYZ(l.pointXyz[0], l.pointXyz[1], l.pointXyz[2]);
                    TextNote.Create(doc, view.Id, pt, text, typeId);
                }
                catch
                {
                    // ignore label failures
                }
            }
        }
    }
}

