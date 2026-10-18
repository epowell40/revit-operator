using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class DrawingSpecTextMeasurement
    {
        public double WidthInches { get; set; }
        public double HeightInches { get; set; }
    }

    public sealed class DrawingSpecInlineFragment
    {
        public int Start { get; set; }
        public int Length { get; set; }
        public int Line { get; set; }
        public string Kind { get; set; } = "text"; // Whitespace is an explicit layout span, not a fake text-note receipt.
        public double LeftInches { get; set; }
        public double TopInches { get; set; }
        public double WidthInches { get; set; }
        public double HeightInches { get; set; }
    }

    public sealed class DrawingSpecInlinePlan
    {
        public List<DrawingSpecInlineFragment> Fragments { get; } = new List<DrawingSpecInlineFragment>();
        public double HeightInches { get; set; }
    }

    // Native font measurements must be supplied by the caller. No source glyph is flattened into another font.
    public static class DrawingSpecInlineFlow
    {
        private const double Epsilon = .000001;
        public static DrawingSpecInlinePlan Plan(DrawingSpecRichParagraph paragraph, int start, int length, double widthInches,
            Func<int, int, DrawingSpecTextMeasurement> measure)
        {
            if (paragraph == null || measure == null || double.IsNaN(widthInches) || double.IsInfinity(widthInches) || widthInches <= 0 || widthInches > 96)
                throw new ArgumentException("A source paragraph, native measurement callback and finite printed width are required.");
            paragraph.Slice(start, length);
            if (paragraph.NativeText.Substring(start, length).IndexOf('\f') >= 0) throw new InvalidOperationException("Allocate hard page/column breaks before inline flow.");
            if (!new[] { "left", "right", "center", "both" }.Contains(paragraph.Alignment)) throw new InvalidOperationException("Unsupported paragraph alignment.");
            if (paragraph.Warnings.Any(w => w.StartsWith("source_line_spacing_", StringComparison.Ordinal))) throw new InvalidOperationException("Unresolved source line spacing.");
            var result = new DrawingSpecInlinePlan();
            var cache = new Dictionary<(int, int), DrawingSpecTextMeasurement>();
            DrawingSpecTextMeasurement M(int offset, int count)
            {
                if (count > 29999) throw new InvalidOperationException("Native text-note character limit exceeded.");
                if (!cache.TryGetValue((offset, count), out var metric))
                {
                    metric = measure(offset, count);
                    if (metric == null || !Finite(metric.WidthInches) || metric.WidthInches < 0 || !Finite(metric.HeightInches) || metric.HeightInches <= 0)
                        throw new InvalidOperationException("Invalid native text measurement.");
                    cache.Add((offset, count), metric);
                }
                return metric;
            }
            int end = start + length, cursor = start, line = 0;
            double top = 0;
            var allBoundaries = new HashSet<int>(StringInfo.ParseCombiningCharacters(paragraph.NativeText)) { paragraph.NativeText.Length };
            if (!allBoundaries.Contains(start) || !allBoundaries.Contains(end)) throw new InvalidOperationException("Inline range splits a source grapheme.");
            if (length == 0) { result.HeightInches = M(start, 0).HeightInches; return result; }
            while (cursor < end)
            {
                int hardEnd = paragraph.NativeText.IndexOf('\v', cursor, end - cursor);
                if (hardEnd < 0) hardEnd = end;
                double indent = paragraph.LeftIndentInches + (cursor == 0 ? paragraph.FirstLineIndentInches - paragraph.HangingIndentInches : 0);
                if (indent < -Epsilon || indent >= widthInches) throw new InvalidOperationException("Source indentation lies outside the column.");
                int cap = Math.Min(hardEnd, cursor + 29999);
                var boundaries = allBoundaries.Where(b => b > cursor && b <= cap).OrderBy(b => b).ToArray();
                int lo = 0, hi = boundaries.Length - 1, fit = cursor;
                while (lo <= hi)
                {
                    int mid = lo + (hi - lo) / 2;
                    var trial = MakeLine(paragraph, cursor, boundaries[mid] - cursor, indent, line, top, M, false);
                    if (Right(trial, indent) <= widthInches + Epsilon) { fit = boundaries[mid]; lo = mid + 1; }
                    else hi = mid - 1;
                }
                if (fit == cursor && hardEnd != cursor) throw new InvalidOperationException("A source grapheme cannot fit the column at its requested font size.");
                if (fit < hardEnd)
                    for (int boundary = fit; boundary > cursor; boundary--)
                        if (allBoundaries.Contains(boundary) && char.IsWhiteSpace(paragraph.NativeText[boundary - 1])) { fit = boundary; break; }
                bool endedByBreak = fit == hardEnd && hardEnd < end;
                var fragments = MakeLine(paragraph, cursor, fit - cursor, indent, line, top, M, paragraph.Alignment == "both" && fit < hardEnd);
                double right = Right(fragments, indent);
                if (fragments.Any(f => !Finite(f.LeftInches) || !Finite(f.WidthInches))) throw new InvalidOperationException("Aligned tab content overlaps preceding content or cannot fit this column.");
                double lineHeight = fragments.Count == 0 ? M(cursor, 0).HeightInches : fragments.Max(f => f.HeightInches);
                double extra = Math.Max(0, widthInches - right);
                if (paragraph.Alignment == "center" || paragraph.Alignment == "right")
                    foreach (var fragment in fragments) fragment.LeftInches += paragraph.Alignment == "center" ? extra / 2 : extra;
                if (paragraph.Alignment == "both" && fit < hardEnd && fragments.All(f => f.Kind != "tab"))
                {
                    var gaps = fragments.Where(f => f.Kind == "space" && f.Start > cursor && f.Start + f.Length < fit).ToArray();
                    double shift = 0, perGap = gaps.Length == 0 ? 0 : extra / gaps.Length;
                    foreach (var fragment in fragments)
                    {
                        fragment.LeftInches += shift;
                        if (gaps.Contains(fragment)) { fragment.WidthInches += perGap; shift += perGap; }
                    }
                }
                result.Fragments.AddRange(fragments);
                if (endedByBreak) result.Fragments.Add(new DrawingSpecInlineFragment { Start = fit, Length = 1, Line = line,
                    Kind = "soft_break", LeftInches = right, TopInches = top, HeightInches = lineHeight });
                top += Pitch(paragraph, lineHeight);
                result.HeightInches = Math.Max(result.HeightInches, fragments.Count == 0 ? top : fragments.Max(f => f.TopInches + f.HeightInches));
                cursor = fit + (endedByBreak ? 1 : 0);
                line++;
                if (line > 100000 || result.Fragments.Count > 100000) throw new InvalidOperationException("Inline layout limit exceeded; no partial plan returned.");
            }
            if (paragraph.NativeText[end - 1] == '\v') result.HeightInches = Math.Max(result.HeightInches, top + M(end, 0).HeightInches);
            int covered = start;
            foreach (var fragment in result.Fragments)
            {
                if (fragment.Start != covered || fragment.Length <= 0) throw new InvalidOperationException("Inline source coverage is incomplete or overlapping.");
                if (!allBoundaries.Contains(fragment.Start) || !allBoundaries.Contains(fragment.Start + fragment.Length)) throw new InvalidOperationException("Typography boundary splits a source grapheme.");
                covered += fragment.Length;
            }
            if (covered != end) throw new InvalidOperationException("Inline layout omitted source characters.");
            return result;
        }

        private static List<DrawingSpecInlineFragment> MakeLine(DrawingSpecRichParagraph paragraph, int start, int length,
            double left, int line, double top, Func<int, int, DrawingSpecTextMeasurement> measure, bool splitSpaces)
        {
            var result = new List<DrawingSpecInlineFragment>();
            int cursor = start, end = start + length;
            var spans = paragraph.Slice(start, length);
            while (cursor < end)
            {
                char current = paragraph.NativeText[cursor];
                if (current == '\t')
                {
                    double target = NextTab(paragraph, left, cursor + 1, end, measure);
                    result.Add(new DrawingSpecInlineFragment { Start = cursor++, Length = 1, Kind = "tab", Line = line,
                        LeftInches = left, TopInches = top, WidthInches = target - left, HeightInches = measure(cursor - 1, 0).HeightInches });
                    left = target;
                    continue;
                }
                var first = spans.First(s => s.Start + start <= cursor && s.Start + start + s.Length > cursor);
                int until = cursor;
                bool whitespace = current == ' ';
                while (until < end && paragraph.NativeText[until] != '\t')
                {
                    var span = spans.First(s => s.Start + start <= until && s.Start + start + s.Length > until);
                    if (!SameTypography(first.Style, span.Style) || (splitSpaces && (paragraph.NativeText[until] == ' ') != whitespace)) break;
                    until++;
                }
                int count = until - cursor;
                if (count == 0) throw new InvalidOperationException("Inline typography did not advance.");
                var metric = measure(cursor, count);
                bool onlySpace = paragraph.NativeText.Substring(cursor, count).All(c => c == ' ');
                result.Add(new DrawingSpecInlineFragment { Start = cursor, Length = count, Kind = onlySpace ? "space" : "text", Line = line,
                    LeftInches = left, TopInches = top, WidthInches = metric.WidthInches, HeightInches = metric.HeightInches });
                left += metric.WidthInches;
                cursor = until;
            }
            return result;
        }

        private static double NextTab(DrawingSpecRichParagraph paragraph, double left, int followingStart, int end,
            Func<int, int, DrawingSpecTextMeasurement> measure)
        {
            var stops = new SortedDictionary<double, string>();
            var cleared = new HashSet<double>();
            foreach (var stop in paragraph.Tabs)
            {
                if (stop.Alignment == "clear") { stops.Remove(stop.PositionInches); cleared.Add(stop.PositionInches); }
                else { stops[stop.PositionInches] = stop.Alignment; cleared.Remove(stop.PositionInches); }
            }
            // A hanging indent creates an implicit tab at the text body's left indent (OOXML 17.3.1.38).
            if (paragraph.ImplicitHangingTab && paragraph.HangingIndentInches > 0) stops[paragraph.LeftIndentInches] = "left";
            var next = stops.FirstOrDefault(s => s.Key > left + Epsilon);
            if (next.Key > left + Epsilon)
            {
                if (next.Value == "left" || next.Value == "start" || next.Value == "num") return next.Key;
                int nextTab = paragraph.NativeText.IndexOf('\t', followingStart, end - followingStart);
                int followingEnd = nextTab < 0 ? end : nextTab;
                int measuredEnd = followingEnd;
                if (next.Value == "decimal")
                {
                    if (paragraph.Warnings.Contains("unresolved_decimal_tab_language")) throw new InvalidOperationException("Unresolved decimal tab language.");
                    int point = paragraph.NativeText.IndexOf(paragraph.DecimalSeparator, followingStart, followingEnd - followingStart, StringComparison.Ordinal);
                    if (point >= 0) measuredEnd = point;
                }
                double followingWidth = Right(MakeLine(paragraph, followingStart, measuredEnd - followingStart, 0, 0, 0, measure, false), 0);
                double target = next.Value == "center" ? next.Key - followingWidth / 2 :
                    next.Value == "right" || next.Value == "end" || next.Value == "decimal" ? next.Key - followingWidth :
                    throw new InvalidOperationException("Unsupported tab alignment: " + next.Value);
                return target + Epsilon < left ? double.PositiveInfinity : target;
            }
            double interval = paragraph.DefaultTabStopInches;
            if (!Finite(interval) || interval <= 0) throw new InvalidOperationException("Invalid document default tab interval.");
            double targetDefault = (Math.Floor((left + Epsilon) / interval) + 1) * interval;
            while (cleared.Any(c => Math.Abs(c - targetDefault) < Epsilon)) targetDefault += interval;
            return targetDefault;
        }

        private static bool SameTypography(DrawingSpecCharacterStyle a, DrawingSpecCharacterStyle b) =>
            string.Equals(a.FontFamily, b.FontFamily, StringComparison.OrdinalIgnoreCase) && a.PointSize == b.PointSize && a.Color == b.Color && a.TrackingPoints == b.TrackingPoints;
        private static double Right(List<DrawingSpecInlineFragment> fragments, double left) => fragments.Count == 0 ? left : fragments.Max(f => f.LeftInches + f.WidthInches);
        private static double Pitch(DrawingSpecRichParagraph paragraph, double natural)
        {
            if (paragraph.LineSpacingRule == "exact") return paragraph.LineSpacingValue / 1440;
            if (paragraph.LineSpacingRule == "atLeast") return Math.Max(natural, paragraph.LineSpacingValue / 1440);
            return natural * paragraph.LineSpacingValue / 240;
        }
        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    }
}
