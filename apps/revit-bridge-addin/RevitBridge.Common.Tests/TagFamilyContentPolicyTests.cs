using System;
using RevitBridge.Common.Annotation;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TagFamilyContentPolicyTests
    {
        [Theory]
        [InlineData("100 CFM")]
        [InlineData("100 m³/h\r")]
        [InlineData("100 m3 / h")]
        [InlineData("50 L/s")]
        [InlineData("75 lps")]
        public void AirflowProfileKeepsBoundedFlowLabels(string sampleText)
        {
            Assert.True(TagFamilyContentPolicy.ShouldKeepText("airflow_only", sampleText));
        }

        [Theory]
        [InlineData("Hersteller")]
        [InlineData("Modell")]
        [InlineData("Produkt")]
        [InlineData("Dies ist ein Beispielkommentar")]
        [InlineData("")]
        public void AirflowProfileRejectsUnrelatedLabels(string sampleText)
        {
            Assert.False(TagFamilyContentPolicy.ShouldKeepText("airflow_only", sampleText));
        }

        [Fact]
        public void NoneProfilePreservesLegacyContent()
        {
            Assert.True(TagFamilyContentPolicy.ShouldKeepText("none", "Manufacturer"));
            Assert.Equal("none", TagFamilyContentPolicy.NormalizeProfile(null));
        }

        [Fact]
        public void UnknownProfileFailsClosed()
        {
            Assert.Throws<ArgumentException>(() => TagFamilyContentPolicy.NormalizeProfile("guess"));
        }
    }
}
