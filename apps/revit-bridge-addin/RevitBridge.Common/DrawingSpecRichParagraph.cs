using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Xml.Linq;

namespace RevitBridge.Common
{
    public sealed class DrawingSpecCharacterStyle
    {
        public string FontFamily { get; set; } = "";
        public double PointSize { get; set; }
        public bool Bold { get; set; }
        public bool Italic { get; set; }
        public bool Underline { get; set; }
        public bool AllCaps { get; set; }
        public string VerticalAlignment { get; set; } = "baseline";
        public string Color { get; set; } = "auto";
        public double TrackingPoints { get; set; }
    }

    public sealed class DrawingSpecCharacterSpan
    {
        public int Start { get; set; }
        public int Length { get; set; }
        public bool IsNumbering { get; set; }
        public DrawingSpecCharacterStyle Style { get; set; } = new DrawingSpecCharacterStyle();
    }

    public sealed class DrawingSpecTabStop
    {
        public string Alignment { get; set; } = "left";
        public double PositionInches { get; set; }
    }

    // Intermediate source data, not a Revit transaction or a successful conversion receipt.
    public sealed class DrawingSpecRichParagraph
    {
        private static readonly XNamespace W = DocxSourceStyles.W;
        public string SourceId { get; private set; } = "";
        public string SourceText { get; private set; } = "";
        public string NativeText { get; private set; } = "";
        public List<DrawingSpecCharacterSpan> Spans { get; } = new List<DrawingSpecCharacterSpan>();
        public List<DrawingSpecTabStop> Tabs { get; } = new List<DrawingSpecTabStop>();
        public List<string> Warnings { get; } = new List<string>();
        public DrawingSpecCharacterStyle DefaultStyle { get; private set; } = new DrawingSpecCharacterStyle();
        public double LeftIndentInches { get; private set; }
        public double HangingIndentInches { get; private set; }
        public double FirstLineIndentInches { get; private set; }
        public double BeforeInches { get; private set; }
        public double AfterInches { get; private set; }
        public string Alignment { get; private set; } = "left";
        public bool KeepWithNext { get; private set; }
        public bool KeepLines { get; private set; }
        public bool PageBreakBefore { get; private set; }
        public string LineSpacingRule { get; private set; } = "auto";
        public double LineSpacingValue { get; private set; } = 240;
        public double DefaultTabStopInches { get; private set; } = .5;
        public bool ImplicitHangingTab { get; private set; } = true;
        public string DecimalSeparator { get; private set; } = ".";
        public bool RequiresInlineTextFragments => Spans.Select(s => (s.Style.FontFamily, s.Style.PointSize, s.Style.Color, s.Style.TrackingPoints)).Distinct().Count() > 1;

        public IReadOnlyList<DrawingSpecCharacterSpan> Slice(int start, int length)
        {
            if (start < 0 || length < 0 || start > NativeText.Length - length) throw new ArgumentOutOfRangeException(nameof(start));
            var spans = Spans.Where(s => s.Start < start + length && s.Start + s.Length > start).Select(s =>
            {
                int left = Math.Max(s.Start, start), right = Math.Min(s.Start + s.Length, start + length);
                return new DrawingSpecCharacterSpan { Start = left - start, Length = right - left, IsNumbering = s.IsNumbering, Style = s.Style };
            }).ToArray();
            if (spans.Sum(s => s.Length) != length) throw new InvalidOperationException("Formatting spans do not cover the selected text completely.");
            return spans;
        }

