using System;
using System.Collections;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class BoundedNativeSequenceTests
    {
        [Theory]
        [InlineData(0, false)]
        [InlineData(49, false)]
        [InlineData(50, false)]
        [InlineData(51, true)]
        [InlineData(120, true)]
        public void CompletenessDistinguishesExactLimitFromOmittedResults(int size, bool omitted)
        {
            var result = JsonSerializer.SerializeToElement(BoundedNativeSequence.Project(Enumerable.Range(0, size), x => x));
            Assert.Equal(Math.Min(size, 50), result.GetProperty("count").GetInt32());
            Assert.Equal(omitted, result.GetProperty("hasMore").GetBoolean());
            Assert.Equal(!omitted, result.GetProperty("complete").GetBoolean());
            if (omitted) Assert.Equal(JsonValueKind.Null, result.GetProperty("total").ValueKind);
            else Assert.Equal(size, result.GetProperty("total").GetInt32());
        }

        [Fact]
        public void LazySequenceIsBoundedAndDisposedAndExtraItemIsNotProjected()
        {
            var moved = 0; var projected = 0; var disposed = false;
            IEnumerable Stream()
            {
                try { while (true) { moved++; yield return moved; } }
                finally { disposed = true; }
            }
            BoundedNativeSequence.Project(Stream(), x => { projected++; return x; });
            Assert.Equal(51, moved); Assert.Equal(50, projected); Assert.True(disposed);
        }

        [Fact]
        public void FailedEnumerationIsNotReportedAsComplete()
        {
            IEnumerable Broken() { yield return 1; throw new InvalidOperationException("native read failed"); }
            Assert.Throws<InvalidOperationException>(() => BoundedNativeSequence.Project(Broken(), x => x));
        }
    }
}
