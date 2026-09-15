using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text.Json;
using System.Xml.Linq;
using RevitBridge.Common;
using Xunit;

public sealed class OperatorWorkbookSupplementalTablesTests
{
    private static readonly OperatorWorkbookSupplementalTables.NativeIdentity[] Native = {
        new OperatorWorkbookSupplementalTables.NativeIdentity { ElementId = 99, UniqueId = "space-a-native", Name = "Office" },
        new OperatorWorkbookSupplementalTables.NativeIdentity { ElementId = 100, UniqueId = "space-b-native", Name = "Restroom" }
    };
    private static OperatorWorkbookSupplementalTables.Table Table() => new OperatorWorkbookSupplementalTables.Table {
        name = "Proposed quantities", contentKind = "assistant_proposal", columns = new List<string> { "Supply CFM", "Device count", "Review" },
        rows = new List<OperatorWorkbookSupplementalTables.Row> {
            new OperatorWorkbookSupplementalTables.Row { elementId = 100, values = Cells("[0,0,\"Exhaust only\"]") },
            new OperatorWorkbookSupplementalTables.Row { elementId = 99, values = Cells("[450,3,\"=HYPERLINK(\\\"https://invalid\\\")\"]") }
        }
    };
    private static List<JsonElement> Cells(string json) => JsonSerializer.Deserialize<List<JsonElement>>(json)!;

