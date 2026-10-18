using System;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class XlsxTableTextTests
    {
        private const string Namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
        private static XlsxTableCellFrame Cell(string text, string? rich = null) => new XlsxTableCellFrame
        {
            Address = "M3", Text = text, SourceRichTextXml = rich, MinimumTextPoints = 6.75, RenderFontPoints = 10,
            Style = new XlsxTableCellStyle { FontFamily = "Arial", FontPoints = 10, Bold = true, Foreground = "#112233" }
        };
        [Fact]
        public void PlainNumericAndErrorCellsKeepDisplayedTextAndSourceTypography()
        {
            foreach (var text in new[] { "12.3%", "0.0", "#REF!", "Room\nName" })
            {
                var paragraph = XlsxTableText.Paragraph(Cell(text));
                Assert.Equal(text, paragraph.SourceText);Assert.Equal(text.Replace('\n', '\v'), paragraph.NativeText);
                var style = Assert.Single(paragraph.Spans).Style;
                Assert.Equal("Arial", style.FontFamily);Assert.Equal(10, style.PointSize);Assert.Equal("112233", style.Color);Assert.True(style.Bold);
            }
        }
        [Fact]
        public void SourceSuperscriptAndExplicitRunOverridesRemainNativeCharacterRanges()
        {
            var cell = Cell("CFM/ft2", "<si xmlns='" + Namespace + "'><r><t>CFM/ft</t></r><r><rPr><vertAlign val='superscript'/><b val='0'/><sz val='8'/><rFont val='Arial'/><family val='2'/></rPr><t>2</t></r></si>");
            var paragraph = XlsxTableText.Paragraph(cell);Assert.Equal("CFM/ft2", paragraph.NativeText);
            Assert.True(paragraph.Spans[0].Style.Bold);Assert.False(paragraph.Spans[1].Style.Bold);
            Assert.Equal("superscript", paragraph.Spans[1].Style.VerticalAlignment);Assert.Equal(8, paragraph.Spans[1].Style.PointSize);
            Assert.Equal(6, paragraph.Spans[1].Start);Assert.Equal(1, paragraph.Spans[1].Length);
            cell.MinimumTextPoints = 12;cell.RenderFontPoints = 12;
            Assert.All(XlsxTableText.Paragraph(cell).Spans, span => Assert.Equal(12, span.Style.PointSize));
        }
        [Theory]
        [InlineData("<strike/>")]
        [InlineData("<u val='double'/>")]
        [InlineData("<color theme='1'/>")]
        [InlineData("<color rgb='80112233'/>")]
        [InlineData("<vertAlign val='other'/>")]
        [InlineData("<sz val='NaN'/>")]
        public void UnsupportedRichFormattingIsNotSilentlyFlattened(string properties)
        {
            var cell = Cell("X", "<is xmlns='" + Namespace + "'><r><rPr>" + properties + "</rPr><t>X</t></r></is>");
            Assert.Throws<InvalidOperationException>(() => XlsxTableText.Paragraph(cell));
        }
        [Fact]
        public void RichSourceTextMismatchAndDtdAreRefused()
        {
            Assert.Throws<InvalidOperationException>(() => XlsxTableText.Paragraph(Cell("X", "<si xmlns='" + Namespace + "'><r><t>Y</t></r></si>")));
            Assert.Throws<System.Xml.XmlException>(() => XlsxTableText.Paragraph(Cell("X", "<!DOCTYPE x [<!ENTITY a SYSTEM 'file:///private'>]><x>&a;</x>")));
            var paragraph = XlsxTableText.Paragraph(Cell("XY", "<si xmlns='" + Namespace + "'><r><t>X</t></r><r><rPr><rFont val='Courier New'/></rPr><t>Y</t></r></si>"));
            Assert.True(paragraph.RequiresInlineTextFragments); // The native adapter must allocate fragments or refuse; never flatten.
        }
        [Fact]
        public void InvalidBooleanAndDecimalUnderflowCannotBecomePlausibleFalseOrZero()
        {
            var invalid = XlsxCellDisplay.Format(new XlsxSourceCell { DataType = "b", RawValue = "2", Text = "2" }, "General");
            Assert.False(invalid.Supported);Assert.Equal("2", invalid.Text);
            var tiny = XlsxCellDisplay.Format(new XlsxSourceCell { DataType = "n", RawValue = "1E-40", Text = "1E-40" }, "General");
            Assert.False(tiny.Supported);Assert.Equal("1E-40", tiny.Text);
        }
    }
}
