using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class LoadedFamilySymbolLookupTests
    {
        [Fact]
        public void LoadedSymbolCanBeInspectedBeforeAnyInstanceExistsButCannotStartAnEdit()
        {
            // Retained323: type1545043 loaded through Autodesk UI, zero accessories.
            // Its GetTypeId is invalid: inspecting its own type must not be required.
            var symbol = new object();
            Assert.Same(symbol, LoadedFamilySymbolLookup.ResolveForInspection(1545043L,
                id => id == 1545043 ? symbol : null,
                _ => throw new Exception("no placed instance"),
                _ => throw new Exception("not a tag"),
                _ => throw new Exception("symbol has no own type"),
                _ => throw new Exception("must not select a different type")));
            Assert.Null(LoadedFamilySymbolLookup.Resolve(1545043L, _ => (object?)null,
                _ => false, _ => throw new Exception("editing must retain grounded instance/tag restriction"),
                _ => throw new Exception("must not resolve an edit source")));
        }

        [Fact]
        public void InspectionPreservesExistingInstanceAndOwnTagSymbolResolution()
        {
            Assert.Equal("instance", LoadedFamilySymbolLookup.ResolveForInspection(1,
                _ => (string?)null, _ => "instance", _ => throw new Exception("not tag"),
                _ => throw new Exception("not tag"), _ => throw new Exception("not tag")));
            Assert.Equal("own-tag", LoadedFamilySymbolLookup.ResolveForInspection(1,
                _ => (string?)null, _ => (string?)null, _ => true, _ => 17,
                id => id == 17 ? "own-tag" : throw new Exception("wrong type")));
        }

        [Fact]
        public void InspectionDoesNotResolveSystemOrUnrelatedElementTypes()
        {
            Assert.Null(LoadedFamilySymbolLookup.ResolveForInspection(1,
                _ => (string?)null, _ => (string?)null, _ => false,
                _ => throw new Exception("arbitrary GetTypeId not authorized"),
                _ => throw new Exception("system type is not a FamilySymbol")));
            Assert.Null(LoadedFamilySymbolLookup.ResolveForInspection(1,
                _ => (string?)null, _ => (string?)null, _ => true, _ => 0,
                _ => throw new Exception("invalid annotation type")));
        }

        [Fact]
        public void AnnotationResolvesItsOwnSymbolRatherThanTaggedEquipment()
        {
            var tag = new { ownType = 354074L, taggedEquipmentType = 622023L };
            long lookedUp = 0;
            var result = LoadedFamilySymbolLookup.Resolve(tag, _ => (string?)null,
                _ => true, value => value.ownType, id => {
                    lookedUp = id;
                    return id == tag.ownType ? "Electrical Equipment Tag:Standard" : "Equipment";
                });
            Assert.Equal("Electrical Equipment Tag:Standard", result);
            Assert.Equal(tag.ownType, lookedUp);
            Assert.NotEqual(tag.taggedEquipmentType, lookedUp);
        }

        [Fact]
        public void ExistingInstanceResolutionDoesNotUseAnnotationFallback()
        {
            Assert.Equal("Titleblock:A1", LoadedFamilySymbolLookup.Resolve(1,
                _ => "Titleblock:A1", _ => throw new Exception("not a tag"),
                _ => throw new Exception("not a tag"), _ => throw new Exception("not a tag")));
        }

        [Fact]
        public void UnrelatedElementWithATypeCannotBeTreatedAsAnAnnotation()
        {
            Assert.Null(LoadedFamilySymbolLookup.Resolve(1, _ => (string?)null,
                _ => false, _ => throw new Exception("must not resolve arbitrary types"),
                _ => throw new Exception("must not resolve arbitrary types")));
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        public void InvalidAnnotationTypeRefusesLookup(long typeId)
        {
            Assert.Null(LoadedFamilySymbolLookup.Resolve(1, _ => (string?)null,
                _ => true, _ => typeId, _ => throw new Exception("invalid id")));
        }

        [Fact]
        public void MissingAnnotationSymbolDoesNotSelectUnrelatedFamily()
        {
            Assert.Null(LoadedFamilySymbolLookup.Resolve(1, _ => (string?)null,
                _ => true, _ => 42, _ => (string?)null));
        }
    }
}
