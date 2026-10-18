using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class XlsxOutputSourceTests
    {
        private const string S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
        private const string R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        private const string P = "http://schemas.openxmlformats.org/package/2006/relationships";
        private const string Cells = "<row r='1' ht='24' customHeight='1'><c r='A1' t='s'><v>0</v></c></row>" +
            "<row r='2'><c r='A2'><v>0</v></c><c r='B2' s='1'><f>21*2</f><v>42</v></c>" +
            "<c r='C2' t='e'><f>#REF!</f><v>#REF!</v></c><c r='D2'><f>UNKNOWN()</f></c>" +
            "<c r='E2' t='str'><f>IF(1=1,&quot;&quot;,&quot;x&quot;)</f><v/></c>" +
            "<c r='F2' t='inlineStr'><is><r><rPr><b/></rPr><t>Room </t></r><r><t>101</t></r><rPh sb='0' eb='1'><t>phonetic</t></rPh></is></c>" +
            "<c r='G2'><f t='shared' si='7'/><v>2</v></c></row>";
        internal static byte[] Package(string cells = Cells, string target = "worksheets/output.xml", string mode = "", string extra = "", bool duplicate = false)
        {
            using (var memory = new MemoryStream())
            {
                using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true))
                {
                    Write(zip, "xl/workbook.xml", "<workbook xmlns='" + S + "' xmlns:r='" + R + "'><sheets>" +
                        "<sheet name='Calculations' sheetId='1' r:id='rCalc'/><sheet name='Ventilation Schedule' sheetId='2' r:id='rOutput'/>" +
                        "</sheets><definedNames><definedName name='_xlnm.Print_Area' localSheetId='1'>'Ventilation Schedule'!$A$1:$G$20</definedName></definedNames></workbook>");
                    Write(zip, "xl/_rels/workbook.xml.rels", "<Relationships xmlns='" + P + "'>" +
                        "<Relationship Id='rCalc' Type='" + R + "/worksheet' Target='worksheets/calculations.xml'/>" +
                        "<Relationship Id='rOutput' Type='" + R + "/worksheet' Target='" + target + "' " + mode + "/>" +
                        "<Relationship Id='rStyles' Type='" + R + "/styles' Target='customStyles.xml'/>" +
                        "<Relationship Id='rStrings' Type='" + R + "/sharedStrings' Target='sharedStrings.xml'/></Relationships>");
                    Write(zip, "xl/worksheets/calculations.xml", "<worksheet xmlns='" + S + "'><sheetData><row r='1'><c r='A1'><v>999</v></c></row></sheetData></worksheet>");
                    var xml = "<worksheet xmlns='" + S + "'><dimension ref='A1:G20'/><sheetFormatPr defaultRowHeight='13.5' baseColWidth='8'/>" +
                        "<cols><col min='1' max='3' width='12.4' customWidth='1'/><col min='4' max='4' width='10' hidden='1'/></cols>" +
                        "<sheetData>" + cells + "</sheetData><mergeCells><mergeCell ref='A3:C3'/></mergeCells>" +
                        "<pageSetup scale='10' orientation='landscape'/><rowBreaks count='1'><brk id='20' min='0' max='16383' man='1'/></rowBreaks>" + extra + "</worksheet>";
                    Write(zip, "xl/worksheets/output.xml", xml);
                    if (duplicate) Write(zip, "xl/worksheets/output.xml", xml);
                    Write(zip, "xl/customStyles.xml", "<styleSheet xmlns='" + S + "'><numFmts><numFmt numFmtId='164' formatCode='0.0%'/></numFmts>" +
                        "<fonts><font><name val='Arial'/><sz val='8'/></font><font><name val='Arial'/><sz val='8'/><b/></font></fonts>" +
                        "<fills><fill><patternFill patternType='none'/></fill></fills><borders><border/></borders>" +
                        "<cellStyleXfs><xf numFmtId='0' fontId='0' fillId='0' borderId='0'/></cellStyleXfs>" +
                        "<cellXfs><xf numFmtId='0' fontId='0' fillId='0' borderId='0'/><xf numFmtId='164' fontId='1' fillId='0' borderId='0'><alignment wrapText='1' horizontal='center'/></xf></cellXfs></styleSheet>");
                    Write(zip, "xl/sharedStrings.xml", "<sst xmlns='" + S + "'><si><t>VENTILATION SCHEDULE</t></si></sst>");
                }
                return memory.ToArray();
            }
        }
        private static void Write(ZipArchive zip, string path, string xml)
        { using (var writer = new StreamWriter(zip.CreateEntry(path).Open(), new UTF8Encoding(false))) writer.Write(xml); }

        [Fact]
        public void DiscoveryDoesNotSelectFirstTabAndMissingNamedOutputCannotFallBack()
        {
            var source = Package(); var discovery = XlsxOutputSourceReader.Read(source);
            Assert.Null(discovery.SelectedSheet);
            Assert.Equal(new[] { "Calculations", "Ventilation Schedule" }, discovery.Worksheets.Select(s => s.Name));
            Assert.Throws<InvalidOperationException>(() => XlsxOutputSourceReader.Read(source, "missing output"));
            Assert.Equal("Ventilation Schedule", XlsxOutputSourceReader.Read(source, "ventilation schedule").SelectedSheet!.Identity.Name);
            using (var memory = new MemoryStream(source))
            using (var zip = new ZipArchive(memory, ZipArchiveMode.Read))
            {
                Assert.Throws<InvalidOperationException>(() => XlsxSourcePackage.ResolveWorksheetPath(zip, "missing output", out _));
                Assert.Equal("xl/worksheets/calculations.xml", XlsxSourcePackage.ResolveWorksheetPath(zip, "", out var name));
                Assert.Equal("Calculations", name); // Legacy unspecified-sheet behavior remains explicit.
            }
        }

        [Fact]
        public void KeepsZeroErrorsMissingCachesEmptyStringsAndSharedFormulasDistinct()
        {
            var manifest = XlsxOutputSourceReader.Read(Package(), "Ventilation Schedule");var sheet = manifest.SelectedSheet!;
            Assert.Equal("0", sheet.Cells.Single(c => c.Address == "A2").Text);
            Assert.Equal("42", sheet.Cells.Single(c => c.Address == "B2").Text);
            Assert.Equal("cached_formula_error", sheet.Cells.Single(c => c.Address == "C2").ValueState);
            Assert.Equal("#REF!", sheet.Cells.Single(c => c.Address == "C2").Text);
            Assert.Equal("uncached_formula", sheet.Cells.Single(c => c.Address == "D2").ValueState);
            Assert.Null(sheet.Cells.Single(c => c.Address == "D2").Text);
            Assert.Equal("", sheet.Cells.Single(c => c.Address == "E2").Text);
            Assert.True(sheet.Cells.Single(c => c.Address == "E2").HasCachedValue);
            Assert.Equal("Room 101", sheet.Cells.Single(c => c.Address == "F2").Text);
            Assert.Contains("si=\"7\"", sheet.Cells.Single(c => c.Address == "G2").FormulaXml!);
            Assert.Equal(5, sheet.FormulaCount);Assert.Equal(1, sheet.CachedErrorCount);Assert.Equal(1, sheet.MissingFormulaCacheCount);
            Assert.False(manifest.CalculationPerformed);Assert.False(manifest.NativeImportVerified);Assert.Equal(64, manifest.SourceSha256.Length);
        }

        [Fact]
        public void PreservesSourceLayoutRichStylesMergesAndPrintContext()
        {
            var manifest = XlsxOutputSourceReader.Read(Package(), "Ventilation Schedule");var sheet = manifest.SelectedSheet!;
            Assert.Equal(13.5, sheet.DefaultRowHeightPoints);Assert.Equal(24, sheet.Rows.Single(r => r.Index == 1).HeightPoints);
            Assert.Equal(12.4, sheet.Columns[0].WidthCharacters);Assert.True(sheet.Columns[1].Hidden);
            Assert.Equal("A3:C3", sheet.Merges.Single().Address);Assert.Equal(3, sheet.Bounds.LastRow);
            Assert.Contains("scale=\"10\"", sheet.PrintContextXml);Assert.Contains("_xlnm.Print_Area", sheet.PrintContextXml);
            Assert.Contains("xl/customStyles.xml", manifest.FormattingParts.Keys);Assert.Contains("formatCode=\"0.0%\"", manifest.FormattingParts["xl/customStyles.xml"]);
            Assert.Equal(1, sheet.Cells.Single(c => c.Address == "B2").StyleIndex);
            Assert.Contains("<b", sheet.Cells.Single(c => c.Address == "F2").RichTextXml!);
        }

        [Fact]
        public void ReadsTheCompleteSparseSheetBeyondTheOldTwoHundredRowImportCap()
        {
            var cells = string.Concat(Enumerable.Range(1, 434).Select(r => "<row r='" + r + "'><c r='A" + r + "'><v>" + r + "</v></c></row>"));
            var sheet = XlsxOutputSourceReader.Read(Package(cells), "Ventilation Schedule").SelectedSheet!;
            Assert.Equal(434, sheet.Cells.Count);Assert.Equal(434, sheet.Bounds.LastRow);Assert.Equal("434", sheet.Cells.Last().Text);
        }

        [Fact]
        public void RejectsDuplicatePartsExternalSheetTargetsAndRootTraversal()
        {
            Assert.Throws<InvalidOperationException>(() => XlsxOutputSourceReader.Read(Package(duplicate: true), "Ventilation Schedule"));
            Assert.Throws<InvalidOperationException>(() => XlsxOutputSourceReader.Read(Package(target: "https://example.invalid/sheet.xml", mode: "TargetMode='External'"), "Ventilation Schedule"));
            Assert.Throws<InvalidOperationException>(() => XlsxOutputSourceReader.Read(Package(target: "../../outside.xml"), "Ventilation Schedule"));
        }

        [Fact]
        public void RejectsMalformedReferencesInvalidSharedStringsAndOverlappingMerges()
        {
            Assert.Throws<InvalidOperationException>(() => XlsxOutputSourceReader.Read(Package("<row r='1'><c r='A0'><v>1</v></c></row>"), "Ventilation Schedule"));
            Assert.Throws<InvalidOperationException>(() => XlsxOutputSourceReader.Read(Package("<row r='1'><c r='A1' t='s'><v>999</v></c></row>"), "Ventilation Schedule"));
            Assert.Throws<InvalidOperationException>(() => XlsxOutputSourceReader.Read(Package(extra: "<mergeCells><mergeCell ref='B3:D3'/></mergeCells>"), "Ventilation Schedule"));
        }

        [Fact]
        public void SupportsImplicitAddressesAndPackageAbsoluteWorksheetTargets()
        {
            var source = Package("<row><c><v>0</v></c><c t='inlineStr'><is><t>Label</t></is></c></row><row><c><v>2</v></c></row>", target: "/xl/worksheets/output.xml");
            var cells = XlsxOutputSourceReader.Read(source, "Ventilation Schedule").SelectedSheet!.Cells;
            Assert.Equal(new[] { "A1", "B1", "A2" }, cells.Select(c => c.Address));Assert.Equal(new[] { "0", "Label", "2" }, cells.Select(c => c.Text));
        }

        [Fact]
        public void InvalidNumericCachesStayVisibleAndCannotBecomeZeroOrHealthyValues()
        {
            var source = Package("<row r='1'><c r='A1'><f>1+1</f><v>not-a-number</v></c><c r='B1'><v>NaN</v></c></row>");
            var manifest = XlsxOutputSourceReader.Read(source, "Ventilation Schedule");var cells = manifest.SelectedSheet!.Cells;
            Assert.Equal(new[] { "invalid_numeric_cache", "invalid_numeric_literal" }, cells.Select(c => c.ValueState));
            Assert.Equal(new[] { "not-a-number", "NaN" }, cells.Select(c => c.Text));Assert.Equal(2, manifest.Issues.Count);
        }

        [Fact]
        public void BlankNumericValuesLiteralErrorsAndEmptyStringFormulaCachesRemainDifferent()
        {
            var source = Package("<row r='1'><c r='A1'><v/></c><c r='B1' t='e'><v>#N/A</v></c><c r='C1' t='str'><f>IF(1,&quot;&quot;)</f><v/></c><c r='D1'><f>2+2</f><v/></c></row>");
            var sheet = XlsxOutputSourceReader.Read(source, "Ventilation Schedule").SelectedSheet!;
            Assert.Equal(new[] { "blank", "literal_error", "cached_formula", "uncached_formula" }, sheet.Cells.Select(c => c.ValueState));
            Assert.Equal(1, sheet.ErrorCellCount);Assert.Equal(0, sheet.CachedErrorCount);Assert.Equal(1, sheet.MissingFormulaCacheCount);
            Assert.Equal("", sheet.Cells[2].Text);Assert.Null(sheet.Cells[3].Text);
        }

        [Fact]
        public void ProhibitsDtdExpansionInWorksheetXml()
        {
            using (var input = new MemoryStream(Package()))
            using (var original = new ZipArchive(input, ZipArchiveMode.Read))
            using (var output = new MemoryStream())
            {
                using (var zip = new ZipArchive(output, ZipArchiveMode.Create, true))
                    foreach (var entry in original.Entries)
                    {
                        using (var reader = new StreamReader(entry.Open(), Encoding.UTF8))
                            Write(zip, entry.FullName, entry.FullName == "xl/worksheets/output.xml"
                                ? "<!DOCTYPE worksheet [<!ENTITY injected 'forbidden'>]><worksheet xmlns='" + S + "'><sheetData/></worksheet>"
                                : reader.ReadToEnd());
                    }
                Assert.Throws<System.Xml.XmlException>(() => XlsxOutputSourceReader.Read(output.ToArray(), "Ventilation Schedule"));
            }
        }
    }
}
