using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    [Collection("Workspace configuration")]
    public sealed class OperatorFamilyCreationReceiptTests
    {
        private static string State(object value, string route = "/revit/create-family-from-template")
            => OperatorAttemptSuccessfulSettlement.Classify(value, "apply", "POST", route).EffectState;

        [Fact]
        public void Retained314PreflightFailureIsNoneOnlyBeforeAllNativeAndFileEffects()
        {
            var rejected = OperatorFamilyCreationReceipt.Rejected("Installed family template not found in Revit's configured template directory: Metric Generic Model.rft");
            Assert.Equal("none", State(rejected));
            foreach (var field in new[] { "native_family_document_created", "file_write_performed", "project_load_invoked" })
            {
                var changed = JsonNode.Parse(JsonSerializer.Serialize(rejected))!;
                changed["family_creation_receipt"]![field] = true;
                Assert.Equal("unknown", State(changed));
            }
            Assert.Equal("unknown", State(rejected, "/revit/save-family-doc"));
            Assert.Equal("unknown", State(new { ok = false, status = "Rejected", error = "template missing" }));
        }

        [Theory]
        [InlineData(false)] [InlineData(true)]
        public void ActualSavedBytesAndRequestedLoadCommitAreRequired(bool load)
        {
            var file = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".rfa");
            try
            {
                File.WriteAllText(file, "native saved file fixture; geometry is independently verified in Revit");
                var saved = OperatorFamilySaveReceipt.Saved(new string('a', 32), file, true);
                var result = new { ok = true, status = "Created", filePath = file,
                    load = load ? new { familyId = 42L } : null,
                    family_creation_receipt = OperatorFamilyCreationReceipt.Created(saved, load, load ? 42L : (long?)null, load) };
                var raw = JsonSerializer.Serialize(result);
                Assert.Equal("applied", State(result));
                foreach (var field in new[] { "native_save_returned", "document_path_verified", "stable_read" })
                {
                    var bad = JsonNode.Parse(raw)!; bad["family_creation_receipt"]!["file"]![field] = false;
                    Assert.Equal("unknown", State(bad));
                }
                var open = JsonNode.Parse(raw)!; open["family_creation_receipt"]!["native_family_document_closed"] = false;
                Assert.Equal("unknown", State(open));
                var mismatch = JsonNode.Parse(raw)!; mismatch["filePath"] = file + "other.rfa";
                Assert.Equal("unknown", State(mismatch));
                var commit = JsonNode.Parse(raw)!; commit["family_creation_receipt"]!["project_load_committed"] = !load;
                Assert.Equal("unknown", State(commit));
                if (load)
                {
                    var wrongId = JsonNode.Parse(raw)!; wrongId["load"]!["familyId"] = 43;
                    Assert.Equal("unknown", State(wrongId));
                }
                Assert.Equal("unknown", State(result, "/revit/load-family"));
            }
            finally { File.Delete(file); }
        }

        [Fact]
        public void PreflightPathResolutionDoesNotCreateWorkspaceOrPermitSiblingEscape()
        {
            var prior = Environment.GetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT");
            var root = Path.Combine(Path.GetTempPath(), "family-preflight-" + Guid.NewGuid().ToString("N"));
            try
            {
                Environment.SetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT", root);
                Assert.Equal(Path.Combine(root, "artifacts", "test.rfa"), WorkspacePaths.ResolveFileUnderWorkspaceReadOnly("artifacts/test.rfa"));
                Assert.Throws<UnauthorizedAccessException>(() => WorkspacePaths.ResolveFileUnderWorkspaceReadOnly("../test.rfa"));
                Assert.False(Directory.Exists(root));
            }
            finally { Environment.SetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT", prior); }
        }
    }
}
