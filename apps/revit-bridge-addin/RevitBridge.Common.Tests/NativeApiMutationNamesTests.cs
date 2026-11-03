using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class NativeApiMutationNamesTests
    {
        [Theory]
        [InlineData("NewDetailCurve")]
        [InlineData("NewDetailCurveArray")]
        [InlineData("NewGroup")]
        [InlineData("NewFamilyInstance")]
        [InlineData("newdetailcurve")]
        [InlineData("SetGeometryCurve")]
        [InlineData("Delete")]
        [InlineData("CreateBound")]
        [InlineData("Regenerate")]
        public void NativeFactoriesAndExistingMutatorsRequireMutationAdmission(string name)
            => Assert.True(NativeApiMutationNames.IsMutating(name));

        [Theory]
        [InlineData("GetElement")]
        [InlineData("GetNewGeometry")]
        [InlineData("Renew")]
        [InlineData("IsNew")]
        [InlineData("")]
        [InlineData(null)]
        public void ReadNamesAndEmbeddedWordsDoNotBecomeMutations(string? name)
            => Assert.False(NativeApiMutationNames.IsMutating(name));
    }
}
