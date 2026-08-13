using System;
using System.IO;
using System.Linq;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorProactivityLifecycleContractTests
    {
        [Fact]
        public void WarningsWatcherCannotPermanentlyOccupyTheExternalEventQueue()
        {
            var source = ReadRepoFile(
                "apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorProactivityService.cs");
            Assert.Contains("private async Task WarningsWatcherLoopAsync", source);
            Assert.Contains("CancellationTokenSource.CreateLinkedTokenSource(cancellationToken)", source);
            Assert.Contains("hostReadTimeout.CancelAfter(TimeSpan.FromSeconds(5))", source);
            Assert.Contains("}, hostReadTimeout.Token).ConfigureAwait(false);", source);
        }

        private static string ReadRepoFile(params string[] relativeSegments)
        {
            var cursor = new DirectoryInfo(AppContext.BaseDirectory);
            while (cursor != null)
            {
                var candidate = Path.Combine(new[] { cursor.FullName }.Concat(relativeSegments).ToArray());
                if (File.Exists(candidate)) return File.ReadAllText(candidate);
                cursor = cursor.Parent;
            }

            throw new FileNotFoundException("Could not locate repository source file.", Path.Combine(relativeSegments));
        }
    }
}
