using System;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

public sealed class OperatorWorkbookExportPathTests
{
    [Fact]
    public void RejectedOutsideWorkspaceExportDoesNotCreateAnythingAndCorrectedRequestRemainsUsable()
    {
        var sandbox = Path.Combine(Path.GetTempPath(), "operator-export-path-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(sandbox, "Workspace");
        foreach (var folder in new[] { Path.Combine(sandbox, "Documents", "RevitOperator", "Exports"), Path.Combine(sandbox, "Workspace-other"), "../outside", "../../outside" })
        {
            using var body = JsonDocument.Parse(JsonSerializer.Serialize(new { outputFolder = folder, fileName = "Synthetic_Airflow_Acceptance.xlsx" }));
            Assert.False(OperatorWorkbookExportPath.TryValidateRequest(root, body.RootElement, out var error));
            Assert.Contains("workspace", error!);
        }
        Assert.False(Directory.Exists(sandbox));
        using var corrected = JsonDocument.Parse("{\"fileName\":\"corrected.xlsx\"}");
        Assert.True(OperatorWorkbookExportPath.TryValidateRequest(root, corrected.RootElement, out _));
        Assert.Equal(Path.Combine(root, "artifacts", "xlsx", "corrected.xlsx"), OperatorWorkbookExportPath.Resolve(root, null, "corrected"));
        Assert.False(Directory.Exists(sandbox));
    }

    [Fact]
    public void ValidAbsoluteDestinationStaysInsideWorkspaceAndExistingFileIsNeverModified()
    {
        var root = Path.Combine(Path.GetTempPath(), "operator-export-path-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var file = Path.Combine(root, "existing.xlsx");
        try
        {
            File.WriteAllText(file, "original bytes");
            Assert.Throws<IOException>(() => OperatorWorkbookExportPath.Resolve(root, root, "existing.xlsx"));
            Assert.Equal("original bytes", File.ReadAllText(file));
            Assert.Equal(Path.Combine(root, "safe", "next.xlsx"), OperatorWorkbookExportPath.Resolve(root, Path.Combine(root, "safe"), "next.xlsx"));
            foreach (var name in new[] { "../bad", "nested/bad.xlsx", "bad:name", new string('x', 180) })
                Assert.Throws<ArgumentException>(() => OperatorWorkbookExportPath.Resolve(root, null, name));
            using var invalid = JsonDocument.Parse("{\"outputFolder\":42}");
            Assert.False(OperatorWorkbookExportPath.TryValidateRequest(root, invalid.RootElement, out _));
        }
        finally { File.Delete(file); Directory.Delete(root); }
    }
}
