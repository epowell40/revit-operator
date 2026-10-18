using System;
using System.Globalization;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class DrawingSpecColumnFlowTests
    {
        // Synthetic metrics deliberately do not stand in for actual Revit font/layout measurements.
        private static double Lines(DrawingSpecFlowItem item, int start, int length, double width) =>
            Math.Max(1, Math.Ceiling(length / (width * 10))) * .2;
        private static DrawingSpecFlowItem Item(string id, int length) => new DrawingSpecFlowItem { SourceId = id, Text = new string('x', length) };
        private static DrawingSpecFlowGeometry G(int columns = 2, double height = 1) => new DrawingSpecFlowGeometry { Columns = columns, ColumnWidthInches = 1, ColumnHeightInches = height, GutterInches = .25 };

        [Fact]
        public void OverflowAllocatesMoreColumnsAndPagesWithoutOmittingAnyText()
        {
            var items = Enumerable.Range(0, 9).Select(i => Item("p" + i, 40)).ToArray();
            var plan = DrawingSpecColumnFlow.Plan(items, G(), Lines);
            Assert.Equal(9, plan.Count);
            Assert.Equal(new[] { 0, 0, 1, 1, 2, 2, 3, 3, 4 }, plan.Select(p => p.Page));
            Assert.Equal(new[] { 0, 1, 0, 1, 0, 1, 0, 1, 0 }, plan.Select(p => p.Column));
            Assert.All(plan.Where(p => p.Column == 1), p => Assert.Equal(1.25, p.LeftInches));
            AssertCoverage(items, plan);
        }

        [Fact]
        public void OversizedParagraphSplitsAcrossPagesAndRespectsNativeCharacterLimit()
        {
            var items = new[] { Item("large", 90000) };
            var geometry = G(1, 192);
            geometry.ColumnWidthInches = 96;
            var plan = DrawingSpecColumnFlow.Plan(items, geometry, Lines);
            Assert.True(plan.Count >= 4);
            Assert.All(plan, p => Assert.InRange(p.Length, 1, 29999));
            AssertCoverage(items, plan);
        }

        [Fact]
        public void HeadingChainMovesWithFollowingContentInsteadOfOrphaningTheTitle()
        {
            var prior = Item("prior", 30);
            var heading = Item("heading", 10); heading.KeepWithNext = true;
            var subheading = Item("subheading", 10); subheading.KeepWithNext = true;
            var body = Item("body", 30);
            var plan = DrawingSpecColumnFlow.Plan(new[] { prior, heading, subheading, body }, G(), Lines);
            Assert.Equal(1, plan[1].Column);
            Assert.Equal(1, plan[2].Column);
            Assert.Equal(1, plan[3].Column);
        }

        [Fact]
        public void HeadingPinsAtLeastSomeOfAnOversizedFollowingParagraphInTheSameColumn()
        {
            var prior = Item("prior", 20);
            var heading = Item("heading", 10); heading.KeepWithNext = true;
            var body = Item("body", 50);
            var items = new[] { prior, heading, body };
            var plan = DrawingSpecColumnFlow.Plan(items, G(), Lines);
            Assert.Equal(plan[1].Column, plan[2].Column);
            Assert.Equal(plan[1].Page, plan[2].Page);
            Assert.True(plan[2].Length > 0);
            AssertCoverage(items, plan);
        }

        [Fact]
        public void PageAndColumnBreaksAndSpacingHavePrintedCoordinates()
        {
            var first = Item("one", 10);
            var second = Item("two", 10); second.BreakBefore = DrawingSpecFlowBreak.Column; second.SpaceBeforeInches = .1; second.SpaceAfterInches = .1;
            var third = Item("three", 10); third.BreakBefore = DrawingSpecFlowBreak.Page;
            var plan = DrawingSpecColumnFlow.Plan(new[] { first, second, third }, G(), Lines);
            Assert.Equal(1, plan[1].Column);
            Assert.Equal(.1, plan[1].TopInches);
            Assert.Equal(1, plan[2].Page);
            Assert.Equal(0, plan[2].Column);
        }

        [Fact]
        public void EmptyParagraphsStillConsumeTheirMeasuredLineAndSpacing()
        {
            var empty = Item("empty", 0); empty.SpaceBeforeInches = .1; empty.SpaceAfterInches = .2;
            var items = new[] { empty, Item("text", 10) };
            var plan = DrawingSpecColumnFlow.Plan(items, G(), Lines);
            Assert.Equal(0, plan[0].Length);
            Assert.Equal(.5, plan[1].TopInches, 8);
            AssertCoverage(items, plan);
        }

        [Fact]
        public void SurrogatePairsAndCombiningSequencesAreNotSplitBetweenTextNotes()
        {
            var text = string.Concat(Enumerable.Repeat("\ud83d\ude00a\u0301 ", 24));
            var item = new DrawingSpecFlowItem { SourceId = "unicode", Text = text };
            var plan = DrawingSpecColumnFlow.Plan(new[] { item }, G(1, .4), Lines);
            var boundaries = StringInfo.ParseCombiningCharacters(text).Concat(new[] { text.Length }).ToHashSet();
            Assert.All(plan, p => { Assert.Contains(p.Start, boundaries); Assert.Contains(p.Start + p.Length, boundaries); });
            AssertCoverage(new[] { item }, plan);
        }

        [Fact]
        public void NoPageBudgetOrImpossibleTextSizeReturnsAPartialSuccessPlan()
        {
            var geometry = G(1); geometry.MaximumPages = 1;
            Assert.Throws<InvalidOperationException>(() => DrawingSpecColumnFlow.Plan(new[] { Item("one", 100) }, geometry, Lines));
            Assert.Throws<InvalidOperationException>(() => DrawingSpecColumnFlow.Plan(new[] { Item("one", 1) }, G(), (_, __, ___, ____) => 2));
            Assert.Throws<InvalidOperationException>(() => DrawingSpecColumnFlow.Plan(new[] { Item("one", 1) }, G(), (_, __, ___, ____) => double.NaN));
        }

        [Fact]
        public void DuplicateSourceIdsAndUnsplitHardBreaksAreRejected()
        {
            Assert.Throws<ArgumentException>(() => DrawingSpecColumnFlow.Plan(new[] { Item("same", 2), Item("same", 3) }, G(), Lines));
            Assert.Throws<ArgumentException>(() => DrawingSpecColumnFlow.Plan(new[] { new DrawingSpecFlowItem { SourceId = "break", Text = "a\fb" } }, G(), Lines));
        }

        [Fact]
        public void MixedParagraphLengthsRetainEveryCharacterAndStayInsideTheAllocatedColumns()
        {
            var random = new Random(4197);
            for (int trial = 0; trial < 10; trial++)
            {
                var items = Enumerable.Range(0, 40).Select(i => new DrawingSpecFlowItem { SourceId = "p" + i,
                    Text = new string(Enumerable.Range(0, random.Next(0, 220)).Select(c => c % 7 == 0 ? ' ' : 'x').ToArray()),
                    SpaceBeforeInches = i % 5 == 0 ? .1 : 0, SpaceAfterInches = i % 3 == 0 ? .05 : 0 }).ToArray();
                var plan = DrawingSpecColumnFlow.Plan(items, G(3, 2), Lines);
                AssertCoverage(items, plan);
                Assert.All(plan, p => { Assert.True(p.TopInches >= 0); Assert.True(p.TopInches + p.HeightInches <= 2.000001); });
                foreach (var group in plan.GroupBy(p => (p.Page, p.Column)))
                {
                    var rows = group.ToArray();
                    for (int i = 1; i < rows.Length; i++) Assert.True(rows[i].TopInches + .000001 >= rows[i - 1].TopInches + rows[i - 1].HeightInches);
                }
            }
        }

        [Fact]
        public void EveryMeasurementRespectsTheNativeCharacterCapEvenForOversizedHeadingGroups()
        {
            var heading = Item("heading", 10); heading.KeepWithNext = true;
            var longHeading = Item("long-heading", 40000); longHeading.KeepWithNext = true;
            Assert.Throws<InvalidOperationException>(() => DrawingSpecColumnFlow.Plan(new[] { heading, longHeading, Item("body", 10) }, G(),
                (item, start, length, width) => { Assert.InRange(length, 0, 29999); return Lines(item, start, length, width); }));
            var cluster = new DrawingSpecFlowItem { SourceId = "cluster", Text = "a" + new string('\u0301', 30000) };
            Assert.Throws<InvalidOperationException>(() => DrawingSpecColumnFlow.Plan(new[] { cluster }, G(), Lines));
        }

        private static void AssertCoverage(DrawingSpecFlowItem[] source, System.Collections.Generic.IReadOnlyList<DrawingSpecFlowPlacement> plan)
        {
            foreach (var item in source)
            {
                var placements = plan.Where(p => p.SourceId == item.SourceId).ToArray();
                Assert.NotEmpty(placements);
                Assert.Equal(0, placements[0].Start);
                for (int i = 1; i < placements.Length; i++) Assert.Equal(placements[i - 1].Start + placements[i - 1].Length, placements[i].Start);
                Assert.Equal(item.Text.Length, placements.Sum(p => p.Length));
                Assert.Equal(item.Text, string.Concat(placements.Select(p => item.Text.Substring(p.Start, p.Length))));
            }
        }
    }
}
