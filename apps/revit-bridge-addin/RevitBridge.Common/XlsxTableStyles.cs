using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Xml;
using System.Xml.Linq;

namespace RevitBridge.Common
{
    public sealed class XlsxTableStyles
    {
        private static readonly XNamespace S = XlsxSourcePackage.S;
        private readonly XElement root;
        private readonly List<XElement> fonts, fills, borders, xfs, bases;
        private readonly Dictionary<int, string> formats = new Dictionary<int, string>
        { [0] = "General", [1] = "0", [2] = "0.00", [3] = "#,##0", [4] = "#,##0.00", [9] = "0%", [10] = "0.00%", [49] = "@" };
        private readonly List<string> theme = new List<string>();
        private readonly List<string> indexed = new List<string>();
        private readonly XElement normalFont;
        public string NormalFontFamily => (string?)normalFont.Element(S + "name")?.Attribute("val") ?? "";
        public double NormalFontPoints => Number(normalFont.Element(S + "sz")?.Attribute("val"), 0);
        public bool NormalFontBold => On(normalFont.Element(S + "b"));
        public bool NormalFontItalic => On(normalFont.Element(S + "i"));

        public XlsxTableStyles(XlsxOutputSourceManifest source)
        {
            var parts = source.FormattingParts.Values.Select(Parse).ToArray();
            root = parts.SingleOrDefault(p => p.Name == S + "styleSheet") ?? throw new InvalidOperationException("Explicit XLSX style definitions are required; no application font was guessed.");
            List<XElement> Table(string name, string child) => root.Element(S + name)?.Elements(S + child).ToList() ?? new List<XElement>();
            fonts = Table("fonts", "font");fills = Table("fills", "fill");borders = Table("borders", "border");xfs = Table("cellXfs", "xf");bases = Table("cellStyleXfs", "xf");
            var normals = root.Element(S + "cellStyles")?.Elements(S + "cellStyle").Where(s => (string?)s.Attribute("builtinId") == "0" || (string?)s.Attribute("name") == "Normal").ToArray() ?? Array.Empty<XElement>();
            if (normals.Length > 1) throw new InvalidOperationException("Ambiguous Normal cell style.");
            int normalBase = Integer(normals.FirstOrDefault()?.Attribute("xfId"), 0);
            int normalId = normalBase >= 0 && normalBase < bases.Count ? Integer(bases[normalBase].Attribute("fontId"), 0) : 0;
            normalFont = normalId >= 0 && normalId < fonts.Count ? fonts[normalId] : throw new InvalidOperationException("Normal font definition is missing.");
            if (fonts.Count == 0 || xfs.Count == 0 || !Finite(NormalFontPoints) || NormalFontPoints <= 0 || NormalFontFamily.Length == 0)
                throw new InvalidOperationException("XLSX font/style definitions are incomplete.");
            foreach (var item in root.Element(S + "numFmts")?.Elements(S + "numFmt") ?? Enumerable.Empty<XElement>())
            {
                int id = Integer(item.Attribute("numFmtId"), -1);var code = (string?)item.Attribute("formatCode");
                if (id < 164 || code == null || formats.ContainsKey(id)) throw new InvalidOperationException("Ambiguous custom number format.");
                formats.Add(id, code);
            }
            XNamespace a = "http://schemas.openxmlformats.org/drawingml/2006/main";
            var scheme = parts.SingleOrDefault(p => p.Name == a + "theme")?.Element(a + "themeElements")?.Element(a + "clrScheme");
            foreach (var name in new[] { "lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink" })
            {
                var color = scheme?.Element(a + name)?.Elements().SingleOrDefault();
                theme.Add((string?)color?.Attribute(color.Name.LocalName == "sysClr" ? "lastClr" : "val") ?? "");
            }
            indexed.AddRange(root.Element(S + "colors")?.Element(S + "indexedColors")?.Elements(S + "rgbColor").Select(c => (string?)c.Attribute("rgb") ?? "") ?? Enumerable.Empty<string>());
        }
        public int StyleIndex(XlsxSourceCell? cell, XlsxSourceRow? row, XlsxSourceColumn? column) => cell?.StyleIndex ?? row?.StyleIndex ?? column?.StyleIndex ?? 0;
        public XlsxTableCellStyle Read(int index)
        {
            if (index < 0 || index >= xfs.Count) throw new InvalidOperationException("Unknown XLSX cell style index.");
            var xf = xfs[index];int parent = Integer(xf.Attribute("xfId"), 0);
            if (parent < 0 || bases.Count > 0 && parent >= bases.Count) throw new InvalidOperationException("Unknown source base style.");
            var baseline = parent < bases.Count ? bases[parent] : null;
            XElement? Value(string group, string list, List<XElement> entries)
            {
                var current = False(xf.Attribute("apply" + group)) ? baseline : xf;
                int id = Integer(current?.Attribute(list + "Id"), Integer(baseline?.Attribute(list + "Id"), 0));
                return id >= 0 && id < entries.Count ? entries[id] : throw new InvalidOperationException("Unknown XLSX " + list + " identity.");
            }
            var font = Value("Font", "font", fonts)!;
            var result = new XlsxTableCellStyle { Index = index, SourceStyleXml = xf.ToString(SaveOptions.DisableFormatting),
                FontFamily = (string?)font.Element(S + "name")?.Attribute("val") ?? NormalFontFamily,
                FontPoints = Number(font.Element(S + "sz")?.Attribute("val"), NormalFontPoints),
                Bold = On(font.Element(S + "b")), Italic = On(font.Element(S + "i")), Underline = On(font.Element(S + "u")), Strike = On(font.Element(S + "strike")),
                VerticalScript = (string?)font.Element(S + "vertAlign")?.Attribute("val") ?? "baseline" };
            if (!Finite(result.FontPoints) || result.FontPoints <= 0 || result.FontPoints > 200 || result.FontFamily.Length > 200)
                throw new InvalidOperationException("Invalid source font size or family.");
            result.Foreground = Color(font.Element(S + "color"), result);
            var underline = (string?)font.Element(S + "u")?.Attribute("val");
            if (underline != null && underline != "single" && underline != "none") result.Unsupported.Add("underline_pattern:" + underline);
            if (!new[] { "baseline", "superscript", "subscript" }.Contains(result.VerticalScript)) result.Unsupported.Add("vertical_script:" + result.VerticalScript);
            int numFmt = Integer((False(xf.Attribute("applyNumberFormat")) ? baseline : xf)?.Attribute("numFmtId"), Integer(baseline?.Attribute("numFmtId"), 0));
            result.NumberFormat = formats.TryGetValue(numFmt, out var known) ? known : "excel-builtin:" + numFmt;
            var alignment = False(xf.Attribute("applyAlignment")) ? baseline?.Element(S + "alignment") : xf.Element(S + "alignment") ?? baseline?.Element(S + "alignment");
            result.Horizontal = (string?)alignment?.Attribute("horizontal") ?? "general";result.Vertical = (string?)alignment?.Attribute("vertical") ?? "bottom";
            result.Wrap = True(alignment?.Attribute("wrapText"));result.Rotation = Integer(alignment?.Attribute("textRotation"), 0);result.Indent = Integer(alignment?.Attribute("indent"), 0);
            if (!new[] { "left", "center", "right", "general" }.Contains(result.Horizontal)) result.Unsupported.Add("alignment:" + result.Horizontal);
            if (!new[] { "top", "center", "bottom" }.Contains(result.Vertical)) result.Unsupported.Add("vertical_alignment:" + result.Vertical);
            if (True(alignment?.Attribute("shrinkToFit"))) result.Unsupported.Add("shrink_to_fit_requires_explicit_readable_layout");
            if (result.Rotation != 0 || result.Indent != 0) result.Unsupported.Add("rotated_or_indented_text_requires_native_layout_policy");
            if (fills.Count > 0)
            {
                var fill = Value("Fill", "fill", fills)!;var pattern = fill.Element(S + "patternFill");var kind = (string?)pattern?.Attribute("patternType") ?? "none";
                if (kind == "solid") result.Background = Color(pattern?.Element(S + "fgColor"), result);
                else if (kind != "none" || fill.Element(S + "gradientFill") != null) result.Unsupported.Add("non_solid_fill");
            }
            else if (Integer(xf.Attribute("fillId"), 0) != 0 || Integer(baseline?.Attribute("fillId"), 0) != 0)
                throw new InvalidOperationException("Referenced XLSX fill definitions are missing.");
            if (borders.Count > 0)
            {
                var border = Value("Border", "border", borders)!;
                if (True(border.Attribute("diagonalUp")) || True(border.Attribute("diagonalDown"))) result.Unsupported.Add("diagonal_border");
                foreach (var side in new[] { "left", "right", "top", "bottom" })
                {
                    var line = border.Element(S + side);var style = (string?)line?.Attribute("style");
                    if (style != null && style != "none") result.Borders.Add(side, new XlsxTableBorder { Style = style, Color = Color(line?.Element(S + "color"), result) });
                }
            }
            else if (Integer(xf.Attribute("borderId"), 0) != 0 || Integer(baseline?.Attribute("borderId"), 0) != 0)
                throw new InvalidOperationException("Referenced XLSX border definitions are missing.");
            return result;
        }
        private string Color(XElement? color, XlsxTableCellStyle style)
        {
            if (color == null || True(color.Attribute("auto"))) return "#000000";
            string? rgb = (string?)color.Attribute("rgb");
            int themeIndex = Integer(color.Attribute("theme"), -1), index = Integer(color.Attribute("indexed"), -1);
            if (themeIndex >= 0 && themeIndex < theme.Count) rgb = theme[themeIndex];
            if (index >= 0)
            {
                if (index < indexed.Count) rgb = indexed[index];
                else if (index == 64) rgb = "000000";
                else if (index == 65) rgb = "FFFFFF";
                else if (index < 16) rgb = new[] { "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF" }[index % 8];
            }
            if (rgb?.Length == 8)
            {
                if (!rgb.StartsWith("00", StringComparison.OrdinalIgnoreCase) && !rgb.StartsWith("FF", StringComparison.OrdinalIgnoreCase))
                    style.Unsupported.Add("color_alpha_requires_render_policy");
                rgb = rgb.Substring(2);
            }
            if (rgb == null || rgb.Length != 6 || !rgb.All(Uri.IsHexDigit)) { style.Unsupported.Add("unresolved_color:" + color);return "#000000"; }
            if (Number(color.Attribute("tint"), 0) != 0) style.Unsupported.Add("color_tint_requires_conversion");
            return "#" + rgb.ToUpperInvariant();
        }
        private static XElement Parse(string xml)
        {
            using (var input = new StringReader(xml))
            using (var reader = XmlReader.Create(input, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 16 * 1024 * 1024 }))
                return XElement.Load(reader);
        }
        private static bool True(XAttribute? value) => value?.Value == "1" || value?.Value == "true";
        private static bool False(XAttribute? value) => value?.Value == "0" || value?.Value == "false";
        private static bool On(XElement? value) => value != null && !False(value.Attribute("val")) && (string?)value.Attribute("val") != "none";
        private static int Integer(XAttribute? value, int fallback) => value == null ? fallback : int.TryParse(value.Value, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : throw new InvalidOperationException("Invalid integer source style property.");
        private static double Number(XAttribute? value, double fallback) => value == null ? fallback : double.TryParse(value.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) && Finite(n) ? n : throw new InvalidOperationException("Invalid numeric source style property.");
        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    }
}
