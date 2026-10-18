using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    // Internal renderer only. The supported importing handler must own native
    // transaction settlement, source identity, part ownership and post-commit
    // verification. This class exposes no route, authority or completion verdict.
    public sealed class XlsxNativeTableLayout
    {
        public const string RendererVersion = "operator.xlsx_native_table_layout.v1";
        private readonly Document document;
        private readonly ISet<long> created;
        private readonly DrawingSpecNativeTextMetrics metrics;
        private readonly Dictionary<string, DrawingSpecNativeFontProfile> fonts = new Dictionary<string, DrawingSpecNativeFontProfile>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, (DrawingSpecRichParagraph Text, DrawingSpecInlinePlan Lines)> measured = new Dictionary<string, (DrawingSpecRichParagraph, DrawingSpecInlinePlan)>();

        public XlsxNativeTableLayout(Document document, View measurementView, TextNoteType baseType, ISet<long> created)
        {
            this.document = document ?? throw new ArgumentNullException(nameof(document));
            this.created = created ?? throw new ArgumentNullException(nameof(created));
            metrics = new DrawingSpecNativeTextMetrics(document, measurementView, baseType, created, fonts);
        }

        // Excel widths use Normal-font digit advances at96DPI. This source
        // geometry is separate from the actual Revit text probes used for fit.
        public static double MaximumDigitWidth(XlsxOutputSourceManifest source)
        {
            var styles = new XlsxTableStyles(source);
            DrawingSpecNativeFontProfile.Capture(styles.NormalFontFamily); // Reject a substituted font.
            using (var bitmap = new Bitmap(10, 10))
            {
                bitmap.SetResolution(96, 96);
                using (var graphics = Graphics.FromImage(bitmap))
                using (var font = new Font(styles.NormalFontFamily, (float)styles.NormalFontPoints, (styles.NormalFontBold ? FontStyle.Bold : FontStyle.Regular) | (styles.NormalFontItalic ? FontStyle.Italic : 0), GraphicsUnit.Point))
                using (var format = (StringFormat)StringFormat.GenericTypographic.Clone())
                {
                    format.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces;
                    return Math.Round(Enumerable.Range(0, 10).Max(i => (double)graphics.MeasureString(i.ToString(CultureInfo.InvariantCulture), font, new PointF(0, 0), format).Width), 0, MidpointRounding.AwayFromZero);
                }
            }
        }

        public XlsxTableLayoutPlan Plan(XlsxOutputSourceManifest source, XlsxTableLayoutOptions options)
        {
            if (!document.IsModifiable) throw new InvalidOperationException("Native table metrics require the importing handler's owned transaction.");
            return XlsxTableLayout.Plan(source, options, (cell, width) =>
            {
                var layout = Lines(cell, width);
                double extent = layout.Lines.Fragments.Count == 0 ? 0 : layout.Lines.Fragments.GroupBy(f => f.Line)
                    .Max(line => line.Max(f => f.LeftInches + f.WidthInches) - line.Min(f => f.LeftInches));
                return new XlsxTableTextMeasurement { WidthInches = extent, HeightInches = layout.Lines.HeightInches };
            });
        }

        public XlsxNativeTablePart Render(XlsxTableLayoutPlan plan, int pageIndex, View view, double startXInches, double startYInches,
            IReadOnlyDictionary<string, int> solidBorderWeights)
        {
            if (!document.IsModifiable || !document.Equals(view.Document) || view.IsTemplate || view.ViewType != ViewType.DraftingView)
                throw new InvalidOperationException("An owned transaction and exact drafting view are required.");
            if (double.IsNaN(startXInches) || double.IsNaN(startYInches) || double.IsInfinity(startXInches) || double.IsInfinity(startYInches) || Math.Abs(startXInches) > 1000 || Math.Abs(startYInches) > 1000)
                throw new ArgumentException("Finite bounded printed origin is required.");
            var page = plan.Pages.Single(p => p.Index == pageIndex);
            var permittedSourceDiagnostics = new[] { "cell_error", "external_links_not_resolved", "embedded_content_not_executed", "overflow_wrapped_for_readability" };
            if (plan.Issues.Any(i => !permittedSourceDiagnostics.Contains(i.Code)))
                throw new InvalidOperationException("Source/layout has unresolved presentation or value diagnostics. Resolve them before native table rendering; no feature was silently omitted.");
            if (page.Cells.Any(c => c.Style.Background != null || c.Style.Unsupported.Count > 0))
                throw new InvalidOperationException("Table contains unmapped fill/text/style properties; no partial rendering is supported.");
            foreach (var border in page.Borders)
                if (!new[] { "hair", "thin", "medium", "thick" }.Contains(border.Style) || !solidBorderWeights.TryGetValue(border.Style, out var weight) || weight < 1 || weight > 16)
                    throw new InvalidOperationException("Provide explicit native weights for every used solid source border style. Dashed/double borders require their own mapping.");
            var result = new XlsxNativeTablePart { PageIndex = pageIndex, ViewId = ElementIdCompat.GetValue(view.Id), ViewUniqueId = view.UniqueId };
            var expected = new List<(TextNote Note, DrawingSpecRichParagraph Text, DrawingSpecInlineFragment Fragment, XYZ Anchor)>();
            double padding = plan.Options.PaddingPoints / 72;
            int fragmentCount = page.Cells.Where(c => c.Text.Length > 0).Sum(c => Lines(c, c.WidthInches - padding * 2, forceCellWidth: true).Lines.Fragments.Count(f => f.Kind == "text"));
            if (fragmentCount + page.Borders.Count + created.Count > 3500)
                throw new InvalidOperationException("This complete table part exceeds the bounded native settlement inventory. Reduce usable page height to create smaller complete parts; no rows were truncated.");
            foreach (var cell in page.Cells.Where(c => c.Text.Length > 0))
            {
                var layout = Lines(cell, cell.WidthInches - padding * 2, forceCellWidth: true);
                double spareHeight = cell.HeightInches - padding * 2 - layout.Lines.HeightInches;
                if (spareHeight < -.000001) throw new InvalidOperationException("Native text exceeds the planned cell height.");
                spareHeight = Math.Max(0, spareHeight);
                double vertical = cell.Style.Vertical == "top" ? 0 : cell.Style.Vertical == "center" ? spareHeight / 2 : spareHeight;
                foreach (var fragment in layout.Lines.Fragments)
                {
                    double x = startXInches + cell.XInches + padding + fragment.LeftInches;
                    double y = startYInches - cell.YInches - padding - vertical - fragment.TopInches;
                    if (fragment.Kind != "text")
                    {
                        result.LayoutSpans.Add(new XlsxNativeTableWhitespace { Address = cell.Address, Start = fragment.Start, Length = fragment.Length,
                            Kind = fragment.Kind, XInches = x, YInches = y, WidthInches = fragment.WidthInches });
                        continue;
                    }
                    var anchor = Point(view, x, y);
                    var note = metrics.Create(view, anchor, layout.Text, fragment.Start, fragment.Length);
                    result.Notes.Add(new DrawingSpecNativeNoteRecord { Id = ElementIdCompat.GetValue(note.Id), UniqueId = note.UniqueId,
                        ViewId = result.ViewId, SourceId = cell.Address, Start = fragment.Start, Length = fragment.Length,
                        Ranges = layout.Text.Slice(fragment.Start, fragment.Length).Select(s => new[] { s.Start, s.Length }).ToList() });
                    expected.Add((note, layout.Text, fragment, anchor));
                }
            }
            foreach (var edge in page.Borders)
            {
                var curve = document.Create.NewDetailCurve(view, Line.CreateBound(Point(view, startXInches + edge.X1, startYInches - edge.Y1), Point(view, startXInches + edge.X2, startYInches - edge.Y2)));
                created.Add(ElementIdCompat.GetValue(curve.Id));int weight = solidBorderWeights[edge.Style];
                using (var graphics = new OverrideGraphicSettings())
                {
                    graphics.SetProjectionLineWeight(weight);graphics.SetProjectionLineColor(Color(edge.Color));
                    graphics.SetProjectionLinePatternId(LinePatternElement.GetSolidPatternId());view.SetElementOverrides(curve.Id, graphics);
                }
                result.Borders.Add(new XlsxNativeTableBorderRecord { Id = ElementIdCompat.GetValue(curve.Id), UniqueId = curve.UniqueId, Source = edge, NativeWeight = weight });
            }
            document.Regenerate();
            foreach (var check in expected)
            {
                using (var formatted = check.Note.GetFormattedText())
                {
                    var actual = formatted.GetPlainText();var text = check.Text.NativeText.Substring(check.Fragment.Start, check.Fragment.Length);
                    if (actual != text && actual != text + "\r") throw new InvalidOperationException("Created native text differs from the source cell fragment.");
                }
                if (check.Note.Coord.DistanceTo(check.Anchor) > .000001 || Math.Abs(check.Note.Width * 12 - check.Fragment.WidthInches) > .02 || Math.Abs(check.Note.Height * 12 - check.Fragment.HeightInches) > .02)
                    throw new InvalidOperationException("Native cell text differs from measured geometry; roll back instead of retaining overflow.");
            }
            result.NativeMetricProbes = metrics.NativeProbeCount;return result;
        }

        private (DrawingSpecRichParagraph Text, DrawingSpecInlinePlan Lines) Lines(XlsxTableCellFrame cell, double width, bool forceCellWidth = false)
        {
            double flowWidth = cell.WrapText || forceCellWidth ? width : 96;
            var key = JsonSerializer.Serialize(new { cell.Text, cell.SourceRichTextXml, cell.Style, cell.RenderFontPoints, cell.MinimumTextPoints, flowWidth });
            if (measured.TryGetValue(key, out var existing)) return existing;
            var layout = XlsxTableCellFlow.Plan(cell, width, forceCellWidth, (paragraph, offset, count) =>
            {
                foreach (var name in paragraph.Spans.Select(s => s.Style.FontFamily).Append(paragraph.DefaultStyle.FontFamily).Distinct(StringComparer.OrdinalIgnoreCase))
                    if (!fonts.ContainsKey(name)) fonts.Add(name, DrawingSpecNativeFontProfile.Capture(name));
                return metrics.Measure(paragraph, offset, count);
            });
            var result = (layout.Paragraph, layout.Lines);measured.Add(key, result);return result;
        }
        private static XYZ Point(View view, double x, double y) => view.Origin + view.RightDirection * (x / 12 * view.Scale) + view.UpDirection * (y / 12 * view.Scale);
        private static Autodesk.Revit.DB.Color Color(string hex) => new Autodesk.Revit.DB.Color(byte.Parse(hex.Substring(1, 2), NumberStyles.HexNumber), byte.Parse(hex.Substring(3, 2), NumberStyles.HexNumber), byte.Parse(hex.Substring(5, 2), NumberStyles.HexNumber));
    }

    public sealed class XlsxNativeTablePart
    {
        public int PageIndex { get; set; }
        public long ViewId { get; set; }
        public string ViewUniqueId { get; set; } = "";
        public int NativeMetricProbes { get; set; }
        public List<DrawingSpecNativeNoteRecord> Notes { get; } = new List<DrawingSpecNativeNoteRecord>();
        public List<XlsxNativeTableWhitespace> LayoutSpans { get; } = new List<XlsxNativeTableWhitespace>();
        public List<XlsxNativeTableBorderRecord> Borders { get; } = new List<XlsxNativeTableBorderRecord>();
    }
    public sealed class XlsxNativeTableWhitespace
    {
        public string Address { get; set; } = "";
        public int Start { get; set; }
        public int Length { get; set; }
        public string Kind { get; set; } = "";
        public double XInches { get; set; }
        public double YInches { get; set; }
        public double WidthInches { get; set; }
    }
    public sealed class XlsxNativeTableBorderRecord
    {
        public long Id { get; set; }
        public string UniqueId { get; set; } = "";
        public XlsxTableBorderSegment Source { get; set; } = new XlsxTableBorderSegment();
        public int NativeWeight { get; set; }
    }
}
