using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TextNoteCanonicalizationTests
    {
        [Theory]
        [InlineData("line\r", "line\n")]
        [InlineData("line\r\nnext", "line\nnext")]
        [InlineData("line\\r\\nnext", "line\nnext")]
        [InlineData("line\\nnext", "line\nnext")]
        public void Stale_state_text_uses_one_canonical_line_ending(string input, string expected)
        {
            Assert.Equal(expected, TextNoteTextCanonicalizer.Normalize(input));
        }
    }
}
