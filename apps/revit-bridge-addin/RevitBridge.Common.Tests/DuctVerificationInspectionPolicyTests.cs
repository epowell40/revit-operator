using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class DuctVerificationInspectionPolicyTests
    {
        private static bool Validate(object value)
        {
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(value));
            return DuctVerificationInspectionPolicy.TryValidate(json.RootElement, out _);
        }

        [Fact]
        public void CombinedInspectionRequiresCompleteUniqueTargetsAndPhysicalData()
        {
            Assert.True(Validate(new { elementIds = new[] { 1, 2 }, includeVerificationParameters = true }));
            Assert.True(Validate(new { elementIds = Enumerable.Range(1, 500), includeVerificationParameters = true }));
            foreach (var targets in new[] { new int[0], new[] { 1, 1 }, new[] { -1, 2 }, Enumerable.Range(1, 501).ToArray() })
                Assert.False(Validate(new { elementIds = targets, includeVerificationParameters = true }));
            Assert.False(Validate(new { elementIds = new[] { 1 }, includeVerificationParameters = true, includeAllRefs = false }));
            Assert.False(Validate(new { elementIds = new[] { 1 }, includeVerificationParameters = true, includeCoordinateSystem = false }));
            Assert.False(Validate(new { elementIds = new[] { 1 }, includeVerificationParameters = true, onlyOpenPhysicalConnectors = true }));
            Assert.False(Validate(new { elementIds = new[] { 1 }, includeVerificationParameters = "true" }));
            Assert.True(Validate(new { elementIds = Enumerable.Range(1, 501), onlyOpenPhysicalConnectors = true }));
        }
    }
}
