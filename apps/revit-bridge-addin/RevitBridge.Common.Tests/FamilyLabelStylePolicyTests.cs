using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using RevitBridge.Common.Annotation;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class FamilyLabelStylePolicyTests
    {
        private static FamilyLabelStyleValues Original() => new FamilyLabelStyleValues
        {
            font = "Arial", textSizeFeet = 0.008202099737532808,
            bold = false, italic = false, underline = false, widthFactor = 1
        };
        private static FamilyLabelStyleChangeRequest Request() => new FamilyLabelStyleChangeRequest
        {
            familyDocumentId = "0123456789abcdef0123456789abcdef", labelTypeId = 788388,
            expectedTypeUniqueId = "3efa7731-ff9a-432c-866e-28d78d76a459-000c07a4",
            style = new FamilyLabelStyleValues { underline = true },
            expectedStyle = new FamilyLabelStyleValues { underline = false }
        };

        [Fact]
        public void RetainedNativeLabelStyleCanBeChangedWithoutAlteringOtherTypography()
        {
            var before = Original();
            var after = FamilyLabelStylePolicy.Plan(before, Request());
            Assert.True(after.underline); Assert.False(before.underline);
            Assert.Equal(before.font, after.font); Assert.Equal(before.textSizeFeet, after.textSizeFeet);
            Assert.Equal(before.widthFactor, after.widthFactor); Assert.Equal(before.bold, after.bold); Assert.Equal(before.italic, after.italic);
        }

        [Fact]
        public void FalseIsARealStyleValueAndRequiresARealPrecondition()
        {
            var request = Request(); request.style.underline = false; request.expectedStyle.underline = true;
            var before = Original(); before.underline = true;
            Assert.False(FamilyLabelStylePolicy.Plan(before, request).underline);
            request.expectedStyle.underline = null;
            Assert.Throws<ArgumentException>(() => FamilyLabelStylePolicy.Plan(before, request));
        }

        [Fact]
        public void StaleExpectedStylesCannotBeReplaced()
        {
            var before = Original(); before.underline = true;
            Assert.Throws<InvalidOperationException>(() => FamilyLabelStylePolicy.Plan(before, Request()));
            Assert.True(before.underline);
        }

        [Fact]
        public void FullExpectedSnapshotDetectsUnrequestedConcurrentFontChange()
        {
            var request = Request(); request.expectedStyle = Original();
            var current = Original(); current.font = "Other Font";
            Assert.Throws<InvalidOperationException>(() => FamilyLabelStylePolicy.Plan(current, request));
        }

        [Fact]
        public void SupportsAllExposedStyleFieldsTogetherWithExactOldValues()
        {
            var request = Request(); request.expectedStyle = Original();
            request.style = new FamilyLabelStyleValues { font = "Arial Narrow", textSizeFeet = 0.01, bold = true, italic = true, underline = true, widthFactor = 0.8 };
            var after = FamilyLabelStylePolicy.Plan(Original(), request);
            Assert.True(FamilyLabelStylePolicy.Same(after, request.style));
            Assert.False(FamilyLabelStylePolicy.Same(Original(), after));
        }

        [Theory]
        [InlineData(0)] [InlineData(-1)] [InlineData(double.NaN)] [InlineData(double.PositiveInfinity)] [InlineData(2)]
        public void InvalidTextSizesAreRejectedBeforeNativeEntry(double size)
        {
            var request = Request(); request.style.textSizeFeet = size; request.expectedStyle.textSizeFeet = 0.008;
            Assert.Throws<ArgumentException>(() => FamilyLabelStylePolicy.Validate(request));
        }

        [Theory]
        [InlineData(0)] [InlineData(-1)] [InlineData(double.NaN)] [InlineData(double.PositiveInfinity)] [InlineData(101)]
        public void InvalidWidthFactorsAreRejected(double width)
        {
            var request = Request(); request.style.widthFactor = width; request.expectedStyle.widthFactor = 1;
            Assert.Throws<ArgumentException>(() => FamilyLabelStylePolicy.Validate(request));
        }

        [Theory]
        [InlineData("")] [InlineData(" Arial")] [InlineData("Arial\nInjected")]
        public void InvalidFontNamesAreRejected(string font)
        {
            var request = Request(); request.style.font = font; request.expectedStyle.font = "Arial";
            Assert.Throws<ArgumentException>(() => FamilyLabelStylePolicy.Validate(request));
        }

        [Fact]
        public void IdentityAndPatchFieldsAreRequired()
        {
            var request = Request(); request.familyDocumentId = "not-a-native-handle";
            Assert.Throws<ArgumentException>(() => FamilyLabelStylePolicy.Validate(request));
            request = Request(); request.labelTypeId = 0;
            Assert.Throws<ArgumentException>(() => FamilyLabelStylePolicy.Validate(request));
            request = Request(); request.expectedTypeUniqueId = "";
            Assert.Throws<ArgumentException>(() => FamilyLabelStylePolicy.Validate(request));
            request = Request(); request.style = new FamilyLabelStyleValues();
            Assert.Throws<ArgumentException>(() => FamilyLabelStylePolicy.Validate(request));
        }

        [Fact]
        public void UnknownDuplicateAndMistypedFieldsCannotChangeMeaningThroughDeserialization()
        {
            var json = JsonSerializer.Serialize(Request());
            Assert.True(FamilyLabelStylePolicy.Parse(json).style.underline);
            Assert.Throws<ArgumentException>(() => FamilyLabelStylePolicy.Parse(json.Replace("\"dryRun\":false", "\"dryRun\":false,\"loadProject\":true")));
            Assert.Throws<ArgumentException>(() => FamilyLabelStylePolicy.Parse(json.Replace("\"underline\":true", "\"underline\":true,\"underline\":false")));
            Assert.Throws<JsonException>(() => FamilyLabelStylePolicy.Parse(json.Replace("\"underline\":true", "\"underline\":\"true\"")));
        }

        [Fact]
        public void SetterUsesParentOwnedSessionNativeSettlementAndPostCommitReadback()
        {
            var source = Source("SetFamilyLabelStyleHandler.cs");
            Assert.Contains("NativeMutationPreflightBoundary.Execute", source);
            Assert.Contains("NativeSingleTransaction.Execute", source);
            Assert.Contains("OperatorNativeTransactionExecution.ReadCommitted", source);
            Assert.Contains("expectedTypeUniqueId", source);
            Assert.Contains("loadedProjectStyleVerified\"] = false", source);
            Assert.DoesNotContain(".SaveAs(", source); Assert.DoesNotContain(".LoadFamily(", source);
            var access = Source("FamilyLabelStyleAccess.cs");
            Assert.Contains("session.ProjectDoc.Equals(app.ActiveUIDocument?.Document)", access);
            Assert.Contains("label.GetTypeId() == type.Id", access);
            Assert.Contains("parameter.IsReadOnly", access);
        }

        private static string Source(string name)
        {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, "RevitBridge.Logic/Handlers/Families", name);
                    if (File.Exists(file)) return File.ReadAllText(file);
                }
            throw new FileNotFoundException(name);
        }
    }
}
