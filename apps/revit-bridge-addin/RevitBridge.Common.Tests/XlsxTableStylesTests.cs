using System;
using System.Linq;
using System.Xml;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class XlsxTableStylesTests
    {
        [Fact]
        public void RelatedCustomStylePartKeepsFontAlignmentPercentAndRawDefinition()
        {
            var source = XlsxOutputSourceReader.Read(XlsxOutputSourceTests.Package(), "Ventilation Schedule");
            var catalog = new XlsxTableStyles(source);var style = catalog.Read(1);
            Assert.Equal("Arial", style.FontFamily);Assert.Equal(8, style.FontPoints);Assert.True(style.Bold);
            Assert.Equal("0.0%", style.NumberFormat);Assert.Equal("center", style.Horizontal);Assert.True(style.Wrap);
            Assert.Contains("numFmtId=\"164\"", style.SourceStyleXml);Assert.Empty(style.Unsupported);
            Assert.Equal(8, source.SelectedSheet!.BaseColumnWidthCharacters);
            Assert.Equal(1, catalog.StyleIndex(new XlsxSourceCell { StyleIndex = 1 }, new XlsxSourceRow { StyleIndex = 9 }, new XlsxSourceColumn { StyleIndex = 7 }));
            Assert.Equal(9, catalog.StyleIndex(null, new XlsxSourceRow { StyleIndex = 9 }, new XlsxSourceColumn { StyleIndex = 7 }));
            Assert.Equal(7, catalog.StyleIndex(null, null, new XlsxSourceColumn { StyleIndex = 7 }));
        }
        [Fact]
        public void ExplicitInheritanceThemeAndNonzeroNormalStyleAreResolved()
        {
            var source = XlsxOutputSourceReader.Read(XlsxOutputSourceTests.Package(), "Ventilation Schedule");
            var key = source.FormattingParts.Keys.Single(k => k.EndsWith("customStyles.xml"));
            // Build the test's explicit alternate Normal base without relying
            // on the source reader's particular whitespace serialization.
            var xml = System.Xml.Linq.XElement.Parse(source.FormattingParts[key]);var s = xml.Name.Namespace;
            xml.Add(new System.Xml.Linq.XElement(s + "cellStyles", new System.Xml.Linq.XElement(s + "cellStyle",
                new System.Xml.Linq.XAttribute("name", "Normal"), new System.Xml.Linq.XAttribute("builtinId", "0"), new System.Xml.Linq.XAttribute("xfId", "0"))));
            var font = xml.Element(s + "fonts")!.Elements(s + "font").Last();font.Element(s + "sz")!.SetAttributeValue("val", "12");font.Add(new System.Xml.Linq.XElement(s + "color", new System.Xml.Linq.XAttribute("theme", "1")));
            xml.Element(s + "cellStyleXfs")!.Elements().First().SetAttributeValue("fontId", "1");
            xml.Element(s + "cellXfs")!.Elements().First().SetAttributeValue("applyFont", "0");
            source.FormattingParts[key] = xml.ToString();
            source.FormattingParts.Add("xl/theme/test.xml", "<a:theme xmlns:a='http://schemas.openxmlformats.org/drawingml/2006/main'><a:themeElements><a:clrScheme><a:dk1><a:srgbClr val='112233'/></a:dk1><a:lt1><a:srgbClr val='FFFFFF'/></a:lt1></a:clrScheme></a:themeElements></a:theme>");
            var catalog = new XlsxTableStyles(source);Assert.Equal(12, catalog.NormalFontPoints);Assert.True(catalog.NormalFontBold);Assert.False(catalog.NormalFontItalic);
            var style = catalog.Read(0);Assert.Equal(12, style.FontPoints);Assert.True(style.Bold);Assert.Equal("#112233", style.Foreground);
        }
        [Fact]
        public void MissingStylesUnknownIdentitiesAndDtdCannotCreateAFalseDefaultPresentation()
        {
            Assert.Throws<InvalidOperationException>(() => new XlsxTableStyles(new XlsxOutputSourceManifest()));
            var source = XlsxOutputSourceReader.Read(XlsxOutputSourceTests.Package(), "Ventilation Schedule");
            Assert.Throws<InvalidOperationException>(() => new XlsxTableStyles(source).Read(99));
            source.FormattingParts.Clear();source.FormattingParts.Add("styles", "<!DOCTYPE a [<!ENTITY b SYSTEM 'file:///private'>]><a>&b;</a>");
            Assert.Throws<XmlException>(() => new XlsxTableStyles(source));
        }
        [Fact]
        public void DefaultHiddenRowsAndExplicitVisibleExceptionsSurviveSourceLayout()
        {
            var bytes = XlsxOutputSourceTests.Package("<row r='1'><c r='A1'><v>1</v></c></row><row r='2' hidden='0'><c r='A2'><v>2</v></c></row>", extra: "");
            using (var stream = new System.IO.MemoryStream())
            {
                stream.Write(bytes, 0, bytes.Length);stream.Position = 0;
                using (var zip = new System.IO.Compression.ZipArchive(stream, System.IO.Compression.ZipArchiveMode.Update, true))
                {
                    var entry = zip.GetEntry("xl/worksheets/output.xml")!;string xml;
                    using (var reader = new System.IO.StreamReader(entry.Open())) xml = reader.ReadToEnd();
                    entry.Delete();var replacement = zip.CreateEntry("xl/worksheets/output.xml");
                    using (var writer = new System.IO.StreamWriter(replacement.Open())) writer.Write(xml.Replace("defaultRowHeight='13.5'", "defaultRowHeight='13.5' zeroHeight='1'"));
                }
                var source = XlsxOutputSourceReader.Read(stream.ToArray(), "Ventilation Schedule");
                Assert.True(source.SelectedSheet!.DefaultRowsHidden);Assert.True(source.SelectedSheet.Rows[0].Hidden);Assert.False(source.SelectedSheet.Rows[1].Hidden);
                var plan = XlsxTableLayout.Plan(source, new XlsxTableLayoutOptions { MaximumDigitWidthPixels = 7 }, (_, __) => new XlsxTableTextMeasurement { WidthInches = .1, HeightInches = .1 });
                Assert.Equal("hidden_row", plan.Coverage.Single(c => c.Address == "A1").State);
                Assert.DoesNotContain(plan.Pages.SelectMany(p => p.PrimaryRows), r => r == 1 || r == 3);
                Assert.Contains(2, plan.Pages.Single().PrimaryRows);
            }
        }
        [Fact]
        public void ExplicitDefaultColumnWidthOverridesBaseWidthAndChangesGeometryWithoutShrinkingText()
        {
            var source = XlsxOutputSourceReader.Read(XlsxOutputSourceTests.Package("<row r='1'><c r='D1' t='inlineStr'><is><t>X</t></is></c></row>"), "Ventilation Schedule");
            var sheet = source.SelectedSheet!;sheet.Columns.Clear();sheet.BaseColumnWidthCharacters = 10;
            var options = new XlsxTableLayoutOptions { MaximumDigitWidthPixels = 7 };
            XlsxTableTextMeasurement Measure(XlsxTableCellFrame f, double w) => new XlsxTableTextMeasurement { WidthInches = .1, HeightInches = .1 };
            var plan = XlsxTableLayout.Plan(source, options, Measure);
            Assert.All(plan.Pages[0].Cells.Where(c => c.Range.FirstColumn == c.Range.LastColumn), c => Assert.Equal(75d / 96, c.WidthInches, 6));
            sheet.DefaultColumnWidthCharacters = 8.7109375;
            plan = XlsxTableLayout.Plan(source, options, Measure);Assert.All(plan.Pages[0].Cells.Where(c => c.Range.FirstColumn == c.Range.LastColumn), c => Assert.Equal(61d / 96, c.WidthInches, 6));
        }
    }
}
