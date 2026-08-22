using System;
using System.IO;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ActivateViewRecoveryContractTests
    {
        [Fact]
        public void ActivateViewDefersOnlyTheProvenSafeTemporaryDisabledCase()
        {
            var source = File.ReadAllText(Path.Combine(
                FindRepositoryRoot(),
                "apps",
                "revit-bridge-addin",
                "RevitBridge.Logic",
                "Handlers",
                "Selection",
                "ActivateViewHandler.cs"));

            Assert.Contains("catch (Exception ex) when (CanRequestDeferredActivation(p) && IsTemporarilyDisabled(ex))", source);
            Assert.Contains("uidoc.RequestViewChange(view);", source);
            Assert.Contains("activationPending = true;", source);
            Assert.Contains("return !hasShowElements && !hasBoundingBox;", source);
            Assert.Contains("temporarily disabled", source, StringComparison.OrdinalIgnoreCase);
        }

        private static string FindRepositoryRoot()
        {
            var cursor = new DirectoryInfo(AppContext.BaseDirectory);
            while (cursor != null)
            {
                if (Directory.Exists(Path.Combine(cursor.FullName, "apps", "revit-bridge-addin"))) return cursor.FullName;
                cursor = cursor.Parent;
            }

            throw new DirectoryNotFoundException("Repository root not found.");
        }
    }
}
