using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace RevitBridge.Common
{
    internal sealed class DocxSourceNumbering
    {
        private static readonly XNamespace W = DocxSourceStyles.W;
        private readonly Dictionary<int, XElement> abstracts;
        private readonly Dictionary<int, XElement> instances;
        private readonly Dictionary<int, int?[]> counters = new Dictionary<int, int?[]>();
        private readonly HashSet<int> uncertain = new HashSet<int>();

        internal DocxSourceNumbering(XDocument? document)
        {
            abstracts = Index(document, "abstractNum", "abstractNumId");
            instances = Index(document, "num", "numId");
        }

        private static Dictionary<int, XElement> Index(XDocument? document, string element, string attribute) =>
            (document?.Root?.Elements(W + element) ?? Enumerable.Empty<XElement>()).ToDictionary(
                e => Parse((string?)e.Attribute(W + attribute)), e => e);

        internal void Apply(XElement paragraphProperties, DrawingSpecBlock block, Action<string> warn)
        {
            var numPr = paragraphProperties.Element(W + "numPr");
            if (numPr == null) return;
            int id = -1;
            try
            {
                id = Parse(DocxSourceStyles.Val(numPr.Element(W + "numId")));
                if (id == 0) return; // Explicit cancellation of inherited numbering.
                if (uncertain.Contains(id)) throw new InvalidOperationException("Earlier numbering in this list is unresolved.");
                var level = Parse(DocxSourceStyles.Val(numPr.Element(W + "ilvl")) ?? "0");
                if (level < 0 || level > 8) throw new InvalidOperationException("Invalid numbering level.");
                block.NumberingLevel = level;
                var definition = Level(id, level);
                block.NumberingDefinitionXml = definition.ToString(SaveOptions.DisableFormatting);
                var pattern = DocxSourceStyles.Val(definition.Element(W + "lvlText"));
                if (pattern == null) throw new InvalidOperationException("Missing numbering pattern.");
                if (!counters.TryGetValue(id, out var state)) counters[id] = state = new int?[9];
                state[level] = state[level].HasValue ? checked(state[level]!.Value + 1) : Start(id, level);
                var legal = definition.Element(W + "isLgl") != null &&
                    !new[] { "0", "false", "off" }.Contains(DocxSourceStyles.Val(definition.Element(W + "isLgl")));
                block.NumberingMarker = Regex.Replace(pattern, "%([1-9])", match =>
                {
                    int referenced = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture) - 1;
                    if (referenced > level) throw new InvalidOperationException("Forward numbering reference.");
                    var referencedLevel = Level(id, referenced);
                    var format = legal ? "decimal" : DocxSourceStyles.Val(referencedLevel.Element(W + "numFmt"));
                    return Format(state[referenced] ?? Start(id, referenced), format);
                });
                // A bullet is literal lvlText; other unimplemented formats must not appear successfully resolved.
                var ownFormat = DocxSourceStyles.Val(definition.Element(W + "numFmt"));
                if (ownFormat != "bullet") Format(state[level]!.Value, ownFormat);
                block.NumberingSuffix = Suffix(DocxSourceStyles.Val(definition.Element(W + "suff")) ?? "tab");
                if (block.NumberingMarker.Length == 0) block.NumberingSuffix = "";
                for (int lower = level + 1; lower <= 8; lower++)
                {
                    var lowerDefinition = TryLevel(id, lower);
                    if (lowerDefinition == null) continue;
                    var restart = DocxSourceStyles.Val(lowerDefinition.Element(W + "lvlRestart"));
                    int trigger = restart == null ? lower : Parse(restart);
                    if (trigger < 0 || trigger > lower) trigger = lower;
                    // Word restarts when the referenced level OR any higher level appears (MS-OI29500 2.1.282).
                    if (trigger != 0 && level < trigger) state[lower] = null;
                }
                if (ownFormat == "bullet") warn("bullet_font_requires_visual_check");
            }
            catch (Exception error) when (error is InvalidOperationException || error is FormatException || error is OverflowException)
            {
                if (id > 0) uncertain.Add(id);
                block.NumberingMarker = null;
                block.NumberingSuffix = "";
                warn("numbering_unresolved");
            }
        }

        private XElement? TryLevel(int id, int level)
        {
            if (!instances.TryGetValue(id, out var instance)) throw new InvalidOperationException("Numbering instance missing.");
            var abstractId = Parse(DocxSourceStyles.Val(instance.Element(W + "abstractNumId")));
            if (!abstracts.TryGetValue(abstractId, out var definition)) throw new InvalidOperationException("Abstract numbering missing.");
            if (definition.Element(W + "numStyleLink") != null || definition.Attribute(XName.Get("restartNumberingAfterBreak", "http://schemas.microsoft.com/office/word/2012/wordml")) != null)
                throw new InvalidOperationException("Linked or section-dependent numbering requires a layout engine.");
            var overrideLevel = instance.Elements(W + "lvlOverride").SingleOrDefault(e => Parse((string?)e.Attribute(W + "ilvl")) == level);
            var result = overrideLevel?.Element(W + "lvl") ?? definition.Elements(W + "lvl").SingleOrDefault(e => Parse((string?)e.Attribute(W + "ilvl")) == level);
            if (result == null) return null;
            result = new XElement(result);
            // Word ignores lvlRestart inside lvlOverride; retain the abstract restart definition.
            if (overrideLevel?.Element(W + "lvl") != null)
            {
                result.Element(W + "lvlRestart")?.Remove();
                var restart = definition.Elements(W + "lvl").SingleOrDefault(e => Parse((string?)e.Attribute(W + "ilvl")) == level)?.Element(W + "lvlRestart");
                if (restart != null) result.Add(new XElement(restart));
            }
            return result;
        }

        private XElement Level(int id, int level) => TryLevel(id, level) ?? throw new InvalidOperationException("Numbering level missing.");
        private int Start(int id, int level)
        {
            var startOverride = instances[id].Elements(W + "lvlOverride").SingleOrDefault(e => Parse((string?)e.Attribute(W + "ilvl")) == level)?.Element(W + "startOverride");
            return Parse(DocxSourceStyles.Val(startOverride) ?? DocxSourceStyles.Val(Level(id, level).Element(W + "start")) ?? "0");
        }

        private static string Suffix(string value) => value == "tab" ? "\t" : value == "space" ? " " : value == "nothing" ? "" : throw new InvalidOperationException("Unsupported numbering suffix.");
        private static int Parse(string? value) => int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int result) ? result : throw new FormatException("Invalid numbering integer.");

        private static string Format(int value, string? format)
        {
            if (format == "none") return "";
            if (format == "decimal") return value.ToString(CultureInfo.InvariantCulture);
            if (format == "decimalZero") return value.ToString("D2", CultureInfo.InvariantCulture);
            if (format == "upperLetter" || format == "lowerLetter")
            {
                if (value < 1 || value > 780) throw new InvalidOperationException("Letter numbering out of supported range.");
                // Word uses repeating letters: A..Z, AA..ZZ, AAA..ZZZ (not spreadsheet column names).
                var letter = (char)((format == "upperLetter" ? 'A' : 'a') + ((value - 1) % 26));
                return new string(letter, ((value - 1) / 26) + 1);
            }
            if (format == "lowerRoman" || format == "upperRoman")
            {
                if (value < 1 || value > 3999) throw new InvalidOperationException("Roman numbering out of supported range.");
                string result = "";
                int[] values = { 1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1 };
                string[] glyphs = { "M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I" };
                for (int i = 0; i < values.Length; i++) while (value >= values[i]) { result += glyphs[i]; value -= values[i]; }
                return format == "lowerRoman" ? result.ToLowerInvariant() : result;
            }
            throw new InvalidOperationException("Unsupported numbering format.");
        }
    }
}
