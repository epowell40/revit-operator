using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class CadLinkOptionPolicyTests
    {
        [Theory]
        [InlineData(null, "Preserved")]
        [InlineData("", "Preserved")]
        [InlineData(" preserve ", "Preserved")]
        [InlineData("COLOR", "Preserved")]
        [InlineData("black-and-white", "BlackAndWhite")]
        [InlineData("BlackAndWhite", "BlackAndWhite")]
        [InlineData("monochrome", "BlackAndWhite")]
        [InlineData("invert_colors", "Inverted")]
        public void ExplicitSupportedColorChoicesAreResolved(string? request, string expected)
            => Assert.Equal(expected, CadLinkOptionPolicy.ResolveColorMode(request));

        [Theory]
        [InlineData("greyscale")]
        [InlineData("1")]
        [InlineData("preserve; import")]
        public void UnknownColorIsRejectedInsteadOfSilentlyUsingADefault(string request)
            => Assert.Throws<ArgumentException>(() => CadLinkOptionPolicy.ResolveColorMode(request));

        [Fact]
        public void FailedLinkNeverInvokesImportAndKeepsOriginalException()
        {
            var importCalls = 0;
            var failure = new InvalidOperationException("native fixture failure");
            var thrown = Assert.Throws<InvalidOperationException>(() => CadLinkOptionPolicy.ExecuteRequestedMode(
                true, () => throw failure, () => { importCalls++; return 42; }, id => true));
            Assert.Same(failure, thrown);
            Assert.Equal(0, importCalls);
        }

        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void OnlyTheRequestedNativeOperationRuns(bool wantLink)
        {
            var linkCalls = 0; var importCalls = 0;
            Assert.Equal(42, CadLinkOptionPolicy.ExecuteRequestedMode(wantLink,
                () => { linkCalls++; return 42; }, () => { importCalls++; return 42; }, id => wantLink));
            Assert.Equal(wantLink ? 1 : 0, linkCalls);
            Assert.Equal(wantLink ? 0 : 1, importCalls);
        }

        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void MismatchedNativeIdentityCannotBeReportedAsSuccess(bool wantLink)
            => Assert.Throws<InvalidOperationException>(() => CadLinkOptionPolicy.ExecuteRequestedMode(
                wantLink, () => 42, () => 42, id => !wantLink));
    }
}
