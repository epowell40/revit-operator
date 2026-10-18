using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    public sealed class XlsxNativeTableChecks
    {
        public DrawingSpecInspectionResult Text { get; set; } = new DrawingSpecInspectionResult();
        public bool InsideCellBounds { get; set; } = true;
        public bool CellReadingOrderMatches { get; set; } = true;
        public bool NativeBordersMatch { get; set; } = true;
        public int IssueCount { get; set; }
        public List<string> Issues { get; } = new List<string>();
    }
    public static class XlsxNativeTableInspection
    {
        private static readonly JsonSerializerOptions Json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        public static (XlsxNativeTableChecks Checks, List<DrawingSpecObservedNote> Notes) Read(Document document, XlsxNativeTablePart part, XlsxTableLayoutPlan plan)
        {
            var checks = new XlsxNativeTableChecks();var observed = new List<DrawingSpecObservedNote>();var timer = Stopwatch.StartNew();
            void Issue(string message) { checks.IssueCount++;if (checks.Issues.Count < 200) checks.Issues.Add(message); }
            var view = document.GetElement(ElementIdCompat.Create(part.ViewId)) as View ?? throw new InvalidOperationException("Excel part view is missing.");
            if (view.UniqueId != part.ViewUniqueId || view.ViewType != ViewType.DraftingView || view.IsTemplate) throw new InvalidOperationException("Excel part view identity/type changed.");
            var page = plan.Pages.Single(p => p.Index == part.PageIndex);var cells = page.Cells.Where(c => c.Text.Length > 0).ToDictionary(c => c.Address);
            var paragraphs = cells.Values.Select(XlsxTableText.Paragraph).ToArray();var source = paragraphs.ToDictionary(p => p.SourceId);
            var profiles = DrawingSpecNativeFontProfile.CaptureAll(paragraphs);
            var segments = part.Notes.Select(n => new DrawingSpecInspectionSegment { SourceId = n.SourceId, Start = n.Start, Length = n.Length, Kind = "text", NoteId = n.Id, UniqueId = n.UniqueId, ViewId = part.ViewId }).ToList();
            segments.AddRange(part.LayoutSpans.Select(s => new DrawingSpecInspectionSegment { SourceId = s.Address, Start = s.Start, Length = s.Length, Kind = s.Kind }));
            foreach (var record in part.Notes)
            {
                if (timer.Elapsed.TotalSeconds > 25) throw new InvalidOperationException("Complete native Excel part read exceeded25seconds; no partial check passed.");
                var note = document.GetElement(ElementIdCompat.Create(record.Id)) as TextNote;if (note == null) continue;
                var ranges = source.TryGetValue(record.SourceId, out var paragraph) && record.Start >= 0 && record.Length > 0 && record.Start <= paragraph.NativeText.Length - record.Length
                    ? paragraph.Slice(record.Start, record.Length).Select(s => (s.Start, s.Length)).ToArray() : Array.Empty<(int, int)>();
                using (var formatted = note.GetFormattedText()) if (ranges.Any(r => r.Item1 > formatted.GetPlainText().Length - r.Item2)) ranges = Array.Empty<(int, int)>();
                var value = JsonSerializer.Deserialize<DrawingSpecObservedNote>(JsonSerializer.Serialize(DrawingSpecNativeTextFormatting.Read(note, ranges)), Json)!;
                var type = note.TextNoteType;value.TypeUniqueId = type.UniqueId;
                value.TypeBold = type.get_Parameter(BuiltInParameter.TEXT_STYLE_BOLD).AsInteger() != 0;value.TypeItalic = type.get_Parameter(BuiltInParameter.TEXT_STYLE_ITALIC).AsInteger() != 0;
                value.TypeUnderline = type.get_Parameter(BuiltInParameter.TEXT_STYLE_UNDERLINE).AsInteger() != 0;value.WidthScale = type.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).AsDouble();
                value.Background = type.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).AsInteger();
                var pose = note.Coord - view.Origin;value.XPaperInches = pose.DotProduct(view.RightDirection) * 12 / view.Scale;value.YPaperInches = pose.DotProduct(view.UpDirection) * 12 / view.Scale;
                value.WidthPaperInches = note.Width * 12;value.HeightPaperInches = note.Height * 12;observed.Add(value);
                if (!cells.TryGetValue(record.SourceId, out var cell) || note.BaseDirection.DistanceTo(view.RightDirection) > 1e-6 || note.UpDirection.DistanceTo(view.UpDirection) > 1e-6
                    || value.XPaperInches < cell.XInches - .02 || value.XPaperInches + value.WidthPaperInches > cell.XInches + cell.WidthInches + .02
                    || -value.YPaperInches < cell.YInches - .02 || -value.YPaperInches + value.HeightPaperInches > cell.YInches + cell.HeightInches + .02)
                { checks.InsideCellBounds = false;Issue("native_text_outside_cell:" + record.SourceId); }
            }
            checks.Text = DrawingSpecInspection.Check(paragraphs, segments, observed, style => profiles[style.FontFamily].NativeSizeFeet(style.PointSize));
            checks.IssueCount += checks.Text.IssueCount;
            var byId = observed.ToDictionary(n => n.Id);
            foreach (var group in part.Notes.GroupBy(n => n.SourceId))
            {
                DrawingSpecObservedNote? previous = null;
                foreach (var record in group.OrderBy(n => n.Start))
                {
                    if (!byId.TryGetValue(record.Id, out var current)) continue;
                    double lineTolerance = Math.Max(current.HeightPaperInches, previous?.HeightPaperInches ?? 0) / 2;
                    if (previous != null && (current.YPaperInches > previous.YPaperInches + lineTolerance || Math.Abs(current.YPaperInches - previous.YPaperInches) <= lineTolerance && current.XPaperInches < previous.XPaperInches - .02))
                    { checks.CellReadingOrderMatches = false;Issue("native_cell_fragment_order_changed:" + group.Key); }
                    previous = current;
                }
            }
            if (part.Borders.Count != page.Borders.Count || part.Borders.Select(b => b.Id).Distinct().Count() != part.Borders.Count) { checks.NativeBordersMatch = false;Issue("native_border_inventory_changed"); }
            for (int i = 0; i < part.Borders.Count; i++)
            {
                var record = part.Borders[i];var expected = i < page.Borders.Count ? page.Borders[i] : null;
                var curve = document.GetElement(ElementIdCompat.Create(record.Id)) as DetailCurve;
                bool matches = expected != null && curve != null && curve.UniqueId == record.UniqueId && curve.OwnerViewId == view.Id && curve.GeometryCurve is Line
                    && JsonSerializer.Serialize(expected) == JsonSerializer.Serialize(record.Source);
                if (matches)
                {
                    XYZ Point(double x, double y) => view.Origin + view.RightDirection * (x / 12 * view.Scale) - view.UpDirection * (y / 12 * view.Scale);
                    using var graphics = view.GetElementOverrides(curve!.Id);var color = graphics.ProjectionLineColor;
                    string hex = color.IsValid ? "#" + color.Red.ToString("X2") + color.Green.ToString("X2") + color.Blue.ToString("X2") : "";
                    matches = curve.GeometryCurve.GetEndPoint(0).DistanceTo(Point(expected!.X1, expected.Y1)) < 1e-6 && curve.GeometryCurve.GetEndPoint(1).DistanceTo(Point(expected.X2, expected.Y2)) < 1e-6
                        && graphics.ProjectionLineWeight == record.NativeWeight && hex == expected.Color && graphics.ProjectionLinePatternId == LinePatternElement.GetSolidPatternId();
                }
                if (!matches) { checks.NativeBordersMatch = false;Issue("native_border_changed:" + record.Id); }
            }
            return (checks, observed);
        }
    }
}
