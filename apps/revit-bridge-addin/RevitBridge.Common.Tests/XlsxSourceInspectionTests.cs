using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class XlsxSourceInspectionTests
    {
        private static JsonElement Read(byte[] source, object request) => (JsonElement)XlsxSourceInspection.Read(source, JsonSerializer.Serialize(request));

        [Fact]
        public void DiscoveryDoesNotExposeCalculationTabCellsAndSummaryIsExplicitlyUnverified()
        {
            var source = XlsxOutputSourceTests.Package();
            var summary = Read(source, new { sourcePath = "uploads/vent.xlsx" });
            Assert.Equal(JsonValueKind.Null, summary.GetProperty("summary").GetProperty("selectedSheet").ValueKind);
            Assert.Equal(0, summary.GetProperty("records").GetArrayLength());
            Assert.False(summary.GetProperty("calculationPerformed").GetBoolean());Assert.False(summary.GetProperty("nativeImportVerified").GetBoolean());
            var discovery = Read(source, new { sourcePath = "uploads/vent.xlsx", section = "worksheets" });
            Assert.Equal(new[] { "Calculations", "Ventilation Schedule" }, discovery.GetProperty("records").EnumerateArray().Select(r => r.GetProperty("name").GetString()));
            Assert.Throws<ArgumentException>(() => Read(source, new { sourcePath = "vent.xlsx", section = "cells" }));
            Assert.Throws<InvalidOperationException>(() => Read(source, new { sourcePath = "vent.xlsx", sheetName = "Ventilation Table" }));
        }

        [Fact]
        public void CompleteFourHundredThirtyFourRowsAreWalkableWithSourceBoundCursors()
        {
            var rows = string.Concat(Enumerable.Range(1, 434).Select(i => "<row r='" + i + "'><c r='A" + i + "'><v>" + i + "</v></c></row>"));
            var source = XlsxOutputSourceTests.Package(rows);var seen = new List<string>();int offset = 0;string? hash = null;
            do
            {
                var arguments = new Dictionary<string, object> { ["sourcePath"] = "vent.xlsx", ["sheetName"] = "Ventilation Schedule", ["section"] = "cells", ["pageSize"] = 100, ["pageOffset"] = offset };
                if (hash != null) arguments["expectedSourceSha256"] = hash;
                var page = Read(source, arguments);hash = page.GetProperty("sourceSha256").GetString();
                Assert.True(Encoding.UTF8.GetByteCount(page.GetRawText()) <= XlsxSourceInspection.MaxPageBytes);
                seen.AddRange(page.GetProperty("records").EnumerateArray().Select(r => r.GetProperty("address").GetString()!));
                if (!page.GetProperty("hasMore").GetBoolean()) break;
                offset = page.GetProperty("nextOffset").GetInt32();
            } while (true);
            Assert.Equal(Enumerable.Range(1, 434).Select(i => "A" + i), seen);
        }

        [Fact]
        public void ChangedSourceCannotMixContinuationRecordsAndUnboundContinuationIsRejected()
        {
            var source = XlsxOutputSourceTests.Package();
            Assert.Throws<ArgumentException>(() => Read(source, new { sourcePath = "vent.xlsx", section = "worksheets", pageOffset = 1 }));
            var page = Read(source, new { sourcePath = "vent.xlsx", sheetName = "Ventilation Schedule", section = "cells", pageOffset = 1, expectedSourceSha256 = new string('0', 64) });
            Assert.Equal("SourceChanged", page.GetProperty("status").GetString());Assert.Empty(page.GetProperty("records").EnumerateArray());
            Assert.False(page.GetProperty("hasMore").GetBoolean());Assert.Equal(JsonValueKind.Null, page.GetProperty("nextOffset").ValueKind);
        }

        [Fact]
        public void ByteBudgetDefersWholeRecordsRatherThanClippingSourceText()
        {
            var value = new string('x', 10000);
            var cells = "<row r='1'>" + string.Concat(Enumerable.Range(1, 3).Select(i => "<c r='" + (char)('A' + i - 1) + "1' t='inlineStr'><is><t>" + value + "</t></is></c>")) + "</row>";
            var page = Read(XlsxOutputSourceTests.Package(cells), new { sourcePath = "vent.xlsx", sheetName = "Ventilation Schedule", section = "cells", pageSize = 100 });
            Assert.True(page.GetProperty("hasMore").GetBoolean());Assert.Equal(2, page.GetProperty("nextOffset").GetInt32());
            foreach (var cell in page.GetProperty("records").EnumerateArray()) Assert.Equal(value, cell.GetProperty("text").GetString());
            var oversized = XlsxOutputSourceTests.Package("<row r='1'><c r='A1' t='inlineStr'><is><t>" + new string('x', 70000) + "</t></is></c></row>");
            Assert.Throws<InvalidOperationException>(() => Read(oversized, new { sourcePath = "vent.xlsx", sheetName = "Ventilation Schedule", section = "cells" }));
        }

        [Fact]
        public void ErrorAndMissingCacheCountsRemainVisibleWithoutDumpingAllIssues()
        {
            var source = XlsxOutputSourceTests.Package();var summary = Read(source, new { sourcePath = "vent.xlsx", sheetName = "Ventilation Schedule" });
            Assert.Equal(1, summary.GetProperty("summary").GetProperty("cachedFormulaErrorCount").GetInt32());
            Assert.Equal(1, summary.GetProperty("summary").GetProperty("missingFormulaCacheCount").GetInt32());
            var errors = Read(source, new { sourcePath = "vent.xlsx", sheetName = "Ventilation Schedule", section = "issues" });
            Assert.Contains(errors.GetProperty("records").EnumerateArray(), r => r.GetProperty("code").GetString() == "cell_error" && r.GetProperty("address").GetString() == "C2");
            var formats = Read(source, new { sourcePath = "vent.xlsx", sheetName = "Ventilation Schedule", section = "formatting" });
            Assert.Contains(formats.GetProperty("records").EnumerateArray(), r => r.GetProperty("group").GetString() == "numFmts" && r.GetProperty("xml").GetString()!.Contains("0.0%"));
        }

        [Theory]
        [InlineData("{\"sourcePath\":\"x\",\"sourcePath\":\"y\"}")]
        [InlineData("{\"sourcePath\":\"x\",\"unexpected\":true}")]
        [InlineData("{\"sourcePath\":\"x\",\"pageSize\":101}")]
        [InlineData("{\"sourcePath\":\"x\",\"sheetName\":null}")]
        [InlineData("{\"sourcePath\":\"x\",\"sheetName\":\" \"}")]
        [InlineData("{\"sourcePath\":\"x\",\"section\":\"unknown\"}")]
        [InlineData("{\"sourcePath\":\"x\",\"expectedSourceSha256\":\"oops\"}")]
        public void RejectsAmbiguousOrUnboundedRequests(string json) => Assert.Throws<ArgumentException>(() => XlsxSourceInspectionRequest.Parse(json));
    }
}
