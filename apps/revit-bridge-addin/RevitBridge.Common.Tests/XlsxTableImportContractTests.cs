using System;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class XlsxTableImportContractTests
    {
        private static string Request(object? extra = null) => JsonSerializer.Serialize(new { sourcePath = "uploads/table.xlsx", sheetName = "Ventilation Schedule",
            viewName = "Ventilation", expectedSourceSha256 = new string('a', 64) });
        private static XlsxTableLayoutPlan Plan(out XlsxOutputSourceManifest source)
        {
            source = XlsxOutputSourceReader.Read(XlsxOutputSourceTests.Package(), "Ventilation Schedule");
            return XlsxTableLayout.Plan(source, new XlsxTableLayoutOptions { MaximumDigitWidthPixels = 7 }, (_, __) => new XlsxTableTextMeasurement { WidthInches = .1, HeightInches = .1 });
        }
        [Fact]
        public void CompletePlanRoundTripRetainsGetterCollectionsStylesAndNativeFalseClaims()
        {
            var plan = Plan(out _);var packed = XlsxTablePlanCodec.Encode(plan);var restored = XlsxTablePlanCodec.Decode(packed.Packed, packed.Sha256);
            Assert.Equal(JsonSerializer.Serialize(plan), JsonSerializer.Serialize(restored));
            Assert.Equal(plan.Coverage.Count, restored.Coverage.Count);Assert.Equal(plan.Pages[0].Borders.Count, restored.Pages[0].Borders.Count);
            Assert.All(restored.Pages.SelectMany(p => p.Cells), c => Assert.Same(restored.Styles[c.StyleIndex], c.Style));
            Assert.False(restored.NativeImportVerified);Assert.False(restored.CalculationPerformed);
            Assert.Throws<InvalidOperationException>(() => XlsxTablePlanCodec.Decode(packed.Packed, new string('b', 64)));
            Assert.Throws<FormatException>(() => XlsxTablePlanCodec.Decode("invalid", packed.Sha256));
        }
        [Fact]
        public void FreshOriginalSourceProjectionDetectsMissingOrChangedTextFormattingCoverageAndGeometry()
        {
            var plan = Plan(out var source);Assert.True(XlsxTableSourceProjection.Check(source, plan).Matches);
            var text = plan.Pages[0].Cells.First(c => c.Text.Length > 0);text.Text = "wrong";
            Assert.False(XlsxTableSourceProjection.Check(source, plan).Matches);
            plan = Plan(out source);plan.Coverage.RemoveAt(0);Assert.False(XlsxTableSourceProjection.Check(source, plan).Matches);
            plan = Plan(out source);plan.Pages[0].Cells[0].Style.FontPoints = 1;Assert.False(XlsxTableSourceProjection.Check(source, plan).Matches);
            plan = Plan(out source);plan.Pages[0].Cells[0].XInches += .1;Assert.False(XlsxTableSourceProjection.Check(source, plan).Matches);
            plan = Plan(out source);plan.Pages[0].Cells.RemoveAt(0);Assert.False(XlsxTableSourceProjection.Check(source, plan).Matches);
            plan = Plan(out source);source.SourceSha256 = new string('0', 64);Assert.False(XlsxTableSourceProjection.Check(source, plan).Matches);
        }
        [Fact]
        public void ExactSourceAndFreshContinuationIdentityAreRequiredAndNoDigitWidthOverrideIsAccepted()
        {
            Assert.Equal(0, XlsxTableImportRequest.Parse(Request()).partIndex);
            string Continue(string body) => Request().TrimEnd('}') + "," + body + "}";
            Assert.Throws<ArgumentException>(() => XlsxTableImportRequest.Parse(Continue("\"partIndex\":1")));
            Assert.Throws<ArgumentException>(() => XlsxTableImportRequest.Parse(Continue("\"manifestElementId\":123")));
            var good = XlsxTableImportRequest.Parse(Continue("\"partIndex\":1,\"manifestElementId\":123,\"expectedImportSnapshotSha256\":\"" + new string('b', 64) + "\""));
            Assert.Equal(123, good.manifestElementId);Assert.Equal(1, good.partIndex);
            foreach (var body in new[] { "\"partIndex\":500", "\"layout\":{\"maximumDigitWidthPixels\":1}", "\"layout\":{\"pageHeightInches\":0}", "\"borderWeights\":{\"medium\":17}", "\"sourcePath\":\"duplicate\"", "\"viewId\":5" })
                Assert.Throws<ArgumentException>(() => XlsxTableImportRequest.Parse(Continue(body)));
            var range = XlsxTableImportRequest.Parse(Continue("\"layout\":{\"range\":{\"firstRow\":1,\"lastRow\":434,\"firstColumn\":1,\"lastColumn\":25},\"repeatHeaderRows\":3}"));
            Assert.Equal(434, range.layout!.Range!.LastRow);Assert.Equal(3, range.layout.RepeatHeaderRows);
        }
        [Fact]
        public void InspectionCannotGrantWritesAndPagedDetailsRequirePartAndSnapshot()
        {
            Assert.Equal("list", XlsxTableInspectionRequest.Parse("{\"action\":\"list\"}").action);
            Assert.Throws<ArgumentException>(() => XlsxTableInspectionRequest.Parse("{\"action\":\"list\",\"sourcePath\":\"x\"}"));
            string Body(string extra) => "{\"sourcePath\":\"uploads/table.xlsx\",\"manifestElementId\":123" + extra + "}";
            Assert.Throws<ArgumentException>(() => XlsxTableInspectionRequest.Parse(Body(",\"section\":\"notes\"")));
            Assert.Throws<ArgumentException>(() => XlsxTableInspectionRequest.Parse(Body(",\"partIndex\":0,\"section\":\"notes\",\"pageOffset\":1")));
            var valid = XlsxTableInspectionRequest.Parse(Body(",\"partIndex\":0,\"section\":\"notes\",\"pageOffset\":1,\"expectedInspectionSnapshotSha256\":\"" + new string('c', 64) + "\""));
            Assert.Equal(1, valid.pageOffset);
            Assert.Throws<ArgumentException>(() => XlsxTableInspectionRequest.Parse(Body(",\"dryRun\":false")));
        }
    }
}
