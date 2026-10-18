using System;
using System.Globalization;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class XlsxTableLayoutTests
    {
        private const string S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
        private static XlsxOutputSourceManifest Source(int rows = 8, int columns = 3)
        {
            var result = new XlsxOutputSourceManifest { SourceSha256 = new string('a', 64), SelectedSheet = new XlsxSourceSheet {
                Identity = new XlsxSourceSheetIdentity { Name = "Ventilation Schedule", Index = 4 }, DefaultRowHeightPoints = 14,
                Bounds = new XlsxSourceRange { FirstRow = 1, LastRow = rows, FirstColumn = 1, LastColumn = columns } } };
            result.FormattingParts.Add("xl/styles.xml", "<styleSheet xmlns='" + S + "'><numFmts><numFmt numFmtId='164' formatCode='0.0%'/></numFmts>" +
                "<fonts><font><name val='Arial'/><sz val='10'/></font><font><name val='Arial'/><sz val='18'/><b/></font></fonts>" +
                "<fills><fill><patternFill patternType='none'/></fill></fills><borders><border><left style='medium'/><right style='medium'/><top style='medium'/><bottom style='medium'/></border></borders>" +
                "<cellStyleXfs><xf fontId='0' fillId='0' borderId='0' numFmtId='0'/></cellStyleXfs>" +
                "<cellXfs><xf fontId='0' fillId='0' borderId='0' numFmtId='0'/><xf fontId='1' fillId='0' borderId='0' numFmtId='0'><alignment horizontal='center' wrapText='1'/></xf>" +
                "<xf fontId='0' fillId='0' borderId='0' numFmtId='164'><alignment horizontal='right'/></xf></cellXfs></styleSheet>");
            for (int c = 1; c <= columns; c++) result.SelectedSheet.Columns.Add(new XlsxSourceColumn { First = c, Last = c, WidthCharacters = 12.42578125 });
            for (int r = 1; r <= rows; r++) for (int c = 1; c <= columns; c++)
                result.SelectedSheet.Cells.Add(new XlsxSourceCell { Row = r, Column = c, Address = ((char)('A' + c - 1)).ToString() + r, DataType = "str", Text = "Cell " + r });
            return result;
        }
        private static XlsxTableLayoutOptions Options(double width = 10, double height = 5) => new XlsxTableLayoutOptions { MaximumDigitWidthPixels = 7, PageWidthInches = width, PageHeightInches = height };
        // A deterministic measuring double for pagination contracts. This is
        // not a substitute for native TextNote metrics or installed UI proof.
        private static XlsxTableTextMeasurement Measure(XlsxTableCellFrame cell, double width)
        {
            double unwrapped = cell.Text.Length * cell.RenderFontPoints / 144;
            return new XlsxTableTextMeasurement { WidthInches = cell.WrapText ? Math.Min(width, unwrapped) : unwrapped,
                HeightInches = cell.RenderFontPoints / 60 * (cell.WrapText ? Math.Max(1, Math.Ceiling(unwrapped / width)) : 1) };
        }
        [Fact]
        public void MoreThanTwoHundredRowsRemainCoveredOnceWithExplicitHeaderContinuations()
        {
            var source = Source(270);source.SelectedSheet!.Cells.First().Text = "Ventilation Schedule";
            source.SelectedSheet.Cells.First().StyleIndex = 1;
            source.SelectedSheet.Cells.RemoveAll(c => c.Row == 1 && c.Column > 1);
            source.SelectedSheet.Merges.Add(new XlsxSourceRange { FirstRow = 1, LastRow = 1, FirstColumn = 1, LastColumn = 3 });
            var options = Options();options.RepeatHeaderRows = 1;
            var plan = XlsxTableLayout.Plan(source, options, Measure);
            Assert.True(plan.Pages.Count > 2);Assert.Equal(270, plan.Pages.SelectMany(p => p.PrimaryRows).Distinct().Count());
            Assert.Equal(source.SelectedSheet.Cells.Count, plan.Coverage.Count);
            Assert.All(plan.Coverage, c => { Assert.Equal("selected_visible", c.State);Assert.NotNull(c.PrimaryPage); });
            Assert.All(plan.Pages.Skip(1), p => Assert.Contains(p.Cells, c => c.Address == "A1" && c.RepeatedHeader));
            Assert.Equal(270 * 3 - 2, plan.Pages.SelectMany(p => p.Cells).Count(c => !c.RepeatedHeader));
            Assert.All(plan.Pages, p => Assert.True(p.WidthInches <= options.PageWidthInches && p.HeightInches <= options.PageHeightInches + 1e-9));
            Assert.Equal(new string('a', 64), plan.SourceSha256);Assert.Equal("Ventilation Schedule", plan.Worksheet);
            Assert.False(plan.CalculationPerformed);Assert.False(plan.NativeImportVerified);
            Assert.True(plan.MeasurementRequests < source.SelectedSheet.Cells.Count);
        }
        [Fact]
        public void PageBreaksCannotCutMergesAndNeverShrinkToFitAnOversizedGroup()
        {
            var source = Source(8);source.SelectedSheet!.Merges.Add(new XlsxSourceRange { FirstRow = 3, LastRow = 5, FirstColumn = 1, LastColumn = 1 });
            var plan = XlsxTableLayout.Plan(source, Options(height: .9), Measure);
            var page = plan.Pages.Single(p => p.PrimaryRows.Contains(3));Assert.Contains(5, page.PrimaryRows);
            Assert.Throws<InvalidOperationException>(() => XlsxTableLayout.Plan(source, Options(height: .4), Measure));
            var headers = Options();headers.RepeatHeaderRows = 4;
            Assert.Throws<ArgumentException>(() => XlsxTableLayout.Plan(source, headers, Measure));
            var range = Options();range.Range = new XlsxSourceRange { FirstRow = 4, LastRow = 7, FirstColumn = 1, LastColumn = 3 };
            Assert.Throws<ArgumentException>(() => XlsxTableLayout.Plan(source, range, Measure));
        }
        [Fact]
        public void HiddenAndMergedCellsRetainExplicitCoverageAndMergedBordersLoseInternalDividers()
        {
            var source = Source(3);source.SelectedSheet!.Rows.Add(new XlsxSourceRow { Index = 3, Hidden = true });
            source.SelectedSheet.Columns[1].Hidden = true;
            source.SelectedSheet.Merges.Add(new XlsxSourceRange { FirstRow = 1, LastRow = 1, FirstColumn = 1, LastColumn = 3 });
            var plan = XlsxTableLayout.Plan(source, Options(), Measure);var page = Assert.Single(plan.Pages);
            Assert.Equal(9, plan.Coverage.Count);Assert.Equal("hidden_column", plan.Coverage.Single(c => c.Address == "B2").State);
            Assert.Equal("hidden_row", plan.Coverage.Single(c => c.Address == "A3").State);
            Assert.Equal("merged_covered", plan.Coverage.Single(c => c.Address == "C1").State);
            Assert.Equal("A1", plan.Coverage.Single(c => c.Address == "C1").AnchorAddress);
            var merged = page.Cells.Single(c => c.Address == "A1");Assert.Equal(2, page.Columns.Count);
            Assert.DoesNotContain(page.Cells, c => c.Address == "C1");Assert.Equal(2 * 87d / 96, merged.WidthInches, 6);
            Assert.DoesNotContain(page.Borders, b => b.X1 == 87d / 96 && b.X2 == b.X1 && b.Y1 == 0 && b.Y2 == merged.HeightInches);
            Assert.Contains(page.Borders, b => b.X1 == 0 && b.X2 == merged.WidthInches && b.Y1 == 0 && b.Y2 == 0);
        }
        [Fact]
        public void WrapAndMeasuredRowGrowthAreExplicitAndMinimumFontReachesTheMeasurer()
        {
            var source = Source(2, 1);source.SelectedSheet!.Cells[0].Text = new string('M', 100);
            var options = Options(height: 30);options.MinimumTextPoints = 12;
            var plan = XlsxTableLayout.Plan(source, options, (cell, width) => { Assert.Equal(12, cell.RenderFontPoints);return Measure(cell, width); });
            Assert.Contains("A1", plan.EnlargedTextCells);Assert.Contains(1, plan.ExpandedRows);
            Assert.Contains(plan.Issues, i => i.Address == "A1" && i.Code == "overflow_wrapped_for_readability");
            Assert.True(plan.Pages[0].Cells[0].WrapText);Assert.Equal(10, plan.Styles[0].FontPoints); // source not rewritten
            options.WrapOverflow = false;Assert.Throws<InvalidOperationException>(() => XlsxTableLayout.Plan(source, options, Measure));
            Assert.Throws<InvalidOperationException>(() => XlsxTableLayout.Plan(Source(), Options(), (_, __) => new XlsxTableTextMeasurement { HeightInches = double.NaN }));
        }
        [Theory]
        [InlineData("0", "0.0", "0.0")]
        [InlineData("0.12345", "0.0%", "12.3%")]
        [InlineData("12345.5", "#,##0", "12,346")]
        [InlineData("-1.005", "0.00;(0.00);\"-\"", "(1.01)")]
        [InlineData("0", "0.00;(0.00);\"-\"", "-")]
        [InlineData("1.25", "0.0\" CFM\"", "1.3 CFM")]
        public void DisplayFormattingKeepsNumericValuesAndRoundsConsistently(string raw, string format, string expected)
        {
            var displayed = XlsxCellDisplay.Format(new XlsxSourceCell { DataType = "n", RawValue = raw, Text = raw }, format);
            Assert.True(displayed.Supported);Assert.Equal(expected, displayed.Text);
        }
        [Fact]
        public void ErrorsMissingCachesAndUnsupportedFormattingNeverBecomeZero()
        {
            Assert.Equal("#REF!", XlsxCellDisplay.Format(new XlsxSourceCell { DataType = "e", Text = "#REF!", ValueState = "cached_formula_error" }, "0.0").Text);
            var missing = XlsxCellDisplay.Format(new XlsxSourceCell { ValueState = "uncached_formula" }, "General");Assert.False(missing.Supported);Assert.Equal("[UNCACHED FORMULA]", missing.Text);
            foreach (var format in new[] { "mm-dd-yy", "[Red]0.00", "# ?/?", "0.0_)", "0.0E+00" })
            { var value = XlsxCellDisplay.Format(new XlsxSourceCell { DataType = "n", RawValue = "42", Text = "42" }, format);Assert.False(value.Supported);Assert.Equal("42", value.Text); }
            var source = Source();source.SelectedSheet!.Cells[0].DataType = "n";source.SelectedSheet.Cells[0].Text = source.SelectedSheet.Cells[0].RawValue = ".126";source.SelectedSheet.Cells[0].StyleIndex = 2;
            Assert.Equal("12.6%", XlsxTableLayout.Plan(source, Options(), Measure).Pages[0].Cells[0].Text);
        }
        [Fact]
        public void CallerMustSupplyRealFontMetricsAndCannotGetAClippedOrImplicitSheetPlan()
        {
            var missing = Options();missing.MaximumDigitWidthPixels = 0;Assert.Throws<ArgumentException>(() => XlsxTableLayout.Plan(Source(), missing, Measure));
            var source = Source();source.SelectedSheet = null;Assert.Throws<ArgumentException>(() => XlsxTableLayout.Plan(source, Options(), Measure));
            var oversized = Source();oversized.SelectedSheet!.Bounds.LastRow = 1000000;
            Assert.Throws<InvalidOperationException>(() => XlsxTableLayout.Plan(oversized, Options(), Measure));
            var overlap = Source();overlap.SelectedSheet!.Merges.Add(new XlsxSourceRange { FirstRow = 1, LastRow = 2, FirstColumn = 1, LastColumn = 2 });
            overlap.SelectedSheet.Merges.Add(new XlsxSourceRange { FirstRow = 2, LastRow = 3, FirstColumn = 2, LastColumn = 3 });
            Assert.Throws<InvalidOperationException>(() => XlsxTableLayout.Plan(overlap, Options(), Measure));
        }
    }
}
