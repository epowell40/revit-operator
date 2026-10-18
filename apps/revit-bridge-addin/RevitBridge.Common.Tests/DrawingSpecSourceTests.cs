using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class DrawingSpecSourceTests
    {
        private const string Ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        private static readonly XNamespace W = Ns;
        private const string Styles = "<w:style w:type='paragraph' w:styleId='Top'><w:pPr><w:numPr><w:numId w:val='1'/><w:ilvl w:val='0'/></w:numPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val='22'/></w:rPr></w:style>" +
            "<w:style w:type='paragraph' w:styleId='Child'><w:basedOn w:val='Top'/><w:pPr><w:numPr><w:ilvl w:val='1'/></w:numPr><w:ind w:left='720'/></w:pPr></w:style>" +
            "<w:style w:type='paragraph' w:styleId='Body'><w:basedOn w:val='Child'/><w:pPr><w:numPr><w:ilvl w:val='2'/></w:numPr></w:pPr></w:style>";
        private const string Numbering = "<w:abstractNum w:abstractNumId='1'>" +
            "<w:lvl w:ilvl='0'><w:start w:val='1'/><w:numFmt w:val='decimal'/><w:lvlText w:val='%1.'/></w:lvl>" +
            "<w:lvl w:ilvl='1'><w:start w:val='1'/><w:numFmt w:val='decimalZero'/><w:lvlText w:val='%1.%2'/></w:lvl>" +
            "<w:lvl w:ilvl='2'><w:start w:val='1'/><w:numFmt w:val='upperLetter'/><w:lvlText w:val='%3.'/><w:suff w:val='space'/></w:lvl>" +
            "</w:abstractNum><w:num w:numId='1'><w:abstractNumId w:val='1'/></w:num>";

        private static string P(string style, string text) => "<w:p><w:pPr><w:pStyle w:val='" + style + "'/></w:pPr><w:r><w:t>" + text + "</w:t></w:r></w:p>";
        private static byte[] Package(string body, string? styles = null, string? numbering = null, params (string, string)[] extra)
        {
            using (var stream = new MemoryStream())
            {
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, true))
                {
                    Write(zip, "word/document.xml", "<w:document xmlns:w='" + Ns + "'><w:body>" + body + "</w:body></w:document>");
                    if (styles != null) Write(zip, "word/styles.xml", "<w:styles xmlns:w='" + Ns + "'>" + styles + "</w:styles>");
                    if (numbering != null) Write(zip, "word/numbering.xml", "<w:numbering xmlns:w='" + Ns + "'>" + numbering + "</w:numbering>");
                    foreach (var (path, content) in extra) Write(zip, path, content);
                }
                return stream.ToArray();
            }
        }
        private static void Write(ZipArchive zip, string path, string xml)
        {
            using (var writer = new StreamWriter(zip.CreateEntry(path).Open(), new UTF8Encoding(false))) writer.Write(xml);
        }

        [Fact]
        public void ResolvesStyleInheritedMultilevelLabelsAndRestartsWithoutLosingBodyText()
        {
            var body = P("Top", "Section") + P("Child", "Part") + P("Body", "First") + P("Body", "Second") + P("Child", "Next part") + P("Body", "Restarted") + P("Top", "Next section") + P("Child", "Next part");
            var result = DocxDrawingSpecSourceReader.Read(Package(body, Styles, Numbering));
            Assert.True(result.BodyTextComplete);
            Assert.False(result.NativeLayoutQualified);
            Assert.Empty(result.Warnings);
            Assert.Equal(new[] { "1.", "1.01", "A.", "B.", "1.02", "A.", "2.", "2.01" }, result.Blocks.Select(b => b.NumberingMarker));
            Assert.Equal(new[] { "Section", "Part", "First", "Second", "Next part", "Restarted", "Next section", "Next part" }, result.Blocks.Select(b => b.Text));
            Assert.Equal(" ", result.Blocks[2].NumberingSuffix);
            Assert.Equal("720", (string?)XElement.Parse(result.Blocks[1].PropertiesXml).Element(W + "ind")?.Attribute(W + "left"));
            Assert.All(result.Blocks, b => Assert.Equal(64, b.ContentSha256.Length));
        }

        [Fact]
        public void ExplicitCancellationAndRunOverridesDoNotBleedIntoOtherParagraphs()
        {
            var body = "<w:p><w:pPr><w:pStyle w:val='Top'/><w:numPr><w:numId w:val='0'/></w:numPr></w:pPr>" +
                "<w:r><w:rPr><w:b w:val='0'/><w:u w:val='single'/></w:rPr><w:t xml:space='preserve'> Unnumbered </w:t><w:tab/><w:t>body</w:t><w:br/><w:t>continued</w:t></w:r></w:p>" + P("Top", "Actual first");
            var result = DocxDrawingSpecSourceReader.Read(Package(body, Styles, Numbering));
            Assert.Null(result.Blocks[0].NumberingMarker);
            Assert.Equal(" Unnumbered \tbody\ncontinued", result.Blocks[0].Text);
            Assert.Equal("0", DocxSourceVal(result.Blocks[0].Runs[0], "b"));
            Assert.Equal("1", DocxSourceVal(result.Blocks[1].Runs[0], "b"));
            Assert.Equal("1.", result.Blocks[1].NumberingMarker);
        }

        private static string? DocxSourceVal(DrawingSpecRun run, string name) => (string?)XElement.Parse(run.PropertiesXml).Element(W + name)?.Attribute(W + "val");

        [Fact]
        public void WordStyleTogglesAndAbsoluteDirectBoldAreDistinct()
        {
            var styles = Styles + "<w:style w:type='character' w:styleId='Toggle'><w:rPr><w:b/></w:rPr></w:style>";
            var body = "<w:p><w:pPr><w:pStyle w:val='Top'/></w:pPr><w:r><w:rPr><w:rStyle w:val='Toggle'/></w:rPr><w:t>not bold</w:t></w:r>" +
                "<w:r><w:rPr><w:rStyle w:val='Toggle'/><w:b/></w:rPr><w:t>bold</w:t></w:r></w:p>";
            var result = DocxDrawingSpecSourceReader.Read(Package(body, styles, Numbering));
            Assert.Equal("0", DocxSourceVal(result.Blocks[0].Runs[0], "b"));
            Assert.Equal("1", DocxSourceVal(result.Blocks[0].Runs[1], "b"));
        }

        [Fact]
        public void StartOverridesAndNeverRestartListsAreIndependent()
        {
            var numbering = Numbering.Replace("<w:numFmt w:val='upperLetter'/>", "<w:numFmt w:val='upperLetter'/><w:lvlRestart w:val='0'/>") +
                "<w:num w:numId='2'><w:abstractNumId w:val='1'/><w:lvlOverride w:ilvl='0'><w:startOverride w:val='5'/></w:lvlOverride></w:num>";
            var body = P("Top", "Section") + P("Body", "First") + P("Child", "Part") + P("Body", "Never restart") +
                "<w:p><w:pPr><w:numPr><w:numId w:val='2'/></w:numPr></w:pPr><w:r><w:t>Independent</w:t></w:r></w:p>";
            var result = DocxDrawingSpecSourceReader.Read(Package(body, Styles, numbering));
            Assert.Equal(new[] { "1.", "A.", "1.01", "B.", "5." }, result.Blocks.Select(b => b.NumberingMarker));
        }

        [Fact]
        public void TablesAndRunningMatterAreRetainedInOrderWithoutPretendingTheyArePlaced()
        {
            var body = "<w:p><w:r><w:t>Before</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p><w:sectPr><w:cols w:num='2'/></w:sectPr>";
            var result = DocxDrawingSpecSourceReader.Read(Package(body, extra: new[] { ("word/footer1.xml", "<w:ftr xmlns:w='" + Ns + "'><w:p><w:r><w:t>Running footer</w:t></w:r></w:p></w:ftr>") }));
            Assert.Equal(new[] { "paragraph", "table", "paragraph", "section_properties" }, result.Blocks.Select(b => b.Kind));
            Assert.Equal("Cell", result.Blocks[1].Children[0].Children[0].Children[0].Text);
            Assert.DoesNotContain(result.Blocks, b => b.Text.Contains("Running footer"));
            Assert.Contains(result.Parts, p => p.Path == "word/footer1.xml" && p.Xml!.Contains("Running footer"));
            Assert.Contains(result.Warnings, w => w.Code == "running_matter_retained_separately");
            Assert.Contains(result.Warnings, w => w.Code == "table_requires_layout");
        }

        [Fact]
        public void LongTextIsNeverSilentlyClippedAtTheLegacy300000CharacterCap()
        {
            var text = new string('x', 310000) + " REQUIRED FINAL CLAUSE";
            var result = DocxDrawingSpecSourceReader.Read(Package("<w:p><w:r><w:t>" + text + "</w:t></w:r></w:p>"));
            Assert.Equal(text, result.Blocks.Single().Text);
            Assert.True(result.BodyTextComplete);
        }

        [Fact]
        public void UnsupportedObjectsAndBrokenNumberingHaveExplicitIncompleteCoverage()
        {
            var body = P("Top", "Missing list") + "<w:p><w:r><w:drawing/></w:r></w:p>";
            var result = DocxDrawingSpecSourceReader.Read(Package(body, Styles));
            Assert.False(result.BodyTextComplete);
            Assert.Null(result.Blocks[0].NumberingMarker);
            Assert.Contains(result.Warnings, w => w.Code == "numbering_unresolved");
            Assert.Contains(result.Warnings, w => w.Code == "unsupported_run_content:drawing");
        }

        [Fact]
        public void UnknownParagraphContainersCannotTurnAnEmptyExtractionIntoACompleteClaim()
        {
            var result = DocxDrawingSpecSourceReader.Read(Package("<w:p><w:altChunk/></w:p>"));
            Assert.False(result.BodyTextComplete);
            Assert.Contains(result.Warnings, w => w.Code == "unsupported_paragraph_structure:altChunk");
        }

        [Fact]
        public void DefaultSeparatorPartsDoNotInventMissingFootnotes()
        {
            var separators = "<w:footnotes xmlns:w='" + Ns + "'><w:footnote w:type='separator' w:id='-1'/><w:footnote w:type='continuationSeparator' w:id='0'/></w:footnotes>";
            var result = DocxDrawingSpecSourceReader.Read(Package("<w:p/>", extra: new[] { ("word/footnotes.xml", separators) }));
            Assert.DoesNotContain(result.Warnings, w => w.Code == "notes_require_placement_policy");
            Assert.Contains(result.Parts, p => p.Path == "word/footnotes.xml");
        }

        [Fact]
        public void CyclicStyleInheritanceDuplicatePartsAndExternalEntitiesAreRejected()
        {
            var styles = "<w:style w:styleId='Loop'><w:basedOn w:val='Loop'/></w:style>";
            Assert.Throws<InvalidOperationException>(() => DocxDrawingSpecSourceReader.Read(Package(P("Loop", "unsafe"), styles)));
            Assert.Throws<InvalidOperationException>(() => DocxDrawingSpecSourceReader.Read(Package("", extra: new[] { ("word/document.xml", "duplicate") })));
            Assert.Throws<XmlException>(() => DocxDrawingSpecSourceReader.Read(Package("", extra: new[] { ("word/styles.xml", "<!DOCTYPE doc [<!ENTITY external SYSTEM 'file:///not-readable'>]><doc>&external;</doc>") })));
        }
    }
}
