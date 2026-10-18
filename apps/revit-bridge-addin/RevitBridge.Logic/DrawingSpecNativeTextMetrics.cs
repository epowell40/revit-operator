using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing.Text;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    // Must run within the importing handler's single native transaction. Probes are always removed;
    // only dedicated types and final notes enter its native-created set. No own transaction/verdict.
    public sealed class DrawingSpecNativeTextMetrics
    {
        private readonly Document document;
        private readonly View measurementView;
        private readonly TextNoteType baseType;
        private readonly ISet<long> nativeCreated;
        private readonly Dictionary<string, ElementId> types = new Dictionary<string, ElementId>();
        private readonly Dictionary<string, DrawingSpecTextMeasurement> cache = new Dictionary<string, DrawingSpecTextMeasurement>();
        private readonly HashSet<string> fonts;
        private readonly Stopwatch elapsed = Stopwatch.StartNew();
        private int probes;
        public int NativeProbeCount => probes;
        public int CacheEntries => cache.Count;

        public DrawingSpecNativeTextMetrics(Document document, View view, TextNoteType baseType, ISet<long> nativeCreated)
        {
            this.document = document ?? throw new ArgumentNullException(nameof(document));
            measurementView = view ?? throw new ArgumentNullException(nameof(view));
            this.baseType = baseType ?? throw new ArgumentNullException(nameof(baseType));
            this.nativeCreated = nativeCreated ?? throw new ArgumentNullException(nameof(nativeCreated));
            if (!document.IsModifiable || view.Document != document || baseType.Document != document)
                throw new InvalidOperationException("Text metrics require the owned active native transaction and document.");
            fonts = InstalledFonts();
        }

        public static void ValidateSourceFonts(IEnumerable<DrawingSpecRichParagraph> paragraphs)
        {
            var available = InstalledFonts();
            foreach (var family in paragraphs.SelectMany(p => p.Spans.Select(s => s.Style.FontFamily).Append(p.DefaultStyle.FontFamily)).Distinct(StringComparer.OrdinalIgnoreCase))
                if (!available.Contains(family)) throw new InvalidOperationException("Source font is not installed: " + family);
        }

        private static HashSet<string> InstalledFonts()
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (var installed = new InstalledFontCollection())
                foreach (var family in installed.Families) using (family) names.Add(family.Name);
            return names;
        }

        public DrawingSpecTextMeasurement Measure(DrawingSpecRichParagraph paragraph, int start, int length)
        {
            CheckBound();
            var spans = paragraph.Slice(start, length);
            var style = spans.FirstOrDefault()?.Style ?? paragraph.Spans.LastOrDefault(s => s.Start <= start)?.Style ?? paragraph.Spans.FirstOrDefault()?.Style ?? paragraph.DefaultStyle;
            if (spans.Any(s => Typography(s.Style) != Typography(style))) throw new InvalidOperationException("Measure inline typography groups separately.");
            var text = paragraph.NativeText.Substring(start, length);
            var key = text + "\u001f" + string.Join(";", spans.Select(s => s.Start + ":" + s.Length + ":" + Typography(s.Style) + ":" +
                s.Style.Bold + ":" + s.Style.Italic + ":" + s.Style.Underline + ":" + s.Style.AllCaps + ":" + s.Style.VerticalAlignment));
            if (length == 0) key = "empty:" + Typography(style) + ":" + style.Bold + ":" + style.Italic;
            if (cache.TryGetValue(key, out var existing)) return existing;
            DrawingSpecTextMeasurement result;
            if (text.Length == 0 || text.All(c => c == ' '))
            {
                var left = Probe(Synthetic("X", style));
                if (text.Length == 0) result = new DrawingSpecTextMeasurement { WidthInches = 0, HeightInches = left.HeightInches };
                else
                {
                    var around = Probe(Synthetic("X" + text + "X", style));
                    result = new DrawingSpecTextMeasurement { WidthInches = Math.Max(0, around.WidthInches - 2 * left.WidthInches), HeightInches = around.HeightInches };
                }
            }
            else result = Probe(paragraph, start, length);
            cache.Add(key, result);
            return result;
        }

        public TextNote Create(View target, XYZ anchorModelFt, DrawingSpecRichParagraph paragraph, int start, int length)
        {
            CheckBound();
            if (target.Document != document || !document.IsModifiable) throw new InvalidOperationException("Wrong target document or missing owned transaction.");
            var spans = paragraph.Slice(start, length);
            if (spans.Count == 0 || paragraph.NativeText.Substring(start, length).All(char.IsWhiteSpace))
                throw new InvalidOperationException("Whitespace belongs in an explicit measured layout span, not a fabricated text-note receipt.");
            var note = TextNote.Create(document, target.Id, anchorModelFt, paragraph.NativeText.Substring(start, length), ResolveType(spans[0].Style));
            DrawingSpecNativeTextFormatting.Apply(note, paragraph, start, length);
            nativeCreated.Add(ElementIdCompat.GetValue(note.Id));
            return note;
        }

        private DrawingSpecTextMeasurement Probe(DrawingSpecRichParagraph paragraph, int start = 0, int? length = null)
        {
            CheckBound();
            int count = length ?? paragraph.NativeText.Length;
            var style = paragraph.Slice(start, count)[0].Style;
            var note = TextNote.Create(document, measurementView.Id, XYZ.Zero, paragraph.NativeText.Substring(start, count), ResolveType(style));
            try
            {
                DrawingSpecNativeTextFormatting.Apply(note, paragraph, start, count);
                document.Regenerate();
                probes++;
                return new DrawingSpecTextMeasurement { WidthInches = note.Width * 12, HeightInches = note.Height * 12 };
            }
            finally { document.Delete(note.Id); } // Do not swallow probe cleanup failure or claim a complete import.
        }

        private ElementId ResolveType(DrawingSpecCharacterStyle style)
        {
            if (!fonts.Contains(style.FontFamily)) throw new InvalidOperationException("Source font is not installed: " + style.FontFamily);
            if (style.TrackingPoints != 0) throw new InvalidOperationException("Explicit source tracking requires individual glyph spacing before native note creation.");
            string key = Typography(style);
            if (types.TryGetValue(key, out var cached)) return cached;
            string name;
            using (var hash = SHA256.Create()) name = "Operator Spec " + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(key))).Replace("-", "").Substring(0, 20);
            var type = new FilteredElementCollector(document).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().SingleOrDefault(t => t.Name == name);
            if (type == null)
            {
                type = (TextNoteType)baseType.Duplicate(name);
                nativeCreated.Add(ElementIdCompat.GetValue(type.Id));
                type.get_Parameter(BuiltInParameter.TEXT_FONT).Set(style.FontFamily);
                type.get_Parameter(BuiltInParameter.TEXT_SIZE).Set(style.PointSize / 864);
                type.get_Parameter(BuiltInParameter.TEXT_COLOR).Set(DrawingSpecNativeTextFormatting.ColorValue(style.Color));
                type.get_Parameter(BuiltInParameter.TEXT_STYLE_BOLD).Set(0);
                type.get_Parameter(BuiltInParameter.TEXT_STYLE_ITALIC).Set(0);
                type.get_Parameter(BuiltInParameter.TEXT_STYLE_UNDERLINE).Set(0);
                type.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).Set(1d);
                type.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).Set(1); // Transparent fragments do not mask adjacent source glyphs.
            }
            if (!string.Equals(type.get_Parameter(BuiltInParameter.TEXT_FONT).AsString(), style.FontFamily, StringComparison.OrdinalIgnoreCase) ||
                Math.Abs(type.get_Parameter(BuiltInParameter.TEXT_SIZE).AsDouble() * 864 - style.PointSize) > .000001 ||
                type.get_Parameter(BuiltInParameter.TEXT_COLOR).AsInteger() != DrawingSpecNativeTextFormatting.ColorValue(style.Color) ||
                type.get_Parameter(BuiltInParameter.TEXT_STYLE_BOLD).AsInteger() != 0 || type.get_Parameter(BuiltInParameter.TEXT_STYLE_ITALIC).AsInteger() != 0 ||
                type.get_Parameter(BuiltInParameter.TEXT_STYLE_UNDERLINE).AsInteger() != 0 || Math.Abs(type.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).AsDouble() - 1) > .000001 ||
                type.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).AsInteger() != 1)
                throw new InvalidOperationException("A named imported text type differs from its source typography; unrelated type was not edited.");
            types.Add(key, type.Id);
            return type.Id;
        }

        private static string Typography(DrawingSpecCharacterStyle s) => s.FontFamily.ToUpperInvariant() + "|" +
            s.PointSize.ToString("R", CultureInfo.InvariantCulture) + "|" + DrawingSpecNativeTextFormatting.ColorValue(s.Color) + "|" + s.TrackingPoints.ToString("R", CultureInfo.InvariantCulture);

        private static DrawingSpecRichParagraph Synthetic(string text, DrawingSpecCharacterStyle style)
        {
            XNamespace w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
            var block = new DrawingSpecBlock { Kind = "paragraph", SourcePath = "native-measurement-sentinel", Text = text, PropertiesXml = new XElement(w + "pPr").ToString() };
            var properties = new XElement(w + "rPr", new XElement(w + "rFonts", new XAttribute(w + "ascii", style.FontFamily)),
                new XElement(w + "sz", new XAttribute(w + "val", style.PointSize * 2)),
                new XElement(w + "b", new XAttribute(w + "val", style.Bold ? 1 : 0)),
                new XElement(w + "i", new XAttribute(w + "val", style.Italic ? 1 : 0)),
                new XElement(w + "color", new XAttribute(w + "val", style.Color)));
            block.Runs.Add(new DrawingSpecRun { Text = text, PropertiesXml = properties.ToString() });
            return DrawingSpecRichParagraph.Build(block, style.FontFamily, style.PointSize);
        }

        private void CheckBound()
        {
            if (elapsed.Elapsed.TotalSeconds > 100 || probes >= 20000)
                throw new InvalidOperationException("Native specification measurement exceeded its bounded callback. Roll back this attempt; do not report or repeat an uncertain partial import.");
        }
    }
}
