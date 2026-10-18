using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    // Internal adapter only: no tool route, transaction, receipt or verification verdict.
    // The importing handler must own native settlement, allocation and independent post-commit readback.
    public static class DrawingSpecNativeTextFormatting
    {
        public static void Apply(TextNote note, DrawingSpecRichParagraph paragraph, int start, int length)
        {
            if (note == null || paragraph == null || length < 1 || length > 29999) throw new ArgumentException("A native text note and bounded nonempty fragment are required.");
            var spans = paragraph.Slice(start, length);
            var style = spans[0].Style;
            if (spans.Any(s => !SameTypography(style, s.Style)))
                throw new InvalidOperationException("This fragment has multiple fonts/sizes/colors/tracking values. Allocate separate inline native fragments; do not flatten its formatting.");
            if (style.TrackingPoints != 0) throw new InvalidOperationException("Character tracking requires explicit inline layout; no silent substitution was applied.");
            if (paragraph.Warnings.Any(w => w.StartsWith("font_theme_", StringComparison.Ordinal) ||
                w.StartsWith("underline_pattern_", StringComparison.Ordinal) || w.StartsWith("character_property_", StringComparison.Ordinal)))
                throw new InvalidOperationException("Source character formatting still has unmapped properties.");
            if (spans.Any(s => s.Style.VerticalAlignment != "baseline" && s.Style.VerticalAlignment != "superscript" && s.Style.VerticalAlignment != "subscript"))
                throw new InvalidOperationException("Unsupported source vertical alignment.");
            var type = note.TextNoteType;
            var family = type.get_Parameter(BuiltInParameter.TEXT_FONT)?.AsString();
            var pointSize = (type.get_Parameter(BuiltInParameter.TEXT_SIZE)?.AsDouble() ?? 0) * 864;
            var color = type.get_Parameter(BuiltInParameter.LINE_COLOR)?.AsInteger();
            if (!string.Equals(family, style.FontFamily, StringComparison.OrdinalIgnoreCase) || Math.Abs(pointSize - style.PointSize) > .000001 || color != ColorValue(style.Color))
                throw new InvalidOperationException("Native text type does not match the source fragment font/size/color. Use a dedicated type without changing unrelated project text.");
            var text = paragraph.NativeText.Substring(start, length);
            if (text.IndexOf('\n') >= 0 || text.IndexOf('\f') >= 0) throw new InvalidOperationException("Split explicit breaks before constructing native formatted text.");
            using (var formatted = new FormattedText(text))
            {
                formatted.SetBoldStatus(false);
                formatted.SetItalicStatus(false);
                formatted.SetUnderlineStatus(false);
                formatted.SetAllCapsStatus(false);
                formatted.SetSuperscriptStatus(false);
                formatted.SetSubscriptStatus(false);
                foreach (var span in spans)
                {
                    var range = new TextRange(span.Start, span.Length);
                    formatted.SetBoldStatus(range, span.Style.Bold);
                    formatted.SetItalicStatus(range, span.Style.Italic);
                    formatted.SetUnderlineStatus(range, span.Style.Underline);
                    formatted.SetAllCapsStatus(range, span.Style.AllCaps);
                    if (span.Style.VerticalAlignment == "superscript") formatted.SetSuperscriptStatus(range, true);
                    if (span.Style.VerticalAlignment == "subscript") formatted.SetSubscriptStatus(range, true);
                }
                // Preserve authored case and run formatting; a drafting-uppercase policy must not rewrite imported specifications.
                note.SetFormattedText(formatted);
            }
        }

        public static object Read(TextNote note, IReadOnlyList<(int Start, int Length)> ranges)
        {
            if (note == null || ranges == null || ranges.Count > 10000) throw new ArgumentException("A native note and bounded character ranges are required.");
            using (var formatted = note.GetFormattedText())
            {
                var text = formatted.GetPlainText();
                var captured = new List<object>();
                foreach (var range in ranges)
                {
                    if (range.Start < 0 || range.Length < 1 || range.Start > text.Length - range.Length) throw new InvalidOperationException("Character range is outside the native text.");
                    var nativeRange = new TextRange(range.Start, range.Length);
                    captured.Add(new { start = range.Start, length = range.Length,
                        text = formatted.GetPlainText(nativeRange),
                        bold = formatted.GetBoldStatus(nativeRange).ToString(),
                        italic = formatted.GetItalicStatus(nativeRange).ToString(),
                        underline = formatted.GetUnderlineStatus(nativeRange).ToString(),
                        allCaps = formatted.GetAllCapsStatus(nativeRange).ToString(),
                        superscript = formatted.GetSuperscriptStatus(nativeRange).ToString(),
                        subscript = formatted.GetSubscriptStatus(nativeRange).ToString() });
                }
                var type = note.TextNoteType;
                var anchor = note.Coord;
                return new { scope = "native_text_note_parameters_and_character_status_only",
                    id = ElementIdCompat.GetValue(note.Id), uniqueId = note.UniqueId,
                    ownerViewId = ElementIdCompat.GetValue(note.OwnerViewId), text, ranges = captured,
                    font = type.get_Parameter(BuiltInParameter.TEXT_FONT)?.AsString(),
                    textSizeFt = type.get_Parameter(BuiltInParameter.TEXT_SIZE)?.AsDouble(),
                    color = type.get_Parameter(BuiltInParameter.LINE_COLOR)?.AsInteger(),
                    typeId = ElementIdCompat.GetValue(type.Id),
                    widthPaperFt = note.Width, heightPaperFt = note.Height,
                    anchorModelFt = new { x = anchor.X, y = anchor.Y, z = anchor.Z },
                    fontAvailabilityVerified = false, wholeTaskVerified = false };
            }
        }

        private static bool SameTypography(DrawingSpecCharacterStyle a, DrawingSpecCharacterStyle b) =>
            string.Equals(a.FontFamily, b.FontFamily, StringComparison.OrdinalIgnoreCase) && a.PointSize == b.PointSize &&
            ColorValue(a.Color) == ColorValue(b.Color) && a.TrackingPoints == b.TrackingPoints;

        internal static int ColorValue(string color)
        {
            if (color == "auto") return 0;
            if (color.Length != 6 || !int.TryParse(color, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rgb))
                throw new InvalidOperationException("Source color requires theme/automatic-color resolution.");
            return ((rgb >> 16) & 255) | (rgb & 0x00ff00) | ((rgb & 255) << 16);
        }
    }
}
