using System;
using System.IO;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests;

public class SavedDocumentInspectionPolicyTests
{
    [Fact]
    public void OnlyExactActiveSavedPathAndDocumentKindAreEligible()
    {
        var model = Path.Combine(Path.GetTempPath(), "active.rvt");
        Assert.Equal(Path.GetFullPath(model), SavedDocumentInspectionPolicy.Resolve(model, model, false));
        Assert.Throws<ArgumentException>(() => SavedDocumentInspectionPolicy.Resolve(Path.Combine(Path.GetTempPath(), "other.rvt"), model, false));
        Assert.Throws<ArgumentException>(() => SavedDocumentInspectionPolicy.Resolve(model, model, true));
        Assert.Throws<ArgumentException>(() => SavedDocumentInspectionPolicy.Resolve("active.rvt", model, false));
        Assert.Throws<ArgumentException>(() => SavedDocumentInspectionPolicy.Resolve(model, "", false));
        var family = Path.Combine(Path.GetTempPath(), "active.rfa");
        Assert.Equal(Path.GetFullPath(family), SavedDocumentInspectionPolicy.Resolve(family, family, true));
        Assert.Throws<ArgumentException>(() => SavedDocumentInspectionPolicy.Resolve(family, family, false));
        var pdf = Path.Combine(Path.GetTempPath(), "active.pdf");
        Assert.Throws<ArgumentException>(() => SavedDocumentInspectionPolicy.Resolve(pdf, pdf, false));
    }

    [Fact]
    public void SeparateSavedFileInspectionReportsCurrentStableBytesWithoutWriting()
    {
        var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, "model.rvt");
        try
        {
            var absent = OperatorNativeSaveAsExecution.InspectSavedFile(file);
            Assert.False(absent.Exists); Assert.False(absent.StableRead);
            File.WriteAllBytes(file, new byte[] { 1, 2, 3, 4 });
            var read = OperatorNativeSaveAsExecution.InspectSavedFile(file);
            Assert.True(read.Exists); Assert.True(read.Readable); Assert.True(read.StableRead);
            Assert.Equal(4, read.SizeBytes); Assert.Equal(64, read.Sha256.Length); Assert.False(read.FreshOutput);
            File.WriteAllBytes(file, new byte[] { 5, 6, 7, 8 });
            Assert.NotEqual(read.Sha256, OperatorNativeSaveAsExecution.InspectSavedFile(file).Sha256);
        }
        finally { Directory.Delete(directory, true); }
    }
}
