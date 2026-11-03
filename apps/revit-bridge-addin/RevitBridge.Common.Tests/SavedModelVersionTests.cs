using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class SavedModelVersionTests : IDisposable
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "operator-model-version-" + Guid.NewGuid().ToString("N"));
        private string Output => Path.Combine(root, "result.rvt");
        private OperatorNativeSaveDocumentIdentity Identity(string path) => new OperatorNativeSaveDocumentIdentity("session", new string('a', 64), path);
        private OperatorNativeSaveAsResult Execute(bool preview, Action save, Func<OperatorNativeSaveDocumentIdentity> read, Func<string?> version)
        {
            // Exercise the old producer too: absence of the optional native
            // callback must fail the positive behavioral assertion, not build.
            var extended = typeof(OperatorNativeSaveAsExecution).GetMethods().SingleOrDefault(m => m.Name == "Execute" && m.GetParameters().Length == 6);
            if (extended != null) return (OperatorNativeSaveAsResult)extended.Invoke(null, new object[] { Output, preview, false, read, save, version })!;
            return OperatorNativeSaveAsExecution.Execute(Output, preview, false, read, save);
        }
        private static bool HasVersion(OperatorNativeSaveAsResult r, out string? value)
        {
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(r.Receipt));
            var found = json.RootElement.TryGetProperty("saved_revit_version", out var field);
            value = found ? field.GetString() : null;
            return found;
        }
        [Fact]
        public void SuccessfulSaveRetainsActualProducingVersionAfterTheNativeSaveReturned()
        {
            var saved = false; var calls = 0;
            var result = Execute(false, () => { File.WriteAllText(Output, "native saved bytes"); saved = true; },
                () => Identity(saved ? Output : ""), () => { Assert.True(saved); calls++; return "2024"; });
            Assert.True(result.Ok, result.Error); Assert.True(HasVersion(result, out var year)); Assert.Equal("2024", year); Assert.Equal(1, calls);
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(new { artifact_receipt = result.Receipt }, "apply", "POST", "/revit/save-as").EffectState);
        }
        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void PreviewAndFailedSaveCannotSupplyVersionMetadata(bool preview)
        {
            var calls = 0;
            var result = Execute(preview, () => throw new IOException("native save failed"), () => Identity(""), () => { calls++; return "2024"; });
            Assert.False(HasVersion(result, out _)); Assert.Equal(0, calls);
        }
        [Theory]
        [InlineData("2024.3")]
        [InlineData("2024\n")]
        [InlineData("C:\\run.exe")]
        [InlineData("9999")]
        [InlineData(null)]
        public void UnavailableOrMalformedVersionDoesNotChangeSuccessfulSaveSettlement(string? year)
        {
            var saved = false;
            var result = Execute(false, () => { File.WriteAllText(Output, "saved"); saved = true; }, () => Identity(saved ? Output : ""), () => year);
            Assert.True(result.Ok); Assert.False(HasVersion(result, out _));
        }
        [Fact]
        public void MetadataGetterFailureDoesNotHideAnAlreadySuccessfulSave()
        {
            var saved = false;
            var result = Execute(false, () => { File.WriteAllText(Output, "saved"); saved = true; }, () => Identity(saved ? Output : ""), () => throw new InvalidOperationException("version unavailable"));
            Assert.True(result.Ok); Assert.False(HasVersion(result, out _));
        }
        [Fact]
        public void ActualHandlerUsesApplicationVersionAndAddsNoCallerVersionParameter()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory); string? source = null;
            for (; directory != null && source == null; directory = directory.Parent)
                foreach (var prefix in new[] { "", "revit-bridge-addin", "apps/revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, "RevitBridge/Handlers/SaveAsModelHandler.cs");
                    if (File.Exists(file)) { source = File.ReadAllText(file); break; }
                }
            Assert.NotNull(source); Assert.Contains("() => app.Application.VersionNumber", source);
            Assert.DoesNotContain("p.saved_revit_version", source); Assert.DoesNotContain("p.revitVersion", source);
        }
        public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
}
