using System;
using System.IO;
using RevitBridge.Common.FamilyEvolution;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class InstalledFamilyTemplateTests
    {
        [Theory]
        [InlineData("../other.rft")] [InlineData("..\\other.rft")] [InlineData("C:\\other.rft")]
        [InlineData("//server/other.rft")] [InlineData("template.rft:stream")] [InlineData("project.rvt")]
        [InlineData("")] [InlineData("sub/template.rft")]
        public void InstalledSelectionIsNotAnExternalFileAccessRoot(string name)
        {
            Assert.Throws<ArgumentException>(() => InstalledFamilyTemplate.Resolve(Path.GetTempPath(), name));
        }

        [Fact]
        public void OnlyAnExistingLeafTemplateIsResolved()
        {
            var root = Path.Combine(Path.GetTempPath(), "operator-template-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            var path = Path.Combine(root, "Metric Generic Model.rft");
            try
            {
                File.WriteAllText(path, "test fixture, not loadable content");
                Assert.Equal(path, InstalledFamilyTemplate.Resolve(root, "Metric Generic Model.rft"));
                Assert.Equal(path, InstalledFamilyTemplate.Resolve(root, "generic-model"));
                var imperial = Path.Combine(root, "Generic Model.rft");
                File.Move(path, imperial);
                Assert.Equal(imperial, InstalledFamilyTemplate.Resolve(root, "generic-model"));
                File.WriteAllText(path, "second template");
                Assert.Throws<ArgumentException>(() => InstalledFamilyTemplate.Resolve(root, "generic-model"));
                File.Delete(imperial);
                Assert.Throws<FileNotFoundException>(() => InstalledFamilyTemplate.Resolve(root, "Missing.rft"));
            }
            finally { File.Delete(path); Directory.Delete(root); }
        }
    }
}