        public static DrawingSpecRichParagraph Build(DrawingSpecBlock block, string nativeFallbackFont, double nativeFallbackPointSize)
        {
            if (block == null || block.Kind != "paragraph" || string.IsNullOrWhiteSpace(nativeFallbackFont) ||
                double.IsNaN(nativeFallbackPointSize) || double.IsInfinity(nativeFallbackPointSize) || nativeFallbackPointSize <= 0)
                throw new ArgumentException("A source paragraph and actual native fallback font/size are required.");
            if (string.Concat(block.Runs.Select(r => r.Text)) != block.Text) throw new InvalidOperationException("Source run text does not cover the complete paragraph.");
            var result = new DrawingSpecRichParagraph { SourceId = block.SourcePath, DefaultTabStopInches = block.DefaultTabStopInches, ImplicitHangingTab = block.ImplicitHangingTab };
            var language = block.Runs.Select(r => DocxSourceStyles.Val(XElement.Parse(r.PropertiesXml).Element(W + "lang"))).FirstOrDefault(l => l != null);
            if (language != null)
            {
                try { result.DecimalSeparator = CultureInfo.GetCultureInfo(language).NumberFormat.NumberDecimalSeparator; }
                catch (CultureNotFoundException) { result.Warnings.Add("unresolved_decimal_tab_language"); }
            }
            var fallback = new DrawingSpecCharacterStyle { FontFamily = nativeFallbackFont, PointSize = nativeFallbackPointSize };
            result.DefaultStyle = block.DefaultRunPropertiesXml == null ? fallback : ReadStyle(XElement.Parse(block.DefaultRunPropertiesXml), fallback, result.Warnings);
            var prefix = (block.NumberingMarker ?? "") + (block.NumberingMarker == null ? "" : block.NumberingSuffix);
            result.SourceText = prefix + block.Text;
            // One UTF-16 unit for one source unit: Revit uses vertical tab for a soft line break.
            // Page/column breaks are retained for the flow adapter, never passed to FormattedText.
            result.NativeText = result.SourceText.Replace('\n', '\v');
            int cursor = prefix.Length;
            foreach (var run in block.Runs)
            {
                var style = ReadStyle(XElement.Parse(run.PropertiesXml), fallback, result.Warnings);
                if (run.Text.Length > 0) result.Spans.Add(new DrawingSpecCharacterSpan { Start = cursor, Length = run.Text.Length, Style = style });
                cursor += run.Text.Length;
            }
            if (prefix.Length > 0)
            {
                var labelBase = result.Spans.FirstOrDefault()?.Style ?? result.DefaultStyle;
                var labelProperties = block.NumberingDefinitionXml == null ? new XElement(W + "rPr") : XElement.Parse(block.NumberingDefinitionXml).Element(W + "rPr") ?? new XElement(W + "rPr");
                result.Spans.Insert(0, new DrawingSpecCharacterSpan { Start = 0, Length = prefix.Length, IsNumbering = true,
                    Style = ReadStyle(labelProperties, labelBase, result.Warnings) });
            }
            var properties = XElement.Parse(block.PropertiesXml);
            result.LeftIndentInches = Number(properties.Element(W + "ind")?.Attribute(W + "left")) / 1440;
            result.HangingIndentInches = Number(properties.Element(W + "ind")?.Attribute(W + "hanging")) / 1440;
            result.FirstLineIndentInches = Number(properties.Element(W + "ind")?.Attribute(W + "firstLine")) / 1440;
            result.BeforeInches = Number(properties.Element(W + "spacing")?.Attribute(W + "before")) / 1440;
            result.AfterInches = Number(properties.Element(W + "spacing")?.Attribute(W + "after")) / 1440;
            result.Alignment = DocxSourceStyles.Val(properties.Element(W + "jc")) ?? "left";
            result.KeepWithNext = On(properties.Element(W + "keepNext"), false);
            result.KeepLines = On(properties.Element(W + "keepLines"), false);
            result.PageBreakBefore = On(properties.Element(W + "pageBreakBefore"), false);
            foreach (var tab in properties.Element(W + "tabs")?.Elements(W + "tab") ?? Enumerable.Empty<XElement>())
                result.Tabs.Add(new DrawingSpecTabStop { Alignment = (string?)tab.Attribute(W + "val") ?? "left", PositionInches = Number(tab.Attribute(W + "pos")) / 1440 });
            if (properties.Element(W + "spacing")?.Attribute(W + "line") != null)
            {
                result.LineSpacingRule = (string?)properties.Element(W + "spacing")?.Attribute(W + "lineRule") ?? "auto";
                result.LineSpacingValue = Number(properties.Element(W + "spacing")?.Attribute(W + "line"));
                if (result.LineSpacingValue <= 0 || !new[] { "auto", "exact", "atLeast" }.Contains(result.LineSpacingRule))
                    result.Warnings.Add("source_line_spacing_requires_native_mapping");
            }
            if (result.NativeText.IndexOf('\f') >= 0) result.Warnings.Add("split_explicit_page_or_column_break_before_native_text");
            return result;
        }

        private static DrawingSpecCharacterStyle ReadStyle(XElement properties, DrawingSpecCharacterStyle fallback, List<string> warnings)
        {
            var font = properties.Element(W + "rFonts");
            var family = (string?)font?.Attribute(W + "ascii") ?? fallback.FontFamily;
            if (string.IsNullOrWhiteSpace(family)) throw new InvalidOperationException("Empty source font family.");
            if (font?.Attribute(W + "asciiTheme") != null && font.Attribute(W + "ascii") == null) warnings.Add("font_theme_requires_resolution");
            var pointSize = properties.Element(W + "sz") == null ? fallback.PointSize : Number(properties.Element(W + "sz")?.Attribute(W + "val")) / 2;
            if (pointSize <= 0) throw new InvalidOperationException("Invalid source text point size; no font reduction/substitution was selected.");
            var underline = DocxSourceStyles.Val(properties.Element(W + "u"));
            if (underline != null && underline != "none" && underline != "single") warnings.Add("underline_pattern_requires_native_mapping:" + underline);
            var result = new DrawingSpecCharacterStyle { FontFamily = family, PointSize = pointSize,
                Bold = On(properties.Element(W + "b"), fallback.Bold), Italic = On(properties.Element(W + "i"), fallback.Italic),
                Underline = properties.Element(W + "u") == null ? fallback.Underline : underline != "none",
                AllCaps = On(properties.Element(W + "caps"), fallback.AllCaps),
                VerticalAlignment = DocxSourceStyles.Val(properties.Element(W + "vertAlign")) ?? fallback.VerticalAlignment,
                Color = DocxSourceStyles.Val(properties.Element(W + "color")) ?? fallback.Color,
                TrackingPoints = properties.Element(W + "spacing") == null ? fallback.TrackingPoints : Number(properties.Element(W + "spacing")?.Attribute(W + "val")) / 20 };
            foreach (var name in new[] { "strike", "dstrike", "smallCaps", "vanish", "rtl", "shd", "bdr", "highlight", "w", "kern" })
                if (properties.Element(W + name) != null) warnings.Add("character_property_requires_native_mapping:" + name);
            return result;
        }

        private static bool On(XElement? element, bool fallback) => element == null ? fallback : !new[] { "0", "false", "off" }.Contains(DocxSourceStyles.Val(element));
        private static double Number(XAttribute? attribute) => attribute == null ? 0 :
            double.TryParse(attribute.Value, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var value) &&
            !double.IsNaN(value) && !double.IsInfinity(value) ? value : throw new InvalidOperationException("Invalid source formatting measure.");
    }
}
