using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class TemporaryDocumentInspectionTests
    {
        private sealed class Document { public bool Valid = true; public string Text = "retained edit"; }

        [Fact]
        public void ExistingEditorIsNeitherInspectedNorClosed()
        {
            var editor = new Document();
            var inspected = false; var closed = false;
            Assert.Throws<InvalidOperationException>(() => TemporaryDocumentInspection.Run(
                new[] { editor }, () => editor, doc => { inspected = true; return doc.Text; },
                doc => { closed = true; doc.Valid = false; return true; }, doc => doc.Valid));
            Assert.False(inspected); Assert.False(closed); Assert.True(editor.Valid);
            Assert.Equal("retained edit", editor.Text);
        }

        [Fact]
        public void SuccessRequiresOwnedDocumentClosure()
        {
            var editor = new Document(); var temporary = new Document();
            var result = TemporaryDocumentInspection.Run(new[] { editor }, () => temporary,
                doc => doc.Text, doc => { doc.Valid = false; return true; }, doc => doc.Valid);
            Assert.Equal("retained edit", result); Assert.False(temporary.Valid); Assert.True(editor.Valid);
        }

        [Fact]
        public void InspectionFailureStillClosesOnlyTemporaryDocument()
        {
            var temporary = new Document(); var closed = 0;
            Assert.Throws<ArgumentException>(() => TemporaryDocumentInspection.Run<Document, string>(
                Array.Empty<Document>(), () => temporary, doc => throw new ArgumentException("read failed"),
                doc => { closed++; doc.Valid = false; return true; }, doc => doc.Valid));
            Assert.Equal(1, closed); Assert.False(temporary.Valid);
        }

        [Theory]
        [InlineData(false, false)]
        [InlineData(true, true)]
        public void UnconfirmedCloseCannotReturnSuccessfulRead(bool closeResult, bool remainsValid)
        {
            var temporary = new Document();
            Assert.Throws<InvalidOperationException>(() => TemporaryDocumentInspection.Run(
                Array.Empty<Document>(), () => temporary, doc => "success must not escape",
                doc => { doc.Valid = remainsValid; return closeResult; }, doc => doc.Valid));
        }

        [Fact]
        public void OpenFailureDoesNotCloseOtherDocuments()
        {
            var editor = new Document(); var closed = false;
            Assert.Throws<ArgumentException>(() => TemporaryDocumentInspection.Run<Document, string>(
                new[] { editor }, () => throw new ArgumentException("open failed"), doc => doc.Text,
                doc => { closed = true; return true; }, doc => doc.Valid));
            Assert.False(closed); Assert.True(editor.Valid);
        }
    }
}
