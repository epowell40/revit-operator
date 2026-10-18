using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace RevitBridge.Common
{
    // A separate checker invocation consumes freshly observed native values, not producer verdicts.
    // Bounds/order are geometric screens, not a certification of source typography or visual fidelity.
    public static class DrawingSpecInspection
    {
        public static DrawingSpecInspectionResult Check(IReadOnlyList<DrawingSpecRichParagraph> source,
            IReadOnlyList<DrawingSpecInspectionSegment> segments, IReadOnlyList<DrawingSpecObservedNote> native,
            Func<DrawingSpecCharacterStyle, double> sourceCapHeightFeet,
            DrawingSpecFlowGeometry? geometry = null, double startX = 0, double startY = 0)
        {
            if (source.Count > 20000 || segments.Count > 100000 || native.Count > 20000 || source.Sum(p => (long)p.NativeText.Length) > 4000000)
                throw new InvalidOperationException("Inspection exceeds its explicit complete-input bound; no partial pass is available.");
            var result = new DrawingSpecInspectionResult { SourceParagraphs = source.Count, SourceCharacters = source.Sum(p => p.NativeText.Length),
                NativeNotes = native.Count, InsideColumnBounds = geometry == null ? (bool?)null : true, ReadingOrderMatches = geometry == null ? (bool?)null : true };
            void Issue(string code, DrawingSpecInspectionSegment? segment, string detail)
            {
                result.IssueCount++;
                if (result.Issues.Count < 200) result.Issues.Add(new DrawingSpecInspectionIssue { Code = code,
                    SourceId = segment?.SourceId ?? "", NoteId = segment?.NoteId > 0 ? segment.NoteId : (long?)null, Start = segment?.Start, Detail = detail });
            }
            var bySource = source.ToDictionary(p => p.SourceId);
            if (segments.Any(s => !bySource.ContainsKey(s.SourceId))) { result.SourceCoverageMatches = false; Issue("unknown_source_range", null, "Ledger names a source paragraph that is absent from the current file."); }
            if (native.Select(n => n.Id).Distinct().Count() != native.Count || native.Select(n => n.UniqueId).Distinct().Count() != native.Count ||
                segments.Where(s => s.Kind == "text").Select(s => s.NoteId).Distinct().Count() != segments.Count(s => s.Kind == "text"))
            { result.NativeIdentityAndOwnershipMatches = false; Issue("duplicate_native_identity", null, "Native notes or ledger note identities are duplicated."); }
            var notes = native.GroupBy(n => n.Id).ToDictionary(g => g.Key, g => g.First());
            var byParagraph = segments.ToLookup(s => s.SourceId);
            var used = new HashSet<long>();
            (int Page, int Column, double Top, double Left)? previous = null;
            foreach (var paragraph in source)
            {
                int cursor = 0;
                foreach (var s in byParagraph[paragraph.SourceId].OrderBy(s => s.Start))
                {
                    if (s.Start != cursor || s.Length <= 0 || s.Start < 0 || s.Start > paragraph.NativeText.Length - s.Length)
                    { result.SourceCoverageMatches = false; Issue("source_range_gap_overlap_or_bounds", s, "Each source unit must be covered exactly once in order."); continue; }
                    cursor += s.Length;
                    string expected = paragraph.NativeText.Substring(s.Start, s.Length);
                    if (s.Kind != "text")
                    {
                        bool valid = s.Kind == "space" ? expected.All(c => c == ' ') : s.Kind == "tab" ? expected == "\t" : s.Kind == "soft_break" && expected == "\v";
                        if (!valid) { result.SourceCoverageMatches = false; Issue("non_whitespace_hidden_as_layout", s, "Only explicit source spaces, tabs and soft breaks may be represented without a text note."); }
                        continue;
                    }
                    if (!notes.TryGetValue(s.NoteId, out var n))
                    { result.NativeIdentityAndOwnershipMatches = false; result.NativeTextMatches = false; Issue("native_note_missing", s, "The stored source fragment has no current native TextNote."); continue; }
                    used.Add(n.Id);
                    if (n.Id <= 0 || string.IsNullOrEmpty(n.UniqueId) || n.UniqueId != s.UniqueId || n.OwnerViewId != s.ViewId)
                    { result.NativeIdentityAndOwnershipMatches = false; Issue("native_identity_or_owner_changed", s, "Native ID/UniqueId/owner view differs from retained ownership."); }
                    if (n.Text != expected && n.Text != expected + "\r")
                    { result.NativeTextMatches = false; Issue("native_text_differs_from_source", s, "Actual note text differs from its exact source fragment, including whitespace."); }
                    var spans = paragraph.Slice(s.Start, s.Length);
                    if (n.Ranges.Count != spans.Count) { result.SourceFormattingMatches = false; Issue("native_range_count_mismatch", s, "Native formatting was not inspected over every source style range."); }
                    result.NativeRanges += n.Ranges.Count;
                    for (int i = 0; i < spans.Count; i++)
                    {
                        var span = spans[i]; var style = span.Style;
                        var range = i < n.Ranges.Count ? n.Ranges[i] : null;
                        bool same = range != null && range.Start == span.Start && range.Length == span.Length && range.Text == expected.Substring(span.Start, span.Length) &&
                            Flag(range.Bold, style.Bold) && Flag(range.Italic, style.Italic) && Flag(range.Underline, style.Underline) && Flag(range.AllCaps, style.AllCaps) &&
                            Flag(range.Superscript, style.VerticalAlignment == "superscript") && Flag(range.Subscript, style.VerticalAlignment == "subscript");
                        double expectedCap = sourceCapHeightFeet(style);
                        if (!Finite(expectedCap) || expectedCap <= 0 || !same || !string.Equals(n.Font, style.FontFamily, StringComparison.OrdinalIgnoreCase) || !Finite(n.TextSizeFt) ||
                            Math.Abs(n.TextSizeFt - expectedCap) > 1e-9 || n.Color != Color(style.Color) || style.TrackingPoints != 0 ||
                            n.TypeBold || n.TypeItalic || n.TypeUnderline || !Finite(n.WidthScale) || Math.Abs(n.WidthScale - 1) > 1e-9 || n.Background != 1)
                        { result.SourceFormattingMatches = false; Issue("source_character_format_mismatch", s, "Font, physical cap height, color, base type or source range formatting differs. Range offset " + span.Start); }
                    }
                    if (geometry != null)
                    {
                        double left = n.XPaperInches - startX, top = startY - n.YPaperInches, stride = geometry.ColumnWidthInches + geometry.GutterInches;
                        int column = Finite(left) ? (int)Math.Floor((left + .02) / stride) : -1;
                        double within = left - column * stride;
                        if (n.Page < 0 || column < 0 || column >= geometry.Columns || !Finite(top) || !Finite(within) || !Finite(n.WidthPaperInches) || !Finite(n.HeightPaperInches) ||
                            n.WidthPaperInches <= 0 || n.HeightPaperInches <= 0 || within < -.02 || within + n.WidthPaperInches > geometry.ColumnWidthInches + .02 ||
                            top < -.02 || top + n.HeightPaperInches > geometry.ColumnHeightInches + .02)
                        { result.InsideColumnBounds = false; Issue("native_column_bounds", s, "Fresh native printed bounds extend beyond the allocated column."); }
                        var current = (Page: n.Page, Column: column, Top: top, Left: left);
                        if (previous.HasValue)
                        {
                            var old = previous.Value;
                            if (current.Page < old.Page || current.Page == old.Page && (current.Column < old.Column || current.Column == old.Column &&
                                (current.Top < old.Top - .00001 || Math.Abs(current.Top - old.Top) <= .00001 && current.Left < old.Left - .02)))
                            { result.ReadingOrderMatches = false; Issue("native_reading_order", s, "Actual page/column/line order reverses the source order."); }
                        }
                        previous = current;
                    }
                }
                if (cursor != paragraph.NativeText.Length) { result.SourceCoverageMatches = false; Issue("source_tail_missing", new DrawingSpecInspectionSegment { SourceId = paragraph.SourceId, Start = cursor }, "Source paragraph has uncovered trailing units: " + paragraph.SourceId); }
            }
            if (used.Count != native.Count) { result.NativeIdentityAndOwnershipMatches = false; Issue("unowned_or_extra_observation", null, "Observed notes include identities outside the complete ledger."); }
            return result;
        }

        private static bool Flag(string actual, bool expected) => actual == (expected ? "All" : "None");
        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static int Color(string color)
        {
            if (color == "auto") return 0;
            if (color.Length != 6 || !int.TryParse(color, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rgb))
                throw new InvalidOperationException("Source color remains unresolved.");
            return ((rgb >> 16) & 255) | (rgb & 0x00ff00) | ((rgb & 255) << 16);
        }
    }
}
