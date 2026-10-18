using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    // Read-only adapter. No transactions, probes, document regeneration or model repair.
    public static class DrawingSpecNativeInspection
    {
        private static readonly JsonSerializerOptions Json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

        public static (DrawingSpecInspectionResult Checks, List<DrawingSpecObservedNote> Notes) Read(Document document,
            DrawingSpecStoredImport state, IReadOnlyList<DrawingSpecRichParagraph> paragraphs)
        {
            if (state.Notes.Count > 20000 || state.ViewIds.Count > 1000 || state.ViewIds.Distinct().Count() != state.ViewIds.Count ||
                state.Notes.Sum(n => (long)n.Ranges.Count) > 100000) throw new InvalidOperationException("Native inspection exceeds its complete-read bounds.");
            var source = paragraphs.ToDictionary(p => p.SourceId);
            var profiles = DrawingSpecNativeFontProfile.CaptureAll(paragraphs);
            var segments = state.Notes.Select(n => new DrawingSpecInspectionSegment { SourceId = n.SourceId, Start = n.Start, Length = n.Length,
                Kind = "text", NoteId = n.Id, UniqueId = n.UniqueId, ViewId = n.ViewId }).ToList();
            using (var spans = JsonDocument.Parse(state.LayoutSpansJson))
            {
                if (spans.RootElement.GetArrayLength() > 100000) throw new InvalidOperationException("Too many retained layout spans.");
                foreach (var span in spans.RootElement.EnumerateArray()) segments.Add(new DrawingSpecInspectionSegment {
                    SourceId = span.GetProperty("sourceId").GetString() ?? "", Start = span.GetProperty("start").GetInt32(),
                    Length = span.GetProperty("length").GetInt32(), Kind = span.GetProperty("kind").GetString() ?? "" });
            }
            var views = state.ViewIds.ToDictionary(id => id, id => document.GetElement(ElementIdCompat.Create(id)) as View);
            if (views.Any(pair => pair.Value == null || pair.Value.IsTemplate || pair.Value.ViewType != ViewType.DraftingView))
                throw new InvalidOperationException("An owned non-template drafting view is missing or changed.");
            if (state.FlowGeometry != null) DrawingSpecColumnFlow.Plan(Array.Empty<DrawingSpecFlowItem>(), state.FlowGeometry, (_, __, ___, ____) => 0);
            var timer = Stopwatch.StartNew();
            var notes = new List<DrawingSpecObservedNote>();
            foreach (var record in state.Notes)
            {
                if (timer.Elapsed.TotalSeconds > 15) throw new InvalidOperationException("Complete native read exceeded15seconds; no partial inspection pass is available.");
                var note = document.GetElement(ElementIdCompat.Create(record.Id)) as TextNote;
                if (note == null) continue; // The checker reports the missing exact source fragment.
                var ranges = source.TryGetValue(record.SourceId, out var paragraph) && record.Start >= 0 && record.Length > 0 && record.Start <= paragraph.NativeText.Length - record.Length
                    ? paragraph.Slice(record.Start, record.Length).Select(s => (s.Start, s.Length)).ToArray() : Array.Empty<(int, int)>();
                using (var actual = note.GetFormattedText())
                    if (ranges.Any(r => r.Item1 < 0 || r.Item2 < 1 || r.Item1 > actual.GetPlainText().Length - r.Item2)) ranges = Array.Empty<(int, int)>();
                var observed = JsonSerializer.Deserialize<DrawingSpecObservedNote>(JsonSerializer.Serialize(DrawingSpecNativeTextFormatting.Read(note, ranges)), Json)
                    ?? throw new InvalidOperationException("Native note read is unavailable.");
                var type = note.TextNoteType;
                observed.TypeUniqueId = type.UniqueId;
                observed.TypeBold = type.get_Parameter(BuiltInParameter.TEXT_STYLE_BOLD).AsInteger() != 0;
                observed.TypeItalic = type.get_Parameter(BuiltInParameter.TEXT_STYLE_ITALIC).AsInteger() != 0;
                observed.TypeUnderline = type.get_Parameter(BuiltInParameter.TEXT_STYLE_UNDERLINE).AsInteger() != 0;
                observed.WidthScale = type.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).AsDouble();
                observed.Background = type.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).AsInteger();
                observed.Page = state.ViewIds.IndexOf(observed.OwnerViewId);
                var view = document.GetElement(note.OwnerViewId) as View ?? throw new InvalidOperationException("Native note owner view is missing.");
                observed.OwnerViewName = view.Name;
                var position = note.Coord - view.Origin;
                observed.XPaperInches = position.DotProduct(view.RightDirection) * 12 / view.Scale;
                observed.YPaperInches = position.DotProduct(view.UpDirection) * 12 / view.Scale;
                observed.WidthPaperInches = note.Width * 12; observed.HeightPaperInches = note.Height * 12;
                notes.Add(observed);
            }
            var checks = DrawingSpecInspection.Check(paragraphs, segments, notes, style => profiles[style.FontFamily].NativeSizeFeet(style.PointSize),
                state.FlowGeometry, state.StartXInches, state.StartYInches);
            return (checks, notes);
        }
    }
}
