using System;
using System.IO;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TextNoteTypeLookupTests
    {
        [Fact]
        public void MissingRequestedNewNameNeverReturnsAnUnrelatedSharedType()
        {
            var result = TextNoteTypeLookup.Resolve<string>(null, "Unit404 Provisional 1-16 Arial",
                _ => throw new Exception("no id requested"), _ => null,
                () => throw new Exception("existing lookup must not select the shared fallback"), allowFallback: false);
            Assert.Null(result); // The handler must duplicate its separately resolved base.
        }

        [Fact]
        public void ExactExistingNameIsReusableWithoutCallingFallback()
        {
            var result = TextNoteTypeLookup.Resolve<string>(null, "  Existing note  ",
                _ => throw new Exception("no id requested"), name => name == "Existing note" ? "type-42" : null,
                () => throw new Exception("must not use fallback"), allowFallback: false);
            Assert.Equal("type-42", result);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("Not loaded")]
        public void OrdinaryCreateAndBaseSelectionKeepTheirDefaultFallback(string? name)
        {
            var calls = 0;
            Assert.Equal("shared-default", TextNoteTypeLookup.Resolve<string>(null, name,
                _ => throw new Exception("no id requested"), _ => null, () => { calls++; return "shared-default"; }));
            Assert.Equal(1, calls);
        }

        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void ExplicitIdNeverSubstitutesANameOrDefaultWhenMissing(bool allowFallback)
        {
            Assert.Null(TextNoteTypeLookup.Resolve<string>(99L, "Existing note", _ => null,
                _ => throw new Exception("explicit id owns lookup"),
                () => throw new Exception("missing explicit id cannot select fallback"), allowFallback));
        }

        [Fact]
        public void ExplicitIdKeepsPrecedenceOverAnOtherwiseMatchingName()
        {
            Assert.Equal("by-id", TextNoteTypeLookup.Resolve<string>(42L, "Existing note", id => id == 42 ? "by-id" : null,
                _ => throw new Exception("id takes precedence"), () => throw new Exception("no fallback")));
        }

        [Fact]
        public void NativeCreateTypeUsesExactLookupWhileItsBaseRemainsSeparate()
        {
            string? source = null;
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null && source == null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, "RevitBridge/Handlers/CreateTextNoteHandler.cs");
                    if (File.Exists(file)) { source = File.ReadAllText(file); break; }
                }
            Assert.NotNull(source);
            Assert.Contains("ResolveTextType(doc, null, newTypeName, allowFallback: false)", source!);
            Assert.Contains("ResolveTextType(doc, p.baseTypeId, p.baseTypeName) ?? ResolveFallbackTextType(doc)", source!);
            Assert.Contains("TextNoteTypeLookup.Resolve", source!);
            Assert.Contains("targetType.Duplicate(newTypeName)", source!);
        }
    }
}
