using System;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class DrawingSpecRichParagraphTests
    {
        private const string W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        private static string Properties(string content) => "<w:rPr xmlns:w='" + W + "'>" + content + "</w:rPr>";
        private static DrawingSpecBlock Block() => new DrawingSpecBlock { Kind = "paragraph", SourcePath = "body/1", PropertiesXml = "<w:pPr xmlns:w='" + W + "'><w:ind w:left='720' w:hanging='360'/><w:spacing w:before='120' w:after='60'/><w:keepNext/><w:tabs><w:tab w:val='left' w:pos='720'/></w:tabs></w:pPr>" };

        [Fact]
        public void PrefixAndRunOffsetsRemainExactAfterSoftLineBreakConversion()
        {
            var block = Block(); block.NumberingMarker = "1.01"; block.NumberingSuffix = "\t"; block.Text = "Alpha\nBeta";
            block.Runs.Add(new DrawingSpecRun { Text = "Alpha\n", PropertiesXml = Properties("<w:b/><w:u w:val='single'/>") });
            block.Runs.Add(new DrawingSpecRun { Text = "Beta", PropertiesXml = Properties("<w:i/><w:vertAlign w:val='superscript'/>") });
            var plan = DrawingSpecRichParagraph.Build(block, "Arial", 10);
            Assert.Equal("1.01\tAlpha\nBeta", plan.SourceText);
            Assert.Equal("1.01\tAlpha\vBeta", plan.NativeText);
            Assert.Equal(new[] { 0, 5, 11 }, plan.Spans.Select(s => s.Start));
            Assert.Equal(new[] { 5, 6, 4 }, plan.Spans.Select(s => s.Length));
            Assert.True(plan.Spans[1].Style.Bold);
            Assert.True(plan.Spans[1].Style.Underline);
            Assert.True(plan.Spans[2].Style.Italic);
            Assert.Equal("superscript", plan.Spans[2].Style.VerticalAlignment);
            Assert.Equal(.5, plan.LeftIndentInches);
            Assert.Equal(.25, plan.HangingIndentInches);
            Assert.Equal(1d / 12, plan.BeforeInches, 8);
            Assert.Equal(1d / 24, plan.AfterInches, 8);
            Assert.True(plan.KeepWithNext);
            Assert.Equal(.5, plan.Tabs.Single().PositionInches);
        }

        [Fact]
        public void MixedFontAndPointSizesArePreservedRatherThanSilentlyFlattened()
        {
            var block = Block(); block.Text = "75\u00b0F";
            block.Runs.Add(new DrawingSpecRun { Text = "75", PropertiesXml = Properties("<w:rFonts w:ascii='Times New Roman'/><w:sz w:val='24'/>") });
            block.Runs.Add(new DrawingSpecRun { Text = "\u00b0", PropertiesXml = Properties("<w:rFonts w:ascii='Arial'/><w:sz w:val='24'/>") });
            block.Runs.Add(new DrawingSpecRun { Text = "F", PropertiesXml = Properties("<w:rFonts w:ascii='Times New Roman'/><w:sz w:val='20'/>") });
            var plan = DrawingSpecRichParagraph.Build(block, "Fallback", 9);
            Assert.True(plan.RequiresInlineTextFragments);
            Assert.Equal(new[] { "Times New Roman", "Arial", "Times New Roman" }, plan.Spans.Select(s => s.Style.FontFamily));
            Assert.Equal(new[] { 12d, 12d, 10d }, plan.Spans.Select(s => s.Style.PointSize));
            var slice = plan.Slice(1, 2);
            Assert.Equal(new[] { 0, 1 }, slice.Select(s => s.Start));
            Assert.Equal(new[] { 1, 1 }, slice.Select(s => s.Length));
            Assert.Equal("Arial", slice[1].Style.FontFamily);
        }

        [Fact]
        public void SourceFormattingLimitationsRemainVisibleAndCoverageMustBeComplete()
        {
            var block = Block(); block.Text = "x";
            block.Runs.Add(new DrawingSpecRun { Text = "x", PropertiesXml = Properties("<w:rFonts w:asciiTheme='minorHAnsi'/><w:u w:val='double'/><w:smallCaps/>") });
            var plan = DrawingSpecRichParagraph.Build(block, "Actual Native Font", 9);
            Assert.Contains("font_theme_requires_resolution", plan.Warnings);
            Assert.Contains("underline_pattern_requires_native_mapping:double", plan.Warnings);
            Assert.Contains("character_property_requires_native_mapping:smallCaps", plan.Warnings);
            Assert.Throws<ArgumentOutOfRangeException>(() => plan.Slice(-1, 1));
            block.Text = "omitted text";
            Assert.Throws<InvalidOperationException>(() => DrawingSpecRichParagraph.Build(block, "Actual Native Font", 9));
        }
    }
}
