using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace RevitBridge.Common
{
    public enum DrawingSpecFlowBreak { None, Column, Page }

    public sealed class DrawingSpecFlowItem
    {
        public string SourceId { get; set; } = "";
        public string Text { get; set; } = "";
        public bool KeepWithNext { get; set; }
        public bool KeepTogether { get; set; } = true;
        public DrawingSpecFlowBreak BreakBefore { get; set; }
        public double SpaceBeforeInches { get; set; }
        public double SpaceAfterInches { get; set; }
    }

    public sealed class DrawingSpecFlowGeometry
    {
        public int Columns { get; set; } = 4;
        public double ColumnWidthInches { get; set; } = 8.5;
        public double ColumnHeightInches { get; set; } = 27;
        public double GutterInches { get; set; } = .25;
        public int MaximumPages { get; set; } = 128;
    }

    public sealed class DrawingSpecFlowPlacement
    {
        public string SourceId { get; set; } = "";
        public int Start { get; set; }
        public int Length { get; set; }
        public int Page { get; set; }
        public int Column { get; set; }
        public double LeftInches { get; set; }
        public double TopInches { get; set; }
        public double HeightInches { get; set; }
    }

    // Pure allocation only. The caller supplies actual formatted native measurements, in printed inches.
    // A plan is not a native receipt, a sheet placement, or a visual-fidelity claim.
    public static class DrawingSpecColumnFlow
    {
        private const int MaximumTextNoteCharacters = 29999; // Revit FormattedText has a 30000-character limit.
        private const double Epsilon = .000001;

        public static IReadOnlyList<DrawingSpecFlowPlacement> Plan(IReadOnlyList<DrawingSpecFlowItem> items,
            DrawingSpecFlowGeometry geometry, Func<DrawingSpecFlowItem, int, int, double, double> measureHeightInches)
        {
            Validate(items, geometry);
            if (measureHeightInches == null) throw new ArgumentNullException(nameof(measureHeightInches));
            var placements = new List<DrawingSpecFlowPlacement>();
            var measurements = new Dictionary<(string, int, int), double>();
            int page = 0, column = 0;
            int pinnedFollowing = -1;
            double top = 0;

            void Advance(DrawingSpecFlowBreak kind = DrawingSpecFlowBreak.Column)
            {
                if (kind == DrawingSpecFlowBreak.Page) { page++; column = 0; }
                else if (++column == geometry.Columns) { page++; column = 0; }
                top = 0;
                if (page >= geometry.MaximumPages) throw new InvalidOperationException("Specification exceeds the configured page limit. No complete layout plan was returned.");
            }

            double Measure(DrawingSpecFlowItem item, int start, int length)
            {
                var key = (item.SourceId, start, length);
                if (measurements.TryGetValue(key, out double cached)) return cached;
                double height = measureHeightInches(item, start, length, geometry.ColumnWidthInches);
                if (!Finite(height) || height <= 0) throw new InvalidOperationException("Native text measurement must return a finite positive printed height.");
                measurements.Add(key, height);
                return height;
            }

            for (int itemIndex = 0; itemIndex < items.Count; itemIndex++)
            {
                var item = items[itemIndex];
                if (item.BreakBefore != DrawingSpecFlowBreak.None && (page != 0 || column != 0 || top > Epsilon)) Advance(item.BreakBefore);
                int offset = 0;
                bool empty = item.Text.Length == 0;
                while (empty || offset < item.Text.Length)
                {
                    double before = offset == 0 ? item.SpaceBeforeInches : 0;
                    int remaining = item.Text.Length - offset;
                    int length = SafeEnd(item.Text, offset, Math.Min(remaining, MaximumTextNoteCharacters)) - offset;
                    if (remaining > 0 && length == 0) throw new InvalidOperationException("A source grapheme exceeds the native text-note character limit.");
                    double height = Measure(item, offset, length);
                    double after = length == remaining ? item.SpaceAfterInches : 0;
                    if (length == remaining && item.KeepWithNext && itemIndex + 1 < items.Count &&
                        items[itemIndex + 1].BreakBefore == DrawingSpecFlowBreak.None)
                    {
                        // Keep a heading with following content. For an oversized chain keep at least
                        // the first measured line of the following paragraph, never an orphan heading.
                        double group = before + height + after;
                        for (int following = itemIndex + 1; following < items.Count; following++)
                        {
                            var member = items[following];
                            if (member.BreakBefore != DrawingSpecFlowBreak.None) break;
                            if (member.Text.Length > MaximumTextNoteCharacters) { group = double.PositiveInfinity; break; }
                            group += member.SpaceBeforeInches + Measure(member, 0, member.Text.Length) + member.SpaceAfterInches;
                            if (!member.KeepWithNext || group > geometry.ColumnHeightInches) break;
                        }
                        if (group > geometry.ColumnHeightInches)
                        {
                            group = before + height + after;
                            for (int following = itemIndex + 1; following < items.Count; following++)
                            {
                                var next = items[following];
                                if (next.BreakBefore != DrawingSpecFlowBreak.None) break;
                                if (next.KeepWithNext && following + 1 < items.Count)
                                {
                                    if (next.Text.Length > MaximumTextNoteCharacters) throw new InvalidOperationException("An oversized kept heading requires an explicit split policy before native measurement.");
                                    group += next.SpaceBeforeInches + Measure(next, 0, next.Text.Length) + next.SpaceAfterInches;
                                }
                                else
                                {
                                    var graphemes = StringInfo.ParseCombiningCharacters(next.Text);
                                    int first = graphemes.Length > 1 ? graphemes[1] : next.Text.Length;
                                    if (first > MaximumTextNoteCharacters) throw new InvalidOperationException("A source grapheme exceeds the native text-note character limit.");
                                    group += next.SpaceBeforeInches + Measure(next, 0, first);
                                    break;
                                }
                            }
                        }
                        if (group > geometry.ColumnHeightInches + Epsilon) throw new InvalidOperationException("Keep-with-next heading group cannot fit a full column at its requested text size.");
                        if (group <= geometry.ColumnHeightInches + Epsilon && top > Epsilon && top + group > geometry.ColumnHeightInches + Epsilon) Advance();
                    }
                    double available = geometry.ColumnHeightInches - top - before;
                    if (height + after > available + Epsilon && top > Epsilon &&
                        (empty || (item.KeepTogether && pinnedFollowing != itemIndex && height + before + after <= geometry.ColumnHeightInches + Epsilon)))
                    {
                        Advance();
                        available = geometry.ColumnHeightInches - before;
                    }
                    if (height + after > available + Epsilon)
                    {
                        if (empty)
                        {
                            if (top > Epsilon) { Advance(); continue; }
                            throw new InvalidOperationException("Empty paragraph spacing exceeds the full column height.");
                        }
                        int fitting = FindFit(item, offset, length, available, Measure);
                        if (fitting == 0)
                        {
                            if (top > Epsilon) { Advance(); continue; }
                            throw new InvalidOperationException("A source grapheme does not fit the full column at its requested text size; no content was omitted or reduced.");
                        }
                        length = fitting;
                        if (length < remaining)
                        {
                            int wordBoundary = LastWordBoundary(item.Text, offset, length);
                            if (wordBoundary > offset) length = wordBoundary - offset;
                        }
                        height = Measure(item, offset, length);
                        after = length == remaining ? item.SpaceAfterInches : 0;
                        // Space-after belongs only to the final fragment. FindFit reserves it there.
                        if (height + after > available + Epsilon) throw new InvalidOperationException("Text measurement changed during layout; no complete plan was returned.");
                    }
                    placements.Add(new DrawingSpecFlowPlacement { SourceId = item.SourceId, Start = offset, Length = length,
                        Page = page, Column = column, LeftInches = column * (geometry.ColumnWidthInches + geometry.GutterInches),
                        TopInches = top + before, HeightInches = height });
                    if (placements.Count > 100000) throw new InvalidOperationException("Specification fragment limit exceeded; no complete plan was returned.");
                    top += before + height + after;
                    offset += length;
                    empty = false;
                    if (offset < item.Text.Length) Advance();
                    else if (item.KeepWithNext && itemIndex + 1 < items.Count && items[itemIndex + 1].BreakBefore == DrawingSpecFlowBreak.None)
                        pinnedFollowing = itemIndex + 1;
                }
            }
            return placements;
        }

        private static int FindFit(DrawingSpecFlowItem item, int offset, int maximum, double available,
            Func<DrawingSpecFlowItem, int, int, double> measure)
        {
            var boundaries = StringInfo.ParseCombiningCharacters(item.Text.Substring(offset, maximum)).Concat(new[] { maximum }).Skip(1).ToArray();
            int lo = 0, hi = boundaries.Length - 1, best = 0;
            while (lo <= hi)
            {
                int mid = lo + (hi - lo) / 2, length = boundaries[mid];
                double after = offset + length == item.Text.Length ? item.SpaceAfterInches : 0;
                if (measure(item, offset, length) + after <= available + Epsilon) { best = length; lo = mid + 1; }
                else hi = mid - 1;
            }
            return best;
        }

        private static int LastWordBoundary(string text, int start, int length)
        {
            var boundaries = new HashSet<int>(StringInfo.ParseCombiningCharacters(text)) { text.Length };
            for (int index = start + length; index > start; index--)
                if (boundaries.Contains(index) && char.IsWhiteSpace(text[index - 1])) return index;
            return start;
        }

        private static int SafeEnd(string text, int start, int length)
        {
            int end = start + length;
            if (end == text.Length || length == 0) return end;
            return StringInfo.ParseCombiningCharacters(text).Where(i => i <= end).DefaultIfEmpty(start).Max();
        }

        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static void Validate(IReadOnlyList<DrawingSpecFlowItem> items, DrawingSpecFlowGeometry geometry)
        {
            if (items == null || items.Count > 10000 || geometry == null) throw new ArgumentException("Missing or excessive specification blocks/geometry.");
            if (geometry.Columns < 1 || geometry.Columns > 24 || geometry.MaximumPages < 1 || geometry.MaximumPages > 128 ||
                !Finite(geometry.ColumnWidthInches) || geometry.ColumnWidthInches <= 0 || geometry.ColumnWidthInches > 96 ||
                !Finite(geometry.ColumnHeightInches) || geometry.ColumnHeightInches <= 0 || geometry.ColumnHeightInches > 192 ||
                !Finite(geometry.GutterInches) || geometry.GutterInches < 0 || geometry.GutterInches > 12) throw new ArgumentException("Invalid printed column geometry.");
            if (items.Any(i => i == null || string.IsNullOrWhiteSpace(i.SourceId) || i.Text == null || i.Text.IndexOf('\f') >= 0 ||
                !Enum.IsDefined(typeof(DrawingSpecFlowBreak), i.BreakBefore) || !Finite(i.SpaceBeforeInches) || i.SpaceBeforeInches < 0 || i.SpaceBeforeInches > 192 ||
                !Finite(i.SpaceAfterInches) || i.SpaceAfterInches < 0 || i.SpaceAfterInches > 192) ||
                items.Select(i => i.SourceId).Distinct(StringComparer.Ordinal).Count() != items.Count)
                throw new ArgumentException("Invalid/duplicate source blocks, spacing or unsplit hard breaks. Retain explicit breaks as flow boundaries.");
        }
    }
}
