using System;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    [Collection("Workspace configuration")]
    public sealed class OperatorFamilySavePathTests
    {
        [Theory]
        [InlineData("../outside.rfa")]
        [InlineData("C:/Users/Example/Documents/RevitOperator/Exports/Equipment Tag_Underlined.rfa")]
        [InlineData("C:relative.rfa")]
        [InlineData("/root-relative.rfa")]
        [InlineData("artifacts/invalid.rvt")]
        [InlineData("artifacts/file.rfa:stream.rfa")]
        [InlineData(".")]
        public void InvalidSaveAsIsRejectedWithoutCreatingTheWorkspace(string requested)
        {
            var root = Path.Combine(Path.GetTempPath(), "family-path-" + Guid.NewGuid().ToString("N"));
            using var request = JsonDocument.Parse(JsonSerializer.Serialize(new { familyDocumentId = new string('a', 32), filePath = requested, overwrite = false }));
            Assert.False(OperatorFamilySavePath.TryValidateRequest(root, request.RootElement, out var error));
            Assert.False(string.IsNullOrWhiteSpace(error));
            Assert.False(Directory.Exists(root));
        }

        [Fact]
        public void CorrectedRelativeSaveAsAndAbsoluteWorkspaceSaveAsResolveIdenticallyWithoutWriting()
        {
            var root = Path.Combine(Path.GetTempPath(), "family-path-" + Guid.NewGuid().ToString("N"));
            var relative = "artifacts/families/Equipment_Tag_Underlined.rfa";
            var full = Path.GetFullPath(Path.Combine(root, relative));
            Assert.Equal(full, OperatorFamilySavePath.Resolve(root, relative));
            Assert.Equal(full, OperatorFamilySavePath.Resolve(root, full));
            Assert.Throws<ArgumentException>(() => OperatorFamilySavePath.Resolve(root, root + "-other/Tag.rfa"));
            Assert.False(Directory.Exists(root));
        }

        [Theory]
        [InlineData("{}")]
        [InlineData("{\"filePath\":null}")]
        [InlineData("{\"filePath\":\" \"}")]
        public void NoSaveAsPathRetainsSaveSemantics(string json)
        {
            using var request = JsonDocument.Parse(json);
            Assert.True(OperatorFamilySavePath.TryValidateRequest(Path.GetTempPath(), request.RootElement, out _));
            Assert.Null(OperatorFamilySavePath.Resolve(Path.GetTempPath(), null));
        }

        [Theory]
        [InlineData("null")]
        [InlineData("{\"filePath\":12}")]
        public void MalformedRequestsFailBeforeDispatch(string json)
        {
            using var request = JsonDocument.Parse(json);
            Assert.False(OperatorFamilySavePath.TryValidateRequest(Path.GetTempPath(), request.RootElement, out _));
        }

        [Fact]
        public void PureRootResolutionDoesNotCreateConfiguredWorkspace()
        {
            var prior = Environment.GetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT");
            var root = Path.Combine(Path.GetTempPath(), "family-root-" + Guid.NewGuid().ToString("N"));
            try
            {
                Environment.SetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT", root);
                Assert.Equal(root, WorkspacePaths.GetWorkspaceRootPath());
                Assert.False(Directory.Exists(root));
            }
            finally { Environment.SetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT", prior); }
        }

        [Fact]
        public void BothNativeBoundariesValidateBeforeDispatchAndHandlerUsesTheSameResolver()
        {
            var server = Source("RevitBridge/Server/RevitHttpServer.cs");
            var validator = Source("RevitBridge/Operator/OperatorActionSchemaValidator.cs");
            var handler = Source("RevitBridge.Logic/Handlers/Families/SaveFamilyDocHandler.cs");
            Assert.Contains("OperatorFamilySavePath.TryValidateRequest(WorkspacePaths.GetWorkspaceRootPath()", server);
            Assert.Contains("OperatorFamilySavePath.TryValidateRequest(WorkspacePaths.GetWorkspaceRootPath()", validator);
            Assert.Contains("OperatorFamilySavePath.Resolve(WorkspacePaths.GetWorkspaceRootPath(), requestedPath)", handler);
            Assert.True(handler.IndexOf("OperatorFamilySavePath.Resolve", StringComparison.Ordinal) < handler.IndexOf("famDoc.SaveAs", StringComparison.Ordinal));
        }

        private static string Source(string relative)
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(dir.FullName, prefix, relative);
                    if (File.Exists(file)) return File.ReadAllText(file);
                }
            throw new FileNotFoundException(relative);
        }
    }
}