    [Fact]
    public void CompleteBoundTablesPreserveZeroAndProposalValuesWithNativeIdentityAndVisibleProvenance()
    {
        var table = Table();
        var sheets = OperatorWorkbookSupplementalTables.Build(new[] { table }, Native);
        Assert.Single(sheets);
        var rows = sheets[0].Rows;
        Assert.Equal(3, rows.Count);
        Assert.Equal("Native ElementId", rows[0][0]); Assert.Equal("Table | Supply CFM", rows[0][4]);
        Assert.Equal("100", rows[1][0]); Assert.Equal("space-b-native", rows[1][1]); Assert.Equal("Restroom", rows[1][2]);
        Assert.Contains("Assistant-authored assistant_proposal", (string)rows[1][3]!);
        Assert.Equal(0L, rows[1][4]); Assert.Equal(450L, rows[2][4]); Assert.Equal(3L, rows[2][5]);
        var folder = Path.Combine(Path.GetTempPath(), "operator-supplement-" + Guid.NewGuid().ToString("N"));
        var file = Path.Combine(folder, "proposal.xlsx");
        try
        {
            OperatorWorkbookWriter.Write(file, sheets);
            using var zip = ZipFile.OpenRead(file);
            using var stream = zip.GetEntry("xl/worksheets/sheet1.xml")!.Open();
            var xml = XDocument.Load(stream); XNamespace ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
            Assert.Empty(xml.Descendants(ns + "f"));
            var cell = xml.Descendants(ns + "c").Single(c => (string?)c.Attribute("r") == "G3");
            Assert.Equal("inlineStr", (string?)cell.Attribute("t"));
            Assert.Contains("HYPERLINK", cell.Value);
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    [Fact]
    public void OmittedDuplicateAndForeignTargetsAreRejectedBeforeAnyWorkbookCanBeBuilt()
    {
        foreach (var change in new Action<OperatorWorkbookSupplementalTables.Table>[] {
            table => table.rows!.RemoveAt(0), table => table.rows![0].elementId = 99,
            table => table.rows![0].elementId = 101, table => table.rows!.Add(table.rows[0])
        })
        {
            var table = Table(); change(table);
            Assert.Throws<ArgumentException>(() => OperatorWorkbookSupplementalTables.Build(new[] { table }, Native));
        }
    }

    [Fact]
    public void SupplementalMetadataCannotReplaceNativeSheetsOrClaimNativeAuthority()
    {
        foreach (var name in new[] { "Elements", "issues", "Readme", "bad/name", "", new string('x', 32) })
        {
            var table = Table(); table.name = name;
            Assert.Throws<ArgumentException>(() => OperatorWorkbookSupplementalTables.Build(new[] { table }, Native));
        }
        foreach (var kind in new[] { "native", "engineering_verified", "user_approved", "" })
        {
            var table = Table(); table.contentKind = kind;
            Assert.Throws<ArgumentException>(() => OperatorWorkbookSupplementalTables.Build(new[] { table }, Native));
        }
        Assert.Throws<ArgumentException>(() => OperatorWorkbookSupplementalTables.Build(new[] { Table(), Table() }, Native));
    }

    [Fact]
    public void RowShapesNestedValuesUnboundedTextAndNonfiniteNumbersAreRejected()
    {
        foreach (var invalid in new[] { "[]", "[1,2]", "[1,2,3,4]", "[{},0,0]", "[[],0,0]", "[1e500,0,0]", "[\"\\u0001\",0,0]" })
        {
            var table = Table(); table.rows![0].values = Cells(invalid);
            Assert.ThrowsAny<Exception>(() => OperatorWorkbookSupplementalTables.Build(new[] { table }, Native));
        }
        var oversized = Table(); oversized.rows![0].values = Cells(JsonSerializer.Serialize(new object[] { new string('x', 8193), 0, 0 }));
        Assert.Throws<ArgumentException>(() => OperatorWorkbookSupplementalTables.Build(new[] { oversized }, Native));
    }

    [Fact]
    public void ScalarTranscriptionPreservesNullBooleanAndExactIntegerValues()
    {
        var table = Table(); table.contentKind = "user_input_transcription";
        table.rows![0].values = Cells("[null,true,9007199254740993]");
        var rows = OperatorWorkbookSupplementalTables.Build(new[] { table }, Native)[0].Rows;
        Assert.Null(rows[1][4]); Assert.Equal(true, rows[1][5]); Assert.Equal("9007199254740993", rows[1][6]);
        Assert.Contains("verify supplied values", (string)rows[1][3]!);
        table.rows[0].values = Cells("[0.123456789012345678,12.5,1e100]");
        rows = OperatorWorkbookSupplementalTables.Build(new[] { table }, Native)[0].Rows;
        Assert.Equal("0.123456789012345678", rows[1][4]); Assert.Equal(12.5m, rows[1][5]); Assert.Equal("1e100", rows[1][6]);
    }

    [Fact]
    public void AggregateTextAndCellBudgetsApplyAcrossAllTables()
    {
        var text = Table(); text.columns = Enumerable.Range(0, 32).Select(i => "Column " + i).ToList();
        foreach (var row in text.rows!) row.values = Enumerable.Repeat(JsonSerializer.SerializeToElement(new string('x', 8192)), 32).ToList();
        Assert.Single(OperatorWorkbookSupplementalTables.Build(new[] { text }, Native));
        var text2 = JsonSerializer.Deserialize<OperatorWorkbookSupplementalTables.Table>(JsonSerializer.Serialize(text))!; text2.name = "Second table";
        Assert.Throws<ArgumentException>(() => OperatorWorkbookSupplementalTables.Build(new[] { text, text2 }, Native));
        var population = Enumerable.Range(1, 1001).Select(i => new OperatorWorkbookSupplementalTables.NativeIdentity {
            ElementId = i, UniqueId = "native-" + i, Name = "Space " + i
        }).ToArray();
        var cells = Table(); cells.columns = text.columns;
        cells.rows = population.Select(identity => new OperatorWorkbookSupplementalTables.Row { elementId = identity.ElementId,
            values = Enumerable.Repeat(JsonSerializer.SerializeToElement(1), 32).ToList() }).ToList();
        Assert.Single(OperatorWorkbookSupplementalTables.Build(new[] { cells }, population));
        var cells2 = JsonSerializer.Deserialize<OperatorWorkbookSupplementalTables.Table>(JsonSerializer.Serialize(cells))!; cells2.name = "Second table";
        Assert.Throws<ArgumentException>(() => OperatorWorkbookSupplementalTables.Build(new[] { cells, cells2 }, population));
    }
}
