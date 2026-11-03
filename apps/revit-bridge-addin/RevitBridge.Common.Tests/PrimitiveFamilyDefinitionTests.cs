using System;
using System.Collections.Generic;
using RevitBridge.Common.FamilyEvolution;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class PrimitiveFamilyDefinitionTests
    {
        private static PrimitiveFamilyDefinition Box() => new PrimitiveFamilyDefinition
        {
            category = "Mechanical Equipment", shapes = new List<PrimitiveFamilyShape>
            { new PrimitiveFamilyShape { widthFt = 1, depthFt = .5, heightFt = 2 } }
        };

        [Fact]
        public void CompositeKeepsDistinctEditableDimensionIdentities()
        {
            var d = Box();
            d.shapes.Add(new PrimitiveFamilyShape { id = "flue", kind = "cylinder", diameterFt = .5, heightFt = 1, originFeet = new[] { .5, .25, 2.0 } });
            d.Validate();
            Assert.Equal("body_Width", d.ParameterName(d.shapes[0], "Width"));
            Assert.Equal("flue_Height", d.ParameterName(d.shapes[1], "Height"));
            Assert.True(d.instanceDimensions);
        }

        [Theory]
        [InlineData(double.NaN)] [InlineData(double.PositiveInfinity)]
        [InlineData(-1)] [InlineData(0)] [InlineData(.001)] [InlineData(1001)]
        public void InvalidPhysicalSizeIsRejectedBeforeOpeningFamily(double value)
        {
            var d = Box(); d.shapes[0].widthFt = value;
            Assert.Throws<ArgumentException>(() => d.Validate());
        }

        [Theory]
        [InlineData("BOX")] [InlineData("sphere")] [InlineData("")]
        public void UnsupportedShapeIsNotSilentlyABox(string kind)
        {
            var d = Box(); d.shapes[0].kind = kind; Assert.Throws<ArgumentException>(() => d.Validate());
        }

        [Fact]
        public void MixedDimensionsAndCaseCollidingNamesCannotDescribeDifferentGeometry()
        {
            var d = Box(); d.shapes[0].diameterFt = 3; Assert.Throws<ArgumentException>(() => d.Validate());
            d = Box(); d.shapes.Add(new PrimitiveFamilyShape { id = "BODY", widthFt = 1, depthFt = 1, heightFt = 1 });
            Assert.Throws<ArgumentException>(() => d.Validate());
        }

        [Fact]
        public void ScopeAndOriginAreExplicit()
        {
            var d = Box(); d.instanceDimensions = false; d.Validate();
            Assert.Equal("Width", d.ParameterName(d.shapes[0], "Width"));
            d.shapes[0].originFeet = new[] { 0.0, double.NaN, 0.0 }; Assert.Throws<ArgumentException>(() => d.Validate());
            d = Box(); d.category = "Text Notes"; Assert.Throws<ArgumentException>(() => d.Validate());
            d = Box(); d.typeName = "bad/name"; Assert.Throws<ArgumentException>(() => d.Validate());
        }
    }
}
