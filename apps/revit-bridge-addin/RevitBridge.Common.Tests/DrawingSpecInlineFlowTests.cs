using System;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class DrawingSpecInlineFlowTests
    {
        private const string W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        private static DrawingSpecRichParagraph P(string text, string paragraphProperties = "", string font = "Arial")
        {
            var block = new DrawingSpecBlock { SourcePath = "body/1", Kind = "paragraph", Text = text,
                PropertiesXml = "<w:pPr xmlns:w='" + W + "'>" + paragraphProperties + "</w:pPr>" };
            block.Runs.Add(new DrawingSpecRun { Text = text, PropertiesXml = "<w:rPr xmlns:w='" + W + "'><w:rFonts w:ascii='" + font + "'/><w:sz w:val='24'/></w:rPr>" });
            return DrawingSpecRichParagraph.Build(block, "Arial", 12);
        }
        private static DrawingSpecTextMeasurement M(int start, int length) => new DrawingSpecTextMeasurement { WidthInches = length * .1, HeightInches = .2 };
        private static DrawingSpecInlinePlan Flow(DrawingSpecRichParagraph p, double width) => DrawingSpecInlineFlow.Plan(p, 0, p.NativeText.Length, width, M);
        private static void Coverage(DrawingSpecRichParagraph p, DrawingSpecInlinePlan plan)
        {
            Assert.Equal(p.NativeText.Length, plan.Fragments.Sum(f => f.Length));
            Assert.Equal(p.NativeText, string.Concat(plan.Fragments.Select(f => p.NativeText.Substring(f.Start, f.Length))));
        }

        [Fact]
        public void WrapsAtWordBoundariesWithoutLosingSpacesOrSourceOffsets()
        {
            var p = P("one two three four");
            var plan = Flow(p, .8);
            Coverage(p, plan);
            Assert.True(plan.Fragments.Select(f => f.Line).Distinct().Count() > 1);
            Assert.All(plan.Fragments, f => Assert.True(f.LeftInches + f.WidthInches <= .800001));
        }

        [Fact]
        public void MixedFontWordFragmentsStayOnTheSameLineAndKeepExactCharacterRanges()
        {
            var p = P("75\u00b0F");
            var original = p.Spans.Single();
            p.Spans.Clear();
            p.Spans.Add(new DrawingSpecCharacterSpan { Start = 0, Length = 2, Style = original.Style });
            p.Spans.Add(new DrawingSpecCharacterSpan { Start = 2, Length = 1, Style = new DrawingSpecCharacterStyle { FontFamily = "Times New Roman", PointSize = 12 } });
            p.Spans.Add(new DrawingSpecCharacterSpan { Start = 3, Length = 1, Style = original.Style });
            var plan = Flow(p, 1);
            Coverage(p, plan);
            Assert.Equal(3, plan.Fragments.Count);
            Assert.All(plan.Fragments, f => Assert.Equal(0, f.Line));
            Assert.Equal(new[] { 0d, .2, .3 }, plan.Fragments.Select(f => Math.Round(f.LeftInches, 8)));
        }

        [Fact]
        public void HangingIndentCreatesAnImplicitTabAndContinuationLinesStayIndented()
        {
            var p = P("A.\tlong body words repeat words", "<w:ind w:left='720' w:hanging='360'/>");
            var plan = Flow(p, 1.6);
            var tab = plan.Fragments.Single(f => f.Kind == "tab");
            Assert.Equal(.5, tab.LeftInches + tab.WidthInches, 8);
            Assert.All(plan.Fragments.Where(f => f.Line > 0), f => Assert.True(f.LeftInches >= .5));
            Coverage(p, plan);
        }

        [Theory]
        [InlineData("center", .8)]
        [InlineData("right", .6)]
        [InlineData("decimal", .9)]
        public void AlignedTabsUseFollowingContentInsteadOfBecomingLeftTabs(string alignment, double expectedLeft)
        {
            var p = P("\t1.23", "<w:tabs><w:tab w:val='" + alignment + "' w:pos='1440'/></w:tabs>");
            var plan = Flow(p, 2);
            Assert.Equal(expectedLeft, plan.Fragments.Single(f => f.Kind == "text").LeftInches, 8);
            Coverage(p, plan);
        }

        [Fact]
        public void JustificationExpandsExplicitWhitespaceGapsWithoutChangingTextOrLastLine()
        {
            var p = P("a b c d e f", "<w:jc w:val='both'/>");
            var plan = Flow(p, .75);
            Coverage(p, plan);
            var first = plan.Fragments.Where(f => f.Line == 0).ToArray();
            Assert.Equal(.75, first.Max(f => f.LeftInches + f.WidthInches), 8);
            Assert.Contains(first, f => f.Kind == "space" && f.WidthInches > .1);
        }

        [Fact]
        public void SoftBreaksAndMinimumLineSpacingReserveTheActualFollowingLine()
        {
            var p = P("a\nb\n", "<w:spacing w:line='720' w:lineRule='atLeast'/>");
            var plan = Flow(p, 1);
            Coverage(p, plan);
            Assert.Equal(2, plan.Fragments.Count(f => f.Kind == "soft_break"));
            Assert.Equal(.5, plan.Fragments.First(f => f.Start == 2).TopInches, 8);
            Assert.Equal(1.2, plan.HeightInches, 8);
        }

        [Fact]
        public void BadMeasurementsOrImpossibleSourceFontDoNotProduceAPartialLayout()
        {
            var p = P("word");
            Assert.Throws<InvalidOperationException>(() => DrawingSpecInlineFlow.Plan(p, 0, 4, 1, (_, __) => new DrawingSpecTextMeasurement { WidthInches = double.NaN, HeightInches = .2 }));
            Assert.Throws<InvalidOperationException>(() => DrawingSpecInlineFlow.Plan(p, 0, 4, .05, M));
        }
    }
}
