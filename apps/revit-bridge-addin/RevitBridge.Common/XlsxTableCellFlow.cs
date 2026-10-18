using System;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class XlsxTableCellFlowResult
    {
        public DrawingSpecRichParagraph Paragraph { get; set; } = null!;
        public DrawingSpecInlinePlan Lines { get; set; } = null!;
        public double MeasuredWidthInches { get; set; }
    }
    public static class XlsxTableCellFlow
    {
        // For source cells without wrapping, first measure an unwrapped line.
        // If it overflows, the table planner can request an explicit wrapped
        // layout. Rendering always aligns within the actual cell width.
        public static XlsxTableCellFlowResult Plan(XlsxTableCellFrame cell, double widthInches, bool forRendering,
            Func<DrawingSpecRichParagraph, int, int, DrawingSpecTextMeasurement> measure)
        {
            if (measure == null || double.IsNaN(widthInches) || double.IsInfinity(widthInches) || widthInches <= 0 || widthInches > 96)
                throw new ArgumentException("A bounded cell width and actual text measurement callback are required.");
            var paragraph = XlsxTableText.Paragraph(cell);
            var lines = DrawingSpecInlineFlow.Plan(paragraph, 0, paragraph.NativeText.Length,
                cell.WrapText || forRendering ? widthInches : 96, (offset, count) => measure(paragraph, offset, count));
            double extent = lines.Fragments.Count == 0 ? 0 : lines.Fragments.GroupBy(f => f.Line)
                .Max(line => line.Max(f => f.LeftInches + f.WidthInches) - line.Min(f => f.LeftInches));
            if (forRendering && extent > widthInches + .000001) throw new InvalidOperationException("Rendered text exceeds cell width.");
            return new XlsxTableCellFlowResult { Paragraph = paragraph, Lines = lines, MeasuredWidthInches = extent };
        }
    }
}
