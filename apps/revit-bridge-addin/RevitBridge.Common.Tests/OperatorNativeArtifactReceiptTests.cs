using System;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativeArtifactReceiptTests : IDisposable
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "operator-artifact-test-" + Guid.NewGuid().ToString("N"));
        private string Output(string name = "M000.pdf") => Path.Combine(root, name);
        private static OperatorAttemptSettlement Settle(object receipt, string effect = "apply", string path = "/revit/export-pdf")
            => OperatorAttemptSuccessfulSettlement.Classify(new { status = "Success", artifact_receipt = receipt }, effect, "POST", path);

        public OperatorNativeArtifactReceiptTests() => Directory.CreateDirectory(root);

        [Theory]
        [InlineData(true, "applied")]
        [InlineData(false, "unknown")]
        [InlineData(null, "unknown")]
        public void DriverPrintedFileRequiresGlobalSettingsRestorationAndExactRoute(bool? restored, string effect)
        {
            var capture = new OperatorNativeArtifactCapture(new[] { Output() }, 1, "/revit/print");
            File.WriteAllText(Output(), "%PDF driver output"); capture.RecordNativeExport(true);
            var receipt = capture.Complete(restored);
            Assert.Equal(effect, Settle(receipt, "apply", "/revit/print").EffectState);
            Assert.Equal("unknown", Settle(receipt, "apply", "/revit/export-pdf").EffectState);
            Assert.Equal(restored, receipt.PrintSettingsRestored);
        }

        [Fact]
        public void FreshNativeExportProducesFileReceiptAndIndependentReadbackWithoutTransaction()
        {
            var capture = new OperatorNativeArtifactCapture(new[] { Output() }, 1);
            File.WriteAllText(Output(), "%PDF-1.6 native output"); capture.RecordNativeExport(true);
            var receipt = capture.Complete(); var settled = Settle(receipt);
            Assert.Equal("complete", receipt.Status); Assert.Equal("applied", settled.EffectState);
            Assert.Equal("native_receipt", settled.EffectAuthority); Assert.Equal("native_artifact_export_completed", settled.EffectReason);
            Assert.Contains("artifact_path:" + Output(), settled.AffectedTargetIdentities);
            Assert.Contains("sha256:" + receipt.Outputs[0].Sha256, settled.ReceiptRefs);
            var read = OperatorNativeArtifactCapture.Inspect(new[] { Output() });
            Assert.True(read[0].Exists && read[0].Readable); Assert.False(read[0].FreshOutput);
            Assert.Equal(receipt.Outputs[0].Sha256, read[0].Sha256); Assert.Equal(receipt.Outputs[0].SizeBytes, read[0].SizeBytes);
            Assert.DoesNotContain("transaction", JsonSerializer.Serialize(receipt));
        }

        [Fact]
        public void ExistingUnchangedPdfIsNotEvidenceThatThisExportSucceeded()
        {
            File.WriteAllText(Output(), "%PDF-1.6 old output");
            var capture = new OperatorNativeArtifactCapture(new[] { Output() }, 1); capture.RecordNativeExport(true);
            Assert.Equal("unknown", Settle(capture.Complete()).EffectState);
        }

        [Fact]
        public void ReplacedExistingPdfHasFreshNativeFileEvidence()
        {
            File.WriteAllText(Output(), "%PDF-1.6 old output"); var capture = new OperatorNativeArtifactCapture(new[] { Output() }, 1);
            File.WriteAllText(Output(), "%PDF-1.6 revised output"); capture.RecordNativeExport(true);
            Assert.Equal("applied", Settle(capture.Complete()).EffectState);
        }

        [Theory]
        [InlineData(false, true, true)]
        [InlineData(true, false, false)]
        [InlineData(true, true, false)]
        public void FailedMissingOrEmptyOutputNeverBecomesApplied(bool apiSuccess, bool create, bool nonempty)
        {
            var capture = new OperatorNativeArtifactCapture(new[] { Output() }, 1);
            if (create) File.WriteAllText(Output(), nonempty ? "%PDF-1.6 partial" : "");
            capture.RecordNativeExport(apiSuccess);
            Assert.Equal("unknown", Settle(capture.Complete()).EffectState);
        }

        [Fact]
        public void PartialIndividualExportRetainsUnknownInsteadOfCertifyingTheWholeSet()
        {
            var capture = new OperatorNativeArtifactCapture(new[] { Output(), Output("M001.pdf") }, 2);
            File.WriteAllText(Output(), "%PDF-1.6 first file"); capture.RecordNativeExport(true);
            var receipt = capture.Complete(); Assert.True(receipt.Outputs[0].FreshOutput); Assert.False(receipt.Outputs[1].Exists);
            Assert.Equal("unknown", Settle(receipt).EffectState);
        }

        [Fact]
        public void ExportPreviewDoesNotCreateFolderOrPretendRollback()
        {
            var target = Path.Combine(root, "not-created", "plan.pdf");
            var preview = OperatorNativeArtifactReceipt.Preview(new[] { target }, 1);
            Assert.False(Directory.Exists(Path.GetDirectoryName(target)));
            var settled = Settle(preview, "preview");
            Assert.Equal("none", settled.EffectState); Assert.Equal("native_receipt", settled.EffectAuthority);
            Assert.Equal("native_artifact_export_not_started", settled.EffectReason);
            Assert.Equal("unknown", Settle(preview, "apply").EffectState);
        }

        [Fact]
        public void FileInspectionDoesNotCreateMissingOutput()
        {
            var target = Path.Combine(root, "not-created", "missing.pdf");
            var result = OperatorNativeArtifactCapture.Inspect(new[] { target });
            Assert.False(result[0].Exists); Assert.False(result[0].Readable); Assert.Equal("", result[0].Sha256);
            Assert.False(Directory.Exists(Path.GetDirectoryName(target)));
        }

        [Fact]
        public void LiveLegacyExportSuccessWithExistingPdfRemainsUnknownWithoutReceipt()
        {
            var result = new { status = "Success", dryRun = false, combine = true, selectedCount = 1,
                path = Output(), outputs = new[] { Output() }, verification = new { exists = true, isFile = true, sizeBytes = 8251486, ok = true } };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/export-pdf").EffectState);
        }

        [Fact]
        public void ReceiptCannotAuthorizeAnotherRouteOrAnApplyDuringPreview()
        {
            var capture = new OperatorNativeArtifactCapture(new[] { Output() }, 1);
            File.WriteAllText(Output(), "%PDF-1.6 output"); capture.RecordNativeExport(true);
            Assert.Equal("unknown", Settle(capture.Complete(), "apply", "/revit/move-elements").EffectState);
            Assert.Equal("unknown", Settle(capture.Complete(), "preview").EffectState);
        }

        [Theory]
        [InlineData("null")]
        [InlineData("[]")]
        [InlineData("{}")]
        [InlineData("{\"schema\":\"revit-operator.native-artifact-receipt.v1\",\"method\":\"POST\",\"path\":\"/revit/export-pdf\"}")]
        public void MalformedReceiptFailsClosed(string json)
        {
            using var parsed = JsonDocument.Parse(json);
            Assert.Equal("unknown", Settle(parsed.RootElement).EffectState);
        }

        [Fact]
        public void DuplicateOutputPathsAreRejectedBeforeExport()
            => Assert.Throws<ArgumentException>(() => new OperatorNativeArtifactCapture(new[] { Output(), Output() }, 2));

        public void Dispose()
        {
            var full = Path.GetFullPath(root);
            if (!full.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)
                || !Path.GetFileName(full).StartsWith("operator-artifact-test-", StringComparison.Ordinal)) throw new InvalidOperationException("Unexpected test cleanup path.");
            Directory.Delete(full, true);
        }
    }
}
