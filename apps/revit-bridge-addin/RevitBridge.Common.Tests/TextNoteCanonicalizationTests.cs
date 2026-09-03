using RevitBridge.Common;
using System;
using System.IO;
using System.Text.Json;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TextNoteCanonicalizationTests
    {
        [Fact]
        public void Shared_backend_native_round_trip_vectors_remain_identical()
        {
            using var document = JsonDocument.Parse(File.ReadAllText(FindSharedVectorPath()));
            Assert.Equal("revit-operator.text-note-round-trip/v1", document.RootElement.GetProperty("schema").GetString());
            foreach (var vector in document.RootElement.GetProperty("vectors").EnumerateArray())
            {
                var requested = vector.GetProperty("requested").GetString() ?? "";
                var actual = vector.GetProperty("actual").GetString() ?? "";
                var expected = vector.GetProperty("matches").GetBoolean();
                Assert.Equal(expected, TextNoteTextCanonicalizer.IsExactRevitRoundTrip(requested, actual));
            }
        }

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

        private static string FindSharedVectorPath()
        {
            var cursor = new DirectoryInfo(AppContext.BaseDirectory);
            while (cursor != null)
            {
                var direct = Path.Combine(cursor.FullName, "packages", "text-note-round-trip-v1", "golden-vectors.json");
                if (File.Exists(direct)) return direct;
                var nested = Path.Combine(cursor.FullName, "public", "packages", "text-note-round-trip-v1", "golden-vectors.json");
                if (File.Exists(nested)) return nested;
                cursor = cursor.Parent;
            }
            throw new FileNotFoundException("Shared TextNote round-trip vectors were not found.");
        }
    }
}
