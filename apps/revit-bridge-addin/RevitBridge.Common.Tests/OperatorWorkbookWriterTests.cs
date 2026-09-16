using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text.Json;
using System.Xml.Linq;
using RevitBridge.Common;
using Xunit;

public sealed class OperatorWorkbookWriterTests
{
    private static OperatorWorkbookWriter.Sheet Sheet(params object?[][] rows)
        => new OperatorWorkbookWriter.Sheet("Elements", rows.Cast<IReadOnlyList<object?>>().ToArray());

    [Fact]
    public void WorkbookPreservesTypedUnitsBlanksAndUntrustedTextAndHasVerifiableReceipt()
    {
        var folder = Path.Combine(Path.GetTempPath(), "operator-xlsx-" + Guid.NewGuid().ToString("N"));
        var file = Path.Combine(folder, "rooms.xlsx");
        var priorCulture = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("de-DE");
            var capture = new OperatorNativeArtifactCapture(new[] { file }, 1, "/revit/export-elements-xlsx");
            OperatorWorkbookWriter.Write(file, new[] {
                Sheet(new object?[] { "Area", "Unit", "Occupied", "Missing", "Name", "Source" }, new object?[] { 14.97222, "square feet", true, null, "=HYPERLINK(\"https://invalid\")", "  Étage <1> & 雪\n " }),
                new OperatorWorkbookWriter.Sheet("Issues", new IReadOnlyList<object?>[] { new object?[] { "Status" }, new object?[] { "ambiguous_parameter" } }) });
            capture.RecordNativeExport(true);
            var receipt = capture.Complete();
            Assert.Equal("complete", receipt.Status);
            Assert.True(OperatorNativeArtifactReceipt.TrySettlement(JsonSerializer.SerializeToElement(new { artifact_receipt = receipt }), "apply", "POST", "/revit/export-elements-xlsx", out var settlement));
            Assert.NotNull(settlement);
            var inspected = OperatorNativeArtifactCapture.Inspect(new[] { file });
            Assert.Equal(receipt.Outputs[0].Sha256, inspected[0].Sha256);
            using var stream = File.OpenRead(file);
            using var zip = new ZipArchive(stream, ZipArchiveMode.Read);
            foreach (var entry in zip.Entries) { using var s = entry.Open(); XDocument.Load(s); }
            using var sheetStream = zip.GetEntry("xl/worksheets/sheet1.xml")!.Open();
            var xml = XDocument.Load(sheetStream); XNamespace ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
            XElement Cell(string address) => xml.Descendants(ns + "c").Single(c => (string?)c.Attribute("r") == address);
            Assert.Equal("14.97222", Cell("A2").Element(ns + "v")!.Value);
            Assert.Equal("b", (string?)Cell("C2").Attribute("t"));
            Assert.Equal("1", Cell("C2").Element(ns + "v")!.Value);
            Assert.False(Cell("D2").HasElements);
            Assert.Equal("inlineStr", (string?)Cell("E2").Attribute("t"));
            Assert.Empty(xml.Descendants(ns + "f"));
            Assert.Equal("  Étage <1> & 雪\n ", Cell("F2").Descendants(ns + "t").Single().Value);
            Assert.Equal("frozen", (string?)xml.Descendants(ns + "pane").Single().Attribute("state"));
            Assert.Equal("A1:F2", (string?)xml.Descendants(ns + "autoFilter").Single().Attribute("ref"));
        }
        finally { CultureInfo.CurrentCulture = priorCulture; if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    [Fact]
    public void FailedWorkbookNeverPublishesPartialOutputOrOverwritesAnExistingFile()
    {
        var folder = Path.Combine(Path.GetTempPath(), "operator-xlsx-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder); var file = Path.Combine(folder, "rooms.xlsx");
        try
        {
            File.WriteAllText(file, "preserve existing");
            Assert.Throws<IOException>(() => OperatorWorkbookWriter.Write(file, new[] { Sheet(new object?[] { "Header" }) }));
            Assert.Equal("preserve existing", File.ReadAllText(file)); File.Delete(file);
            foreach (var invalid in new object?[] { double.NaN, double.PositiveInfinity, new string('x', 32768), "invalid\u0001text" })
            {
                Assert.ThrowsAny<Exception>(() => OperatorWorkbookWriter.Write(file, new[] { Sheet(new object?[] { "Header" }, new object?[] { invalid }) }));
                Assert.False(File.Exists(file)); Assert.Empty(Directory.GetFiles(folder));
            }
            var preview = OperatorNativeArtifactReceipt.Preview(new[] { file }, 1, "/revit/export-elements-xlsx");
            Assert.Equal("not_started", preview.Status); Assert.False(File.Exists(file));
            Assert.Throws<ArgumentException>(() => new OperatorNativeArtifactCapture(new[] { file }, 1, "/revit/delete"));
        }
        finally { Directory.Delete(folder, true); }
    }
}
