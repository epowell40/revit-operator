using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Linq;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    // Word sizes an em square; Revit TextNoteType sizes the capital M outline.
    // Capture actual installed outlines once per import, before any mutation. No substitute font.
    public sealed class DrawingSpecNativeFontProfile
    {
        public string FontFamily { get; }
        public double CapitalMHeightEm { get; }
        public string Signature => FontFamily.ToUpperInvariant() + "|" + CapitalMHeightEm.ToString("R", CultureInfo.InvariantCulture);

        public DrawingSpecNativeFontProfile(string fontFamily, double capitalMHeightEm)
        {
            if (string.IsNullOrWhiteSpace(fontFamily) || !Finite(capitalMHeightEm) || capitalMHeightEm <= 0 || capitalMHeightEm > 2)
                throw new ArgumentException("An installed font and finite positive capital-M/em ratio are required.");
            FontFamily = fontFamily;
            CapitalMHeightEm = capitalMHeightEm;
        }

        public double NativeSizeFeet(double sourcePoints)
        {
            if (!Finite(sourcePoints) || sourcePoints <= 0) throw new ArgumentException("Source em size must be finite and positive.");
            return sourcePoints * CapitalMHeightEm / 864;
        }

        public double SourcePoints(double nativeSizeFeet)
        {
            if (!Finite(nativeSizeFeet) || nativeSizeFeet <= 0) throw new ArgumentException("Native cap height must be finite and positive.");
            return nativeSizeFeet * 864 / CapitalMHeightEm;
        }

        public static DrawingSpecNativeFontProfile Capture(string name)
        {
            using (var family = new FontFamily(name))
            {
                if (!string.Equals(family.Name, name, StringComparison.OrdinalIgnoreCase) || !family.IsStyleAvailable(FontStyle.Regular))
                    throw new InvalidOperationException("Source font has no matching installed regular outline: " + name);
                using (var outline = new GraphicsPath())
                {
                    const float em = 2048;
                    outline.AddString("M", family, (int)FontStyle.Regular, em, PointF.Empty, StringFormat.GenericTypographic);
                    return new DrawingSpecNativeFontProfile(name, outline.GetBounds().Height / em);
                }
            }
        }

        public static IReadOnlyDictionary<string, DrawingSpecNativeFontProfile> CaptureAll(IEnumerable<DrawingSpecRichParagraph> paragraphs)
        {
            var profiles = new SortedDictionary<string, DrawingSpecNativeFontProfile>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in paragraphs.SelectMany(p => p.Spans.Select(s => s.Style.FontFamily).Append(p.DefaultStyle.FontFamily)).Distinct(StringComparer.OrdinalIgnoreCase))
                profiles.Add(name, Capture(name));
            return profiles;
        }

        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    }
}
