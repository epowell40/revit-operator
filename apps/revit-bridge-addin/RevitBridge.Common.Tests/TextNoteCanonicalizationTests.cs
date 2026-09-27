using RevitBridge.Common;
using System;
using System.IO;
using System.Text.Json;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TextNoteCanonicalizationTests
    {
        [Theory]
        [InlineData(500)]
        [InlineData(584)]
        [InlineData(16_384)]
        public void Replacement_text_limits_accept_full_in_limit_fields_without_rewriting(int length)
        {
            var value = new string('X', length);
            TextNoteTextCanonicalizer.ValidateRequestTextLengths(value, value);
            var json = JsonSerializer.Serialize(new { textNoteId = 42, familyDocumentId = "session", newText = value, expectedOldText = value });
            TextNoteTextCanonicalizer.ValidateReplacementRequestTextLengths(json);
            using var document = JsonDocument.Parse(json);
            Assert.Equal(value, document.RootElement.GetProperty("newText").GetString());
            Assert.Equal(value, document.RootElement.GetProperty("expectedOldText").GetString());
        }

        [Theory]
        [InlineData("newText")]
        [InlineData("expectedOldText")]
        public void Oversized_replacement_fields_fail_at_both_pure_boundaries_before_dispatch(string field)
        {
            var oversized = new string('X', 16_385);
            var next = field == "newText" ? oversized : "replacement";
            var old = field == "expectedOldText" ? oversized : "prior";
            var error = Assert.Throws<ArgumentException>(() => TextNoteTextCanonicalizer.ValidateRequestTextLengths(next, old));
            Assert.Equal(field, error.ParamName);
            var json = JsonSerializer.Serialize(new { textNoteId = 42, familyDocumentId = "session", newText = next, expectedOldText = old, apply = true, confirm = "APPLY 1 TEXT NOTE CHANGE" });
            var dispatched = false;
            error = Assert.Throws<ArgumentException>(() =>
            {
                TextNoteTextCanonicalizer.ValidateReplacementRequestTextLengths(json);
                dispatched = true;
            });
            Assert.Equal(field, error.ParamName);
            Assert.False(dispatched);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData(" \t\r\n")]
        public void Length_guard_preserves_legacy_null_empty_and_whitespace_text(string? value)
        {
            TextNoteTextCanonicalizer.ValidateRequestTextLengths(value, value);
            TextNoteTextCanonicalizer.ValidateReplacementRequestTextLengths(JsonSerializer.Serialize(new { newText = value, expectedOldText = value }));
        }

        [Theory]
        [InlineData("{\"textNoteId\":42,\"familyDocumentId\":\"session\",\"newText\":\"text\"}")]
        [InlineData("{\"elementId\":42,\"docId\":\"session\",\"newText\":\"text\"}")]
        [InlineData("{\"elementId\":43,\"textNoteId\":42,\"familyDocumentId\":\"session\",\"newText\":\"text\"}")]
        [InlineData("{\"newText\":null,\"expectedOldText\":null,\"apply\":true,\"confirm\":\"unchanged legacy confirmation handling\"}")]
        [InlineData("{\"newText\":17,\"expectedOldText\":false}")]
        [InlineData("{}")]
        [InlineData("null")]
        [InlineData("")]
        public void Request_length_guard_does_not_replace_handler_schema_or_confirmation(string json)
        {
            TextNoteTextCanonicalizer.ValidateReplacementRequestTextLengths(json);
        }

        [Fact]
        public void Length_guard_ignores_unrelated_fields_and_counts_raw_utf16_without_trimming()
        {
            TextNoteTextCanonicalizer.ValidateReplacementRequestTextLengths(JsonSerializer.Serialize(new { newText = "ok", unrelated = new string('X', 16_385) }));
            Assert.Throws<ArgumentException>(() => TextNoteTextCanonicalizer.ValidateRequestTextLengths(new string(' ', 16_385), null));
            Assert.Throws<ArgumentException>(() => TextNoteTextCanonicalizer.ValidateRequestTextLengths(new string('X', 16_383) + "\U0001F600", null));
            Assert.Throws<ArgumentException>(() => TextNoteTextCanonicalizer.ValidateReplacementRequestTextLengths("{\"newText\":\"" + new string('X', 16_384) + "\\u0058\"}"));
        }

        [Fact]
        public void Full_limit_terminal_paragraph_roundtrip_does_not_silently_expand_request_allowance()
        {
            var text = new string('X', 16_384);
            Assert.True(TextNoteTextCanonicalizer.IsExactRevitRoundTrip(text, text + "\r"));
            Assert.Throws<ArgumentException>(() => TextNoteTextCanonicalizer.ValidateRequestTextLengths("next", text + "\r"));
        }

        [Fact]
        public void Direct_replacement_and_shared_handler_guard_lengths_before_native_access()
        {
            var server = ReadNativeSource("RevitBridge/Server/RevitHttpServer.cs");
            var guard = server.IndexOf("TextNoteTextCanonicalizer.ValidateReplacementRequestTextLengths(body)", StringComparison.Ordinal);
            var queue = server.IndexOf("result = await _eventService.Run(", StringComparison.Ordinal);
            Assert.True(guard >= 0 && guard < queue, "The direct text limit must run before the native queue.");
            Assert.Contains("if (string.Equals(path, \"/revit/replace-text-note\", StringComparison.OrdinalIgnoreCase))", server);

            var handler = ReadNativeSource("RevitBridge.Logic/Handlers/Families/SetTextNoteTextHandler.cs");
            var handlerGuard = handler.IndexOf("TextNoteTextCanonicalizer.ValidateRequestTextLengths(p.newText, p.expectedOldText)", StringComparison.Ordinal);
            Assert.True(handlerGuard >= 0 && handlerGuard < handler.IndexOf("Document targetDoc;", StringComparison.Ordinal));
            Assert.True(handlerGuard < handler.IndexOf("new Transaction(", StringComparison.Ordinal));
        }

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

        private static string ReadNativeSource(string relative)
        {
            for (var cursor = new DirectoryInfo(AppContext.BaseDirectory); cursor != null; cursor = cursor.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(cursor.FullName, prefix, relative);
                    if (File.Exists(file)) return File.ReadAllText(file);
                }
            throw new FileNotFoundException(relative);
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
