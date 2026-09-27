using System;
using System.IO;
using System.Text.Json;
using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class SaveAsArtifactReceiptTests : IDisposable
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "operator-save-as-" + Guid.NewGuid().ToString("N"));
        private string Output => Path.Combine(root, "draft.rvt");
        private OperatorNativeSaveDocumentIdentity Identity(string path, string session = "native-document-1", string? fingerprint = null)
            => new OperatorNativeSaveDocumentIdentity(session, fingerprint ?? new string('a', 64), path, session != "other-document");
        private static OperatorAttemptSettlement Settle(OperatorNativeArtifactReceipt receipt, string effect = "apply")
            => OperatorAttemptSuccessfulSettlement.Classify(new { status = "Success", artifact_receipt = receipt }, effect, "POST", "/revit/save-as");

        [Fact]
        public void RetainedSuccessWithoutReceiptRemainsUnknownAndActualHandlerUsesNativeSaveBoundary()
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "unit403-save-as-unsettled.json")));
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(fixture.RootElement.GetProperty("normalized_native_result"), "apply", "POST", "/revit/save-as").EffectState);
            var handler = HandlerSource();
            Assert.Contains("OperatorNativeSaveAsExecution.Execute(resolved, preview, overwrite", handler);
            Assert.Contains("() => ReadActiveDocument(app, doc), () => doc.SaveAs(resolved, options)", handler);
            Assert.Contains("app.ActiveUIDocument?.Document", handler);
            Assert.DoesNotContain("Directory.CreateDirectory", handler);
            Assert.DoesNotContain("WorkspacePaths.GetWorkspaceRoot()", handler);
            Assert.DoesNotContain("new Transaction(", handler);
        }

        [Fact]
        public void PreviewHasNoFileOrDocumentReadAndNoNativeCall()
        {
            var result = OperatorNativeSaveAsExecution.Execute(Output, true, false, () => throw new Exception("must not read"), () => throw new Exception("must not save"));
            Assert.True(result.Ok); Assert.Equal("none", Settle(result.Receipt, "preview").EffectState);
            Assert.False(Directory.Exists(root)); Assert.Empty(result.Receipt.Outputs);
        }

        [Fact]
        public void ExistingTargetWithoutOverwriteIsUntouchedAndNoSaveStarts()
        {
            Directory.CreateDirectory(root); File.WriteAllText(Output, "original");
            var result = OperatorNativeSaveAsExecution.Execute(Output, false, false, () => Identity(""), () => throw new Exception("must not save"));
            Assert.Equal("Blocked", result.Status); Assert.Equal("none", Settle(result.Receipt).EffectState);
            Assert.Equal("original", File.ReadAllText(Output)); Assert.True(result.Receipt.SaveIoNotStarted);
        }

        [Fact]
        public void ReturnedSaveAndSharedStableFreshFileProveArtifactAndReportPathTransition()
        {
            var active = Identity(Path.Combine(root, "source.rvt")); FileStream? revitHandle = null;
            try
            {
                var result = OperatorNativeSaveAsExecution.Execute(Output, false, false, () => active, () => {
                    File.WriteAllText(Output, "native RVT output");
                    active = Identity(Output);
                    revitHandle = new FileStream(Output, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete);
                });
                Assert.True(result.Ok, result.Error); Assert.Equal("applied", Settle(result.Receipt).EffectState);
                Assert.True(result.Receipt.Outputs[0].StableRead); Assert.Equal(64, result.Receipt.Outputs[0].Sha256.Length);
                Assert.True(result.Receipt.SaveDocument!.DocumentPathChanged); Assert.False(result.Receipt.SaveDocument.ProjectBindingChanged);
                Assert.DoesNotContain("transaction", JsonSerializer.Serialize(result.Receipt));
                Assert.Contains("artifact_path:" + Output, Settle(result.Receipt).AffectedTargetIdentities);
            }
            finally { revitHandle?.Dispose(); }
        }

        [Fact]
        public void FallbackProjectFingerprintChangeIsReportedWithoutHidingTheSavedFile()
        {
            var active = Identity("");
            var result = OperatorNativeSaveAsExecution.Execute(Output, false, false, () => active, () => {
                File.WriteAllText(Output, "RVT"); active = Identity(Output, "native-document-after-save", new string('b', 64)); });
            Assert.Equal("applied", Settle(result.Receipt).EffectState); Assert.True(result.Receipt.SaveDocument!.ProjectBindingChanged);
            Assert.True(result.Receipt.SaveDocument.DocumentSessionChanged); Assert.True(result.Receipt.SaveDocument.SameDocument);
        }

        [Theory]
        [InlineData("missing")]
        [InlineData("empty")]
        [InlineData("wrong_path")]
        [InlineData("foreign_document")]
        [InlineData("identity_read_failed")]
        [InlineData("unreadable")]
        public void NativeReturnAloneCannotProveACompleteSave(string fault)
        {
            var active = Identity(""); var saved = false; FileStream? locked = null;
            try
            {
                var result = OperatorNativeSaveAsExecution.Execute(Output, false, false,
                    () => saved && fault == "identity_read_failed" ? throw new IOException("readback failed") : active,
                    () => {
                        saved = true;
                        if (fault != "missing") File.WriteAllText(Output, fault == "empty" ? "" : "RVT");
                        active = Identity(fault == "wrong_path" ? Path.Combine(root, "other.rvt") : Output, fault == "foreign_document" ? "other-document" : "native-document-1");
                        if (fault == "unreadable") locked = new FileStream(Output, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    });
                Assert.False(result.Ok); Assert.Equal("unknown", Settle(result.Receipt).EffectState);
                Assert.True(result.Receipt.SaveDocument!.NativeSaveReturned);
            }
            finally { locked?.Dispose(); }
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void ExceptionAfterSaveWasEnteredStaysUnknownEvenIfItWroteAFile(bool partialFile)
        {
            var active = Identity("");
            var result = OperatorNativeSaveAsExecution.Execute(Output, false, false, () => active, () => {
                if (partialFile) { File.WriteAllText(Output, "partial native output"); active = Identity(Output); }
                throw new IOException("native save failed"); });
            Assert.Equal("unknown", Settle(result.Receipt).EffectState); Assert.False(result.Receipt.SaveDocument!.NativeSaveReturned);
            Assert.Empty(result.Receipt.ExportCalls); Assert.Equal(partialFile, File.Exists(Output));
        }

        [Fact]
        public void UnchangedExistingFileDoesNotProveThisSaveAndConcurrentWritesInvalidateHash()
        {
            Directory.CreateDirectory(root); File.WriteAllText(Output, "original");
            var result = OperatorNativeSaveAsExecution.Execute(Output, false, true, () => Identity(Output), () => { });
            Assert.Equal("unknown", Settle(result.Receipt).EffectState);
            var unstable = OperatorNativeSaveAsExecution.SaveFileSnapshot.Read(Output, () => File.AppendAllText(Output, " changed while read"));
            Assert.False(unstable.Known);
            var replaced = OperatorNativeSaveAsExecution.Execute(Output, false, true, () => Identity(Output), () => File.WriteAllText(Output, "updated RVT"));
            Assert.Equal("applied", Settle(replaced.Receipt).EffectState);
        }

        [Fact]
        public void WireClaimsMustAgreeWithNativeReadbackAndArtifactFields()
        {
            var active = Identity("");
            var result = OperatorNativeSaveAsExecution.Execute(Output, false, false, () => active, () => { File.WriteAllText(Output, "RVT"); active = Identity(Output); });
            var receipt = JsonSerializer.Deserialize<Dictionary<string, object?>>(JsonSerializer.Serialize(result.Receipt))!;
            foreach (var change in new Dictionary<string, object?> { ["save_document"] = null, ["expected_export_calls"] = 2,
                ["export_calls"] = new[] { false }, ["outputs"] = new[] { new { path = Output, size_bytes = 3, sha256 = new string('a', 64), fresh_output = true } } })
            {
                var bad = new Dictionary<string, object?>(receipt) { [change.Key] = change.Value };
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(new { artifact_receipt = bad }, "apply", "POST", "/revit/save-as").EffectState);
            }
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(new { artifact_receipt = result.Receipt }, "apply", "POST", "/revit/export-pdf").EffectState);
        }

        private static string HandlerSource()
        {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var path = Path.Combine(directory.FullName, prefix, "RevitBridge/Handlers/SaveAsModelHandler.cs");
                    if (File.Exists(path)) return File.ReadAllText(path);
                }
            throw new FileNotFoundException("Save As handler source not found.");
        }
        public void Dispose()
        {
            var resolved = Path.GetFullPath(root);
            if (resolved.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase) && Directory.Exists(resolved)) Directory.Delete(resolved, true);
        }
    }
}
