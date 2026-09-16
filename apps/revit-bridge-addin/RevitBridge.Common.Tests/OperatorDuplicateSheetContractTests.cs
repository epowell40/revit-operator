using System;
using System.Linq;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorDuplicateSheetContractTests
    {
        [Fact]
        public void BundledSheetExamplesUseOnlyPublishedNativeFieldsAndSupportedOptions()
        {
            var current = new DirectoryInfo(AppContext.BaseDirectory);
            string? examplesPath = null;
            while (current != null && examplesPath == null)
            {
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var candidate = Path.Combine(current.FullName, prefix, "RevitBridge/Tooling/tool_examples.json");
                    if (File.Exists(candidate)) { examplesPath = candidate; break; }
                }
                current = current.Parent;
            }
            Assert.NotNull(examplesPath);
            using var catalog = JsonDocument.Parse(File.ReadAllText(examplesPath!));
            var sheet = catalog.RootElement.GetProperty("tools").EnumerateArray()
                .Single(entry => entry.GetProperty("path").GetString() == "/revit/duplicate-sheet");
            var fields = OperatorDuplicateSheetContract.RequestSchema().GetProperty("properties");
            var examples = sheet.GetProperty("examples").EnumerateArray().ToArray();
            Assert.True(examples.Length >= 2);
            foreach (var example in examples)
            {
                var request = example.GetProperty("request");
                foreach (var property in request.EnumerateObject()) Assert.True(fields.TryGetProperty(property.Name, out _), property.Name);
                Assert.Equal("DuplicateSheetWithViewsAndDetailing", OperatorDuplicateSheetContract.ResolveOptionName(request.GetProperty("option").GetString()));
                Assert.Equal("M000-COPY", request.GetProperty("newNumber").GetString());
            }
        }

        [Fact]
        public void PublishedSheetOptionsAllResolveAndUnsupportedLiveOptionIsRejected()
        {
            var schema = OperatorDuplicateSheetContract.RequestSchema();
            Assert.Empty(schema.GetProperty("required").EnumerateArray());
            Assert.Equal(new[] { "sourceSheetId", "sourceSheetNumber", "sourceQuery" },
                schema.GetProperty("oneOf").EnumerateArray().Select(x => x.GetProperty("required")[0].GetString()));
            var options = schema.GetProperty("properties").GetProperty("option").GetProperty("enum").EnumerateArray().Select(x => x.GetString()).ToArray();
            Assert.Equal(5, options.Length);
            Assert.Equal(new[] { "DuplicateEmptySheet", "DuplicateSheetWithDetailing", "DuplicateSheetWithViewsOnly", "DuplicateSheetWithViewsAndDetailing", "DuplicateSheetWithViewsAsDependent" },
                options.Select(OperatorDuplicateSheetContract.ResolveOptionName));
            Assert.Equal("DuplicateSheetWithViewsAndDetailing", OperatorDuplicateSheetContract.ResolveOptionName(null));
            Assert.Throws<InvalidOperationException>(() => OperatorDuplicateSheetContract.ResolveOptionName("withViewsAndDetailing"));
        }

        [Fact]
        public void KnownPreTransactionRejectionDoesNotEraseUnknownHistoricalHttpFailure()
        {
            var known = new { success = false, ok = false, applied = false, verified = false,
                error = "duplicate-sheet.option is invalid", transaction = OperatorNativeTransactionReceipt.NotStarted() };
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(known, "apply", "POST", "/revit/duplicate-sheet").EffectState);
            var historical = new { error = "option must be empty, detailing, views_only, views_and_detailing, or views_as_dependent.",
                type = "System.InvalidOperationException", request_dispatched = true, outcome_unknown = true };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(historical, "apply", "POST", "/revit/duplicate-sheet").EffectState);
        }
    }
}
