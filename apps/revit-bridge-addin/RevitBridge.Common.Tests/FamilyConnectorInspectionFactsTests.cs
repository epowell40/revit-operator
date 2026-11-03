using System;
using System.Collections.Generic;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class FamilyConnectorInspectionFactsTests
    {
        private sealed class Source : IFamilyConnectorInspectionSource
        {
            public string ShapeValue = "Round";
            public bool ThrowShape, ThrowDomain, ThrowRadius, ThrowOrigin;
            public double RadiusValue = 0.25, WidthValue = 1, HeightValue = 2;
            public double[] DirectionValue = new[] { 0d, 0d, 1d };
            public double[][] AxesValue = new[] { new[] { 1d, 0d, 0d }, new[] { 0d, 1d, 0d }, new[] { 0d, 0d, 1d } };
            public string Shape => ThrowShape ? throw new InvalidOperationException("unavailable shape") : ShapeValue;
            public string Domain => ThrowDomain ? throw new InvalidOperationException("unavailable domain") : "DomainHvac";
            public string SystemClassification => "SupplyAir";
            public bool IsPrimary => true;
            public double[] Origin => ThrowOrigin ? throw new InvalidOperationException("unavailable origin") : new[] { 0d, 0d, 0.5d };
            public double[] Direction => DirectionValue;
            public double[][] Axes => AxesValue;
            public double Radius => ThrowRadius ? throw new InvalidOperationException("radius getter failed") : RadiusValue;
            public double Width => WidthValue;
            public double Height => HeightValue;
        }

        private static JsonDocument Observe(Source s) => JsonDocument.Parse(JsonSerializer.Serialize(FamilyConnectorInspectionFacts.Observe(s)));

        [Fact]
        public void RoundNativeFactsRetainFamilyCoordinatesAndFeetWithoutAnInsertionClaim()
        {
            using var d = Observe(new Source()); var r = d.RootElement;
            Assert.Equal("family_document_current_type",r.GetProperty("coordinateSpace").GetString());
            Assert.Equal("feet",r.GetProperty("lengthUnit").GetString());
            Assert.Equal("DomainHvac",r.GetProperty("domain").GetProperty("value").GetString());
            Assert.Equal(0.25,r.GetProperty("radius").GetProperty("value").GetDouble());
            Assert.Equal(0.5,r.GetProperty("origin").GetProperty("value")[2].GetDouble());
            Assert.False(r.GetProperty("width").GetProperty("available").GetBoolean());
            Assert.False(r.GetProperty("height").GetProperty("available").GetBoolean());
            Assert.False(r.TryGetProperty("compatible",out _));
            Assert.False(r.TryGetProperty("connected",out _));
        }

        [Theory]
        [InlineData("Rectangular")]
        [InlineData("Oval")]
        public void NonRoundUsesWidthHeightAndNeverCallsAnInapplicableRadius(string shape)
        {
            using var d = Observe(new Source { ShapeValue=shape,ThrowRadius=true });var r=d.RootElement;
            Assert.Equal(1,r.GetProperty("width").GetProperty("value").GetDouble());
            Assert.Equal(2,r.GetProperty("height").GetProperty("value").GetDouble());
            Assert.Equal("not_applicable",r.GetProperty("radius").GetProperty("reason").GetString());
        }

        [Fact]
        public void GetterFailuresStayExplicitAndDoNotDiscardIndependentFacts()
        {
            using var d=Observe(new Source { ThrowDomain=true,ThrowRadius=true,ThrowOrigin=true });var r=d.RootElement;
            foreach(var key in new[]{"domain","radius","origin"})
            {
                Assert.False(r.GetProperty(key).GetProperty("available").GetBoolean());
                Assert.Equal(JsonValueKind.Null,r.GetProperty(key).GetProperty("value").ValueKind);
                Assert.Equal("getter_failed",r.GetProperty(key).GetProperty("reason").GetString());
            }
            Assert.True(r.GetProperty("shape").GetProperty("available").GetBoolean());
            Assert.True(r.GetProperty("axes").GetProperty("available").GetBoolean());
        }

        [Theory]
        [InlineData(double.NaN)]
        [InlineData(double.PositiveInfinity)]
        [InlineData(-1)]
        [InlineData(0)]
        public void InvalidNativeDimensionCannotBecomeAUsableSize(double radius)
        {
            using var d=Observe(new Source{RadiusValue=radius});var fact=d.RootElement.GetProperty("radius");
            Assert.False(fact.GetProperty("available").GetBoolean());
            Assert.Equal("invalid_value",fact.GetProperty("reason").GetString());
        }

        [Fact]
        public void InvalidShapeDoesNotReportMinusOneDimensionsAsPhysicalSizes()
        {
            using var d=Observe(new Source{ShapeValue="Invalid",RadiusValue=-1,WidthValue=-1,HeightValue=-1});
            foreach(var key in new[]{"radius","width","height"})Assert.False(d.RootElement.GetProperty(key).GetProperty("available").GetBoolean());
        }

        [Fact]
        public void MalformedVectorIsNotSilentlyNormalizedIntoGeometry()
        {
            using var d=Observe(new Source{DirectionValue=new[]{0d,double.NaN,1d}});
            Assert.False(d.RootElement.GetProperty("direction").GetProperty("available").GetBoolean());
            Assert.True(d.RootElement.GetProperty("origin").GetProperty("available").GetBoolean());
        }

        [Fact]
        public void NonConnectorSummaryIsByteEquivalentAndConnectorKeepsIdentity()
        {
            var row=new Dictionary<string,object?>{["elementId"]=42L,["uniqueId"]="source-42",["runtimeType"]="Extrusion",["name"]="body",["category"]=""};
            var before=JsonSerializer.Serialize(row);
            FamilyConnectorInspectionFacts.AddToSummary(row,null);
            Assert.Equal(before,JsonSerializer.Serialize(row));
            row["runtimeType"]="ConnectorElement";
            FamilyConnectorInspectionFacts.AddToSummary(row,new Source());
            using var d=JsonDocument.Parse(JsonSerializer.Serialize(row));
            Assert.Equal(42,d.RootElement.GetProperty("elementId").GetInt64());
            Assert.Equal("source-42",d.RootElement.GetProperty("uniqueId").GetString());
            Assert.True(d.RootElement.GetProperty("connector").GetProperty("shape").GetProperty("available").GetBoolean());
        }

        [Fact]
        public void MissingShapeDoesNotCallAnyDimensionGetter()
        {
            using var d=Observe(new Source{ThrowShape=true,ThrowRadius=true});
            foreach(var key in new[]{"radius","width","height"})
                Assert.Equal("shape_unavailable",d.RootElement.GetProperty(key).GetProperty("reason").GetString());
            Assert.True(d.RootElement.GetProperty("domain").GetProperty("available").GetBoolean());
        }

        [Fact]
        public void IncompleteAxesRemainUnavailableInsteadOfClaimingAnOrientation()
        {
            using var d=Observe(new Source{AxesValue=new[]{new[]{1d,0d,0d},new[]{0d,1d,0d}}});
            Assert.False(d.RootElement.GetProperty("axes").GetProperty("available").GetBoolean());
            Assert.Equal("invalid_value",d.RootElement.GetProperty("axes").GetProperty("reason").GetString());
            Assert.True(d.RootElement.GetProperty("radius").GetProperty("available").GetBoolean());
        }
    }
}
