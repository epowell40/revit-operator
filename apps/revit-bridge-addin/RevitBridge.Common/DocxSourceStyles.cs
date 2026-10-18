using System;
using System.Collections.Generic;
using System.Linq;
using System.Xml.Linq;

namespace RevitBridge.Common
{
    internal sealed class DocxSourceStyles
    {
        internal static readonly XNamespace W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        private readonly Dictionary<string, XElement> styles;
        private readonly XElement defaults;
        private readonly string? defaultParagraph;

        internal DocxSourceStyles(XDocument? document)
        {
            styles = (document?.Root?.Elements(W + "style") ?? Enumerable.Empty<XElement>())
                .ToDictionary(e => (string?)e.Attribute(W + "styleId") ?? throw new InvalidOperationException("Style identity missing."), StringComparer.Ordinal);
            defaults = document?.Root?.Element(W + "docDefaults") ?? new XElement(W + "docDefaults");
            defaultParagraph = styles.Values.Where(s => (string?)s.Attribute(W + "type") == "paragraph" &&
                s.Attribute(W + "default") != null && IsOn((string?)s.Attribute(W + "default")))
                .Select(s => (string?)s.Attribute(W + "styleId")).SingleOrDefault();
        }

        internal XElement Paragraph(XElement paragraph)
        {
            var properties = new XElement(W + "pPr");
            Merge(properties, defaults.Element(W + "pPrDefault")?.Element(W + "pPr"));
            foreach (var style in Chain(Val(paragraph.Element(W + "pPr")?.Element(W + "pStyle")) ?? defaultParagraph))
                Merge(properties, style.Element(W + "pPr"));
            Merge(properties, paragraph.Element(W + "pPr"));
            return properties;
        }

        internal XElement Run(XElement paragraph, XElement run)
        {
            var properties = new XElement(W + "rPr");
            Merge(properties, defaults.Element(W + "rPrDefault")?.Element(W + "rPr"));
            var paragraphStyle = Val(paragraph.Element(W + "pPr")?.Element(W + "pStyle")) ?? defaultParagraph;
            // OOXML style toggles (b/i/etc.) toggle within the style hierarchy, while direct formatting sets an absolute value.
            foreach (var style in Chain(paragraphStyle)) MergeRunStyle(properties, style.Element(W + "rPr"));
            foreach (var style in Chain(Val(run.Element(W + "rPr")?.Element(W + "rStyle")))) MergeRunStyle(properties, style.Element(W + "rPr"));
            var direct = run.Element(W + "rPr");
            if (direct != null)
            {
                var absolute = new XElement(direct);
                foreach (var toggle in absolute.Elements().Where(e => ToggleNames.Contains(e.Name.LocalName)))
                    toggle.SetAttributeValue(W + "val", IsOn(Val(toggle)) ? "1" : "0");
                Merge(properties, absolute);
            }
            return properties;
        }

        private IEnumerable<XElement> Chain(string? id)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var chain = new List<XElement>();
            while (!string.IsNullOrEmpty(id))
            {
                if (!seen.Add(id!) || chain.Count >= 64) throw new InvalidOperationException("Cyclic or excessive DOCX style inheritance.");
                if (!styles.TryGetValue(id!, out var style)) throw new InvalidOperationException("Unresolved DOCX style: " + id);
                chain.Add(style);
                id = Val(style.Element(W + "basedOn"));
            }
            chain.Reverse();
            return chain;
        }

        private static readonly HashSet<string> ToggleNames = new HashSet<string> { "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "vanish" };

        private static void MergeRunStyle(XElement target, XElement? source)
        {
            if (source == null) return;
            foreach (var property in source.Elements())
            {
                if (ToggleNames.Contains(property.Name.LocalName))
                {
                    if (!IsOn(Val(property))) continue;
                    var prior = target.Element(property.Name);
                    var next = ! (prior != null && IsOn(Val(prior)));
                    prior?.Remove();
                    target.Add(new XElement(property.Name, new XAttribute(W + "val", next ? "1" : "0")));
                }
                else Merge(target, new XElement(W + "rPr", property));
            }
        }

        // Attribute-level inheritance matters for numPr, ind, spacing and rFonts.
        private static void Merge(XElement target, XElement? source)
        {
            if (source == null) return;
            foreach (var attribute in source.Attributes()) target.SetAttributeValue(attribute.Name, attribute.Value);
            foreach (var child in source.Elements())
            {
                var old = target.Element(child.Name);
                if (old == null) target.Add(new XElement(child));
                else if (child.Name == W + "tabs") old.ReplaceWith(new XElement(child));
                else Merge(old, child);
            }
        }

        internal static string? Val(XElement? element) => (string?)element?.Attribute(W + "val");
        private static bool IsOn(string? value) => value == null || value == "1" || value == "true" || value == "on";
    }
}
