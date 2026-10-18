using System;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class XlsxTableCellFlowTests
    {
        private static XlsxTableCellFrame Cell(string text, string alignment = "left") => new XlsxTableCellFrame
        { Text = text, SourceDataType = "s", Address = "A1", RenderFontPoints = 10, MinimumTextPoints = 6.75,
            Style = new XlsxTableCellStyle { FontFamily = "Arial", FontPoints = 10, Horizontal = alignment } };
        private static DrawingSpecTextMeasurement Measure(DrawingSpecRichParagraph text, int start, int length) => new DrawingSpecTextMeasurement
        { WidthInches = length * .1, HeightInches = .2 }; // Deterministic test double, not a native metric or visual verdict.
        [Theory]
        [InlineData("left", 0)]
        [InlineData("center", .3)]
        [InlineData("right", .6)]
        public void UnwrappedIntrinsicWidthDoesNotIncludeLargeAlignmentOffsetsAndRenderingUsesCellWidth(string alignment, double expectedLeft)
        {
            var cell = Cell("TEST", alignment);
            var measure = XlsxTableCellFlow.Plan(cell, 1, false, Measure);
            Assert.Equal(.4, measure.MeasuredWidthInches, 6);
            var render = XlsxTableCellFlow.Plan(cell, 1, true, Measure);
            Assert.Equal(expectedLeft, render.Lines.Fragments.First().LeftInches, 6);
            Assert.All(render.Lines.Fragments, f => Assert.InRange(f.LeftInches + f.WidthInches, 0, 1.000001));
        }
        [Fact]
        public void OverflowIsReportedBeforeExplicitWrapAndRichTextBoundariesReachMeasurement()
        {
            var cell = Cell("ONE TWO THREE");var first = XlsxTableCellFlow.Plan(cell, .6, false, Measure);
            Assert.True(first.MeasuredWidthInches > .6);cell.WrapText = true;
            var wrapped = XlsxTableCellFlow.Plan(cell, .6, false, Measure);
            Assert.True(wrapped.Lines.HeightInches > first.Lines.HeightInches);
            Assert.True(wrapped.MeasuredWidthInches <= .600001);
            Assert.Equal(cell.Text.Length, wrapped.Lines.Fragments.Sum(f => f.Length));
            cell.Text = "ft2";cell.SourceRichTextXml = "<si xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><r><t>ft</t></r><r><rPr><vertAlign val='superscript'/></rPr><t>2</t></r></si>";
            bool sawRich = false;
            XlsxTableCellFlow.Plan(cell, 1, true, (paragraph, start, length) =>
            { sawRich |= paragraph.Spans.Any(s => s.Style.VerticalAlignment == "superscript");return Measure(paragraph, start, length); });
            Assert.True(sawRich);
            Assert.Throws<ArgumentException>(() => XlsxTableCellFlow.Plan(cell, double.NaN, true, Measure));
        }
    }
}
