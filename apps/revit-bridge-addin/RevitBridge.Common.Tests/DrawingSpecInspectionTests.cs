using System;
using System.Collections.Generic;
using System.Linq;
using System.Xml.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class DrawingSpecInspectionTests
    {
        private static DrawingSpecRichParagraph Paragraph(string text = "A\t B")
        {
            XNamespace w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
            var b = new DrawingSpecBlock { Kind = "paragraph", SourcePath = "body/0", Text = text,
                PropertiesXml = new XElement(w + "pPr").ToString() };
            b.Runs.Add(new DrawingSpecRun { Text = text, PropertiesXml = new XElement(w + "rPr").ToString() });
            return DrawingSpecRichParagraph.Build(b, "Synthetic", 12);
        }
        private static DrawingSpecInspectionSegment Segment(int start, int length, string kind = "text", long id = 1) =>
            new DrawingSpecInspectionSegment { SourceId = "body/0", Start = start, Length = length, Kind = kind, NoteId = id, UniqueId = "note-" + id, ViewId = 10 };
        private static DrawingSpecObservedNote Note(long id, string text, double x) => new DrawingSpecObservedNote {
            Id = id, UniqueId = "note-" + id, OwnerViewId = 10, Text = text + "\r", Font = "Synthetic", TextSizeFt = 12d / 864,
            WidthScale = 1, Background = 1, Page = 0, XPaperInches = x, WidthPaperInches = .1, HeightPaperInches = .2,
            Ranges = new List<DrawingSpecObservedRange> { new DrawingSpecObservedRange { Start = 0, Length = text.Length, Text = text,
                Bold = "None", Italic = "None", Underline = "None", AllCaps = "None", Superscript = "None", Subscript = "None" } } };
        private static DrawingSpecInspectionResult Check(Action<List<DrawingSpecInspectionSegment>, List<DrawingSpecObservedNote>>? edit = null, bool geometry = true)
        {
            var segments = new List<DrawingSpecInspectionSegment> { Segment(0, 1), Segment(1, 1, "tab"), Segment(2, 1, "space"), Segment(3, 1, id: 2) };
            var notes = new List<DrawingSpecObservedNote> { Note(1, "A", 0), Note(2, "B", .5) };
            edit?.Invoke(segments, notes);
            return DrawingSpecInspection.Check(new[] { Paragraph() }, segments, notes, s => s.PointSize / 864,
                geometry ? new DrawingSpecFlowGeometry { Columns = 1, ColumnWidthInches = 1, ColumnHeightInches = 2, GutterInches = .1 } : null);
        }
        [Fact]
        public void ChecksExactSourceUnitsAndNativeRangesWithoutClaimingVisualOrSheetCompletion()
        {
            var r = Check();
            Assert.True(r.SourceCoverageMatches); Assert.True(r.NativeTextMatches); Assert.True(r.SourceFormattingMatches);
            Assert.True(r.NativeIdentityAndOwnershipMatches); Assert.True(r.InsideColumnBounds); Assert.True(r.ReadingOrderMatches);
            Assert.Equal(4, r.SourceCharacters); Assert.Equal(2, r.NativeRanges); Assert.Empty(r.Issues);
            Assert.False(r.VisualFidelityVerified); Assert.False(r.SheetPlacementVerified); Assert.False(r.WholeTaskVerified);
        }
        [Fact]
        public void DoesNotNormalizeAwayMissingWhitespaceOrTreatRealTextAsLayout()
        {
            var r = Check((s, n) => { s[0].Kind = "space"; });
            Assert.False(r.SourceCoverageMatches);
            Assert.Contains(r.Issues, i => i.Code == "non_whitespace_hidden_as_layout");
            var text = Check((s, n) => n[0].Text = "A \r");
            Assert.False(text.NativeTextMatches);
        }
        [Fact]
        public void DeletedNoteReplacedIdentityAndOmittedSourceTailRemainFailures()
        {
            Assert.False(Check((s, n) => n.RemoveAt(1)).NativeTextMatches);
            Assert.False(Check((s, n) => n[0].UniqueId = "replacement").NativeIdentityAndOwnershipMatches);
            Assert.False(Check((s, n) => s.RemoveAt(3)).SourceCoverageMatches);
            Assert.False(Check((s, n) => s.Add(Segment(3, 1, id: 2))).NativeIdentityAndOwnershipMatches);
        }
        [Fact]
        public void MixedFormattingWrongPhysicalSizeOrTypeOverridesCannotPass()
        {
            Assert.False(Check((s, n) => n[0].Ranges[0].Bold = "Mixed").SourceFormattingMatches);
            Assert.False(Check((s, n) => n[0].Ranges[0].Underline = "All").SourceFormattingMatches);
            Assert.False(Check((s, n) => n[0].TextSizeFt *= 1.5).SourceFormattingMatches);
            Assert.False(Check((s, n) => n[0].TypeBold = true).SourceFormattingMatches);
            Assert.False(Check((s, n) => n[0].Color = 255).SourceFormattingMatches);
            Assert.False(Check((s, n) => n[0].Ranges.Clear()).SourceFormattingMatches);
        }
        [Fact]
        public void GeometryScreensFindOverflowAndReversedReadingOrderButLegacyBoundsStayUnknown()
        {
            Assert.False(Check((s, n) => n[1].XPaperInches = .99).InsideColumnBounds);
            Assert.False(Check((s, n) => { n[0].XPaperInches = .5; n[1].XPaperInches = 0; }).ReadingOrderMatches);
            Assert.Null(Check(geometry: false).InsideColumnBounds); Assert.Null(Check(geometry: false).ReadingOrderMatches);
        }
        [Fact]
        public void NonfiniteExpectedFontMetricCannotMakeVerificationPass()
        {
            var r = DrawingSpecInspection.Check(new[] { Paragraph("A") }, new[] { Segment(0, 1) }, new[] { Note(1, "A", 0) }, _ => double.NaN);
            Assert.False(r.SourceFormattingMatches);
        }
        [Theory]
        [InlineData("{}")]
        [InlineData("{\"sourcePath\":\"a.docx\",\"manifestElementId\":0}")]
        [InlineData("{\"sourcePath\":\"a.docx\",\"manifestElementId\":1,\"pageSize\":101}")]
        [InlineData("{\"sourcePath\":\"a.docx\",\"manifestElementId\":1,\"pageOffset\":-1}")]
        [InlineData("{\"sourcePath\":\"a.docx\",\"manifestElementId\":1,\"apply\":true}")]
        [InlineData("{\"sourcePath\":\"a.docx\",\"manifestElementId\":1,\"sourcePath\":\"b.docx\"}")]
        [InlineData("{\"sourcePath\":\"a.docx\",\"manifestElementId\":1,\"expectedSnapshotSha256\":\"guess\"}")]
        public void InvalidInspectionRequestsNeverBecomeActions(string json) => Assert.ThrowsAny<Exception>(() => DrawingSpecInspectionRequest.Parse(json));
        [Fact]
        public void BoundedSourceReadWithOptimisticSnapshotIsAccepted()
        {
            var p = DrawingSpecInspectionRequest.Parse("{\"sourcePath\":\"spec.docx\",\"manifestElementId\":5,\"pageOffset\":20,\"pageSize\":10,\"expectedSnapshotSha256\":\"" + new string('a',64) + "\"}");
            Assert.Equal(20, p.pageOffset); Assert.Equal(10, p.pageSize);
        }
    }
}
