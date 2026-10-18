using System;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class CadLinkOptionPolicyTests
    {
        [Fact]
        public void ExactViewFirstRequestHasAPlannedOwnerBeforeAnySheetExists()
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
                "Fixtures", "cad-named-owner-before-sheet132.json")));
            var request = fixture.RootElement.GetProperty("request");
            Assert.False(request.TryGetProperty("sheetNumber", out _));
            Assert.False(request.GetProperty("placeOnSheet").GetBoolean());
            Assert.True(CadLinkOptionPolicy.ShouldCreateDraftingView(false, false, false,
                request.GetProperty("viewName").GetString(), request.GetProperty("createDraftingView").GetBoolean()));
        }

        [Theory]
        [InlineData(false, false, false, "CAD Layer Standards", true, true)]
        [InlineData(false, false, true, null, null, true)]
        [InlineData(false, false, false, "Named view", null, true)]
        [InlineData(true, false, false, "Existing view", true, false)]
        [InlineData(false, false, false, "Named view", false, false)]
        [InlineData(false, true, true, "Named view", true, false)]
        [InlineData(false, false, false, null, true, false)]
        [InlineData(false, false, false, "  ", true, false)]
        public void DraftingOwnerCanPrecedeSheetButNeverInventsAnUnnamedTarget(bool existing,
            bool directSheet, bool sheet, string? name, bool? create, bool expected)
            => Assert.Equal(expected, CadLinkOptionPolicy.ShouldCreateDraftingView(existing, directSheet, sheet, name, create));

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
