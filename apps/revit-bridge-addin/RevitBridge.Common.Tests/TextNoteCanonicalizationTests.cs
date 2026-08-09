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

        [Theory]
        [InlineData("one", "one")]
        [InlineData("one", "one\r")]
        [InlineData("one\n", "one\r\r")]
        [InlineData("one\ntwo\n", "one\rtwo\r\r")]
        public void Exact_revit_round_trip_accepts_only_the_terminal_paragraph_marker(string requested, string actual)
        {
            Assert.True(TextNoteTextCanonicalizer.IsExactRevitRoundTrip(requested, actual));
        }

        [Theory]
        [InlineData("one", "one\r\r")]
        [InlineData("one\n", "one\r\r\r")]
        [InlineData("one\ntwo", "one\rsubstituted\r")]
        [InlineData("one\ntwo", "one\rtwo \r")]
        public void Exact_revit_round_trip_rejects_other_substitutions(string requested, string actual)
        {
            Assert.False(TextNoteTextCanonicalizer.IsExactRevitRoundTrip(requested, actual));
        }
    }
}
