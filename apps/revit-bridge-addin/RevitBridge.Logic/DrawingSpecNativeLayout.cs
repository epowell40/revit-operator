using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    public sealed class DrawingSpecNativeNoteRecord
    {
        public long Id { get; set; }
        public string UniqueId { get; set; } = "";
        public string SourceId { get; set; } = "";
        public int Start { get; set; }
        public int Length { get; set; }
        public long ViewId { get; set; }
        public List<int[]> Ranges { get; set; } = new List<int[]>();
    }

    public sealed class DrawingSpecNativeLayoutResult
    {
        public List<long> ViewIds { get; } = new List<long>();
        public List<DrawingSpecNativeNoteRecord> Notes { get; } = new List<DrawingSpecNativeNoteRecord>();
        public List<object> LayoutSpans { get; } = new List<object>();
        public int NativeProbes { get; set; }
        public int MetricCacheEntries { get; set; }
    }

    public static class DrawingSpecNativeLayout
    {
        // Caller owns one settled native transaction and creates each continuation view exactly once.
        // This renderer creates editable native text; it does not place views on sheets or issue verification facts.
        public static DrawingSpecNativeLayoutResult Render(Document document, IReadOnlyList<DrawingSpecRichParagraph> paragraphs,
            DrawingSpecFlowGeometry geometry, TextNoteType baseType, Func<int, View> pageView, ISet<long> nativeCreated,
            double startXInches, double startYInches)
        {
            if (!document.IsModifiable || paragraphs.Count == 0) throw new InvalidOperationException("Native spec layout requires the owned transaction and nonempty source inventory.");
            var views = new Dictionary<int, View>();
            View Page(int index)
            {
                if (!views.TryGetValue(index, out var view))
                {
                    view = pageView(index);
                    if (view.Document != document || view.IsTemplate || view.ViewType != ViewType.DraftingView)
                        throw new InvalidOperationException("Drawing specifications require non-template drafting views in the same document.");
                    views.Add(index, view);
                }
                return view;
            }
            var metrics = new DrawingSpecNativeTextMetrics(document, Page(0), baseType, nativeCreated);
            var byId = paragraphs.ToDictionary(p => p.SourceId);
            var inline = new Dictionary<(string, int, int, double), DrawingSpecInlinePlan>();
            DrawingSpecInlinePlan Lines(DrawingSpecRichParagraph paragraph, int start, int length, double width)
            {
                var key = (paragraph.SourceId, start, length, width);
                if (!inline.TryGetValue(key, out var plan))
                {
                    plan = DrawingSpecInlineFlow.Plan(paragraph, start, length, width, (offset, count) => metrics.Measure(paragraph, offset, count));
                    inline.Add(key, plan);
                }
                return plan;
            }
            var items = paragraphs.Select(p => new DrawingSpecFlowItem { SourceId = p.SourceId, Text = p.SourceText,
                KeepWithNext = p.KeepWithNext, SpaceBeforeInches = p.BeforeInches, SpaceAfterInches = p.AfterInches,
                BreakBefore = p.PageBreakBefore ? DrawingSpecFlowBreak.Page : DrawingSpecFlowBreak.None }).ToArray();
            var columns = DrawingSpecColumnFlow.Plan(items, geometry,
                (item, start, length, width) => Lines(byId[item.SourceId], start, length, width).HeightInches);
            var result = new DrawingSpecNativeLayoutResult();
            var expected = new List<(TextNote Note, DrawingSpecRichParagraph Paragraph, DrawingSpecInlineFragment Fragment, XYZ Anchor)>();
            foreach (var column in columns)
            {
                var paragraph = byId[column.SourceId];
                var plan = Lines(paragraph, column.Start, column.Length, geometry.ColumnWidthInches);
                var view = Page(column.Page);
                foreach (var fragment in plan.Fragments)
                {
                    double x = startXInches + column.LeftInches + fragment.LeftInches;
                    double y = startYInches - column.TopInches - fragment.TopInches;
                    var anchor = view.Origin + view.RightDirection * (x / 12 * view.Scale) + view.UpDirection * (y / 12 * view.Scale);
                    if (fragment.Kind == "text")
                    {
                        var note = metrics.Create(view, anchor, paragraph, fragment.Start, fragment.Length);
                        result.Notes.Add(new DrawingSpecNativeNoteRecord { Id = ElementIdCompat.GetValue(note.Id), UniqueId = note.UniqueId,
                            SourceId = paragraph.SourceId, Start = fragment.Start, Length = fragment.Length,
                            ViewId = ElementIdCompat.GetValue(view.Id), Ranges = paragraph.Slice(fragment.Start, fragment.Length).Select(s => new[] { s.Start, s.Length }).ToList() });
                        expected.Add((note, paragraph, fragment, anchor));
                    }
                    else result.LayoutSpans.Add(new { sourceId = paragraph.SourceId, start = fragment.Start, length = fragment.Length,
                        kind = fragment.Kind, page = column.Page, viewId = ElementIdCompat.GetValue(view.Id),
                        xPaperInches = x, yPaperInches = y, advancePaperInches = fragment.WidthInches,
                        scope = "source_whitespace_or_break_layout_span_not_a_text_element" });
                }
            }
            document.Regenerate();
            foreach (var check in expected)
            {
                using (var formatted = check.Note.GetFormattedText())
                {
                    var actual = formatted.GetPlainText();
                    var text = check.Paragraph.NativeText.Substring(check.Fragment.Start, check.Fragment.Length);
                    if (actual != text && actual != text + "\r") throw new InvalidOperationException("Native created text differs from its complete source fragment.");
                }
                if (check.Note.Coord.DistanceTo(check.Anchor) > .000001 ||
                    Math.Abs(check.Note.Width * 12 - check.Fragment.WidthInches) > .02 ||
                    Math.Abs(check.Note.Height * 12 - check.Fragment.HeightInches) > .02)
                    throw new InvalidOperationException("Native text position/printed dimensions differ from the measured layout. Roll back instead of retaining an overfull result.");
            }
            result.ViewIds.AddRange(views.OrderBy(p => p.Key).Select(p => ElementIdCompat.GetValue(p.Value.Id)));
            result.NativeProbes = metrics.NativeProbeCount;
            result.MetricCacheEntries = metrics.CacheEntries;
            return result;
        }

        public static object ReadSnapshot(Document document, DrawingSpecNativeLayoutResult layout)
        {
            var views = layout.ViewIds.Select(id => document.GetElement(ElementIdCompat.Create(id)) as View
                ?? throw new InvalidOperationException("Imported drafting view is missing.")).Select(v => new { id = ElementIdCompat.GetValue(v.Id), uniqueId = v.UniqueId, name = v.Name, scale = v.Scale }).ToArray();
            var notes = layout.Notes.Select(record =>
            {
                var note = document.GetElement(ElementIdCompat.Create(record.Id)) as TextNote
                    ?? throw new InvalidOperationException("Imported native text is missing.");
                if (note.UniqueId != record.UniqueId || ElementIdCompat.GetValue(note.OwnerViewId) != record.ViewId)
                    throw new InvalidOperationException("Imported note identity/owner changed.");
                return DrawingSpecNativeTextFormatting.Read(note, record.Ranges.Select(r => (r[0], r[1])).ToArray());
            }).ToArray();
            return new { scope = "native_imported_text_parameters_character_status_and_views_only", views, notes };
        }
    }
}
