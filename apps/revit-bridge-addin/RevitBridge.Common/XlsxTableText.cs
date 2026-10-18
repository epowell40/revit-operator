using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Xml;
using System.Xml.Linq;

namespace RevitBridge.Common
{
    // Reuse the existing native rich-text contract. Source styles are converted
    // explicitly; unsupported run properties never disappear in a plain string.
    public static class XlsxTableText
    {
        private static readonly XNamespace S = XlsxSourcePackage.S;
        private static readonly XNamespace W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

        public static DrawingSpecRichParagraph Paragraph(XlsxTableCellFrame cell)
        {
            if (cell == null || cell.Style == null || cell.Text == null) throw new ArgumentNullException(nameof(cell));
            string alignment = cell.Style.Horizontal == "general"
                ? cell.SourceDataType == "b" || cell.SourceDataType == "e" ? "center" : cell.SourceDataType == "n" ? "right" : "left"
                : cell.Style.Horizontal;
            if (!new[] { "left", "center", "right" }.Contains(alignment)) throw new InvalidOperationException("Unmapped Excel horizontal alignment.");
            var block = new DrawingSpecBlock { Kind = "paragraph", SourcePath = cell.Address, Text = cell.Text,
                PropertiesXml = new XElement(W + "pPr", new XElement(W + "jc", new XAttribute(W + "val", alignment))).ToString() };
            XElement? rich = null;
            if (cell.SourceRichTextXml != null)
            {
                using (var input = new StringReader(cell.SourceRichTextXml))
                using (var reader = XmlReader.Create(input, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 2 * 1024 * 1024 }))
                    rich = XElement.Load(reader);
                if (rich.Name != S + "si" && rich.Name != S + "is") throw new InvalidOperationException("Unknown source rich-text root.");
            }
            var runs = rich?.Elements(S + "r").ToArray();
            if (runs != null && runs.Length > 0)
            {
                if (rich!.Elements(S + "t").Any()) throw new InvalidOperationException("Mixed plain/rich source text is ambiguous.");
                foreach (var run in runs)
                {
                    if (run.Elements().Any(e => e.Name != S + "rPr" && e.Name != S + "t")) throw new InvalidOperationException("Unsupported rich-run content.");
                    block.Runs.Add(new DrawingSpecRun { Text = string.Concat(run.Elements(S + "t").Select(t => t.Value)), PropertiesXml = Properties(cell, run.Element(S + "rPr")).ToString() });
                }
            }
            else block.Runs.Add(new DrawingSpecRun { Text = cell.Text, PropertiesXml = Properties(cell, null).ToString() });
            if (string.Concat(block.Runs.Select(r => r.Text)) != cell.Text) throw new InvalidOperationException("Rich source runs do not match the displayed cell; no text was flattened or substituted.");
            return DrawingSpecRichParagraph.Build(block, cell.Style.FontFamily, cell.RenderFontPoints);
        }

        private static XElement Properties(XlsxTableCellFrame cell, XElement? run)
        {
            var style = cell.Style;
            string Value(string name, string fallback) => (string?)run?.Element(S + name)?.Attribute("val") ?? fallback;
            bool Enabled(string name, bool fallback) => run?.Element(S + name) is XElement e ? (string?)e.Attribute("val") != "0" && (string?)e.Attribute("val") != "false" : fallback;
            var known = new[] { "rFont", "sz", "b", "i", "u", "vertAlign", "color", "family", "charset", "scheme" };
            if (style.Strike || run?.Elements().Any(e => !known.Contains(e.Name.LocalName) || e.Name.Namespace != S) == true)
                throw new InvalidOperationException("Excel run contains formatting without a native mapping.");
            var sizeText = Value("sz", cell.RenderFontPoints.ToString("R", CultureInfo.InvariantCulture));
            if (!double.TryParse(sizeText, NumberStyles.Float, CultureInfo.InvariantCulture, out var size) || double.IsNaN(size) || double.IsInfinity(size) || size <= 0 || size > 200)
                throw new InvalidOperationException("Invalid rich-run font size.");
            size = Math.Max(size, cell.MinimumTextPoints);
            var font = Value("rFont", style.FontFamily);
            if (string.IsNullOrWhiteSpace(font) || font.Length > 200) throw new InvalidOperationException("Rich source font is missing.");
            var vertical = Value("vertAlign", style.VerticalScript);
            if (!new[] { "baseline", "superscript", "subscript" }.Contains(vertical)) throw new InvalidOperationException("Unmapped rich vertical alignment.");
            string underline = run?.Element(S + "u") is XElement u ? (string?)u.Attribute("val") ?? "single" : style.Underline ? "single" : "none";
            if (underline != "single" && underline != "none") throw new InvalidOperationException("Unmapped Excel underline pattern.");
            string color = style.Foreground.TrimStart('#');
            if (run?.Element(S + "color") is XElement sourceColor)
            {
                var rgb = (string?)sourceColor.Attribute("rgb");
                if (sourceColor.Attributes().Any(a => a.Name.LocalName != "rgb") || rgb == null || rgb.Length != 6 && rgb.Length != 8 || !rgb.All(Uri.IsHexDigit))
                    throw new InvalidOperationException("Rich-run color requires explicit theme/index/tint resolution.");
                if (rgb.Length == 8)
                {
                    if (!rgb.StartsWith("00", StringComparison.OrdinalIgnoreCase) && !rgb.StartsWith("FF", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Rich-run alpha has no native mapping.");
                    rgb = rgb.Substring(2);
                }
                color = rgb;
            }
            return new XElement(W + "rPr", new XElement(W + "rFonts", new XAttribute(W + "ascii", font)),
                new XElement(W + "sz", new XAttribute(W + "val", size * 2)),
                new XElement(W + "b", new XAttribute(W + "val", Enabled("b", style.Bold) ? 1 : 0)),
                new XElement(W + "i", new XAttribute(W + "val", Enabled("i", style.Italic) ? 1 : 0)),
                new XElement(W + "u", new XAttribute(W + "val", underline)),
                new XElement(W + "vertAlign", new XAttribute(W + "val", vertical)),
                new XElement(W + "color", new XAttribute(W + "val", color)));
        }
    }
}
