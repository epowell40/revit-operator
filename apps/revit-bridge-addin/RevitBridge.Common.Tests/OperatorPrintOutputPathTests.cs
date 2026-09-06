using System;
using System.IO;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorPrintOutputPathTests
    {
        [Fact]
        public void ExactFailedBenchmarkRelativePathResolvesBeforeAnyPrintSubmission()
        {
            var root = Path.Combine(Path.GetTempPath(), "print-path-test-" + Guid.NewGuid().ToString("N"));
            var calls = 0;
            string Folder(string? folder) { calls++; return Path.Combine(root, folder ?? "artifacts/prints"); }
            Assert.Equal(Path.Combine(root, "artifacts", "prints", "M000.pdf"),
                OperatorPrintOutputPath.Resolve("artifacts/prints/M000.pdf", "artifacts/prints", "ignored.pdf", Folder));
            Assert.Equal(Path.Combine(root, "artifacts", "prints", "M001.pdf"),
                OperatorPrintOutputPath.Resolve("M001.pdf", "artifacts/prints", "ignored.pdf", Folder));
            Assert.Equal(Path.Combine(root, "artifacts", "prints", "M002.pdf"),
                OperatorPrintOutputPath.Resolve(null, null, "M002", Folder));
            Assert.Equal(3, calls); Assert.False(Directory.Exists(root));
        }

        [Fact]
        public void InvalidOrUnauthorizedPathsDoNotFallBackToTheCurrentPrinterOutput()
        {
            Assert.Throws<ArgumentException>(() => OperatorPrintOutputPath.Resolve("C:relative.pdf", null, "M000.pdf", _ => throw new Exception("must not resolve")));
            Assert.Throws<ArgumentException>(() => OperatorPrintOutputPath.Resolve("folder/", null, "M000.pdf", _ => throw new Exception("must not resolve")));
            Assert.Throws<UnauthorizedAccessException>(() => OperatorPrintOutputPath.Resolve("../escape/M000.pdf", null, "M000.pdf", _ => throw new UnauthorizedAccessException("outside allowed roots")));
        }
    }
}
