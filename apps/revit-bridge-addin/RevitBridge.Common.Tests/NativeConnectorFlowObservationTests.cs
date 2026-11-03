using System;
using System.Linq;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public sealed class NativeConnectorFlowObservationTests
    {
        [Theory][InlineData("DomainHvac")][InlineData("DomainPiping")]
        public void AssignedFlowHasNativeUnitsAndExplicitMeaning(string domain)
        {
            var r=NativeConnectorFlowObservation.Read(domain,()=>100.0/60,()=>"Preset",()=>"In");
            Assert.Equal("observed",r.GetProperty("status").GetString());
            Assert.Equal(100.0/60,r.GetProperty("flow").GetDouble());
            Assert.Equal("cubic_feet_per_second",r.GetProperty("units").GetString());
            Assert.Equal("assigned_connector_inputs",r.GetProperty("meaning").GetString());
            Assert.Equal("Preset",r.GetProperty("configuration").GetString());
        }
        [Theory][InlineData("flow")][InlineData("configuration")][InlineData("direction")]
        public void AFailedGetterIsUnavailableNeverZero(string field)
        {
            var r=NativeConnectorFlowObservation.Read("DomainHvac",()=>field=="flow"?throw new InvalidOperationException("private detail"):1,
                ()=>field=="configuration"?throw new InvalidOperationException():"Preset",()=>field=="direction"?throw new InvalidOperationException():"In");
            Assert.Equal("unavailable",r.GetProperty("status").GetString());Assert.Equal(field,r.GetProperty("field").GetString());
            Assert.False(r.TryGetProperty("flow",out _));Assert.DoesNotContain("private detail",r.GetRawText());
        }
        [Theory][InlineData(double.NaN)][InlineData(double.PositiveInfinity)][InlineData(-1.0)]
        public void InvalidAssignedNumbersStayUnknown(double value)
        {Assert.Equal("unavailable",NativeConnectorFlowObservation.Read("DomainHvac",()=>value,()=>"Preset",()=>"In").GetProperty("status").GetString());}
        [Fact] public void RealZeroIsObservedAndNonFlowDomainsDoNotInvokeGetters()
        {
            Assert.Equal(0,NativeConnectorFlowObservation.Read("DomainHvac",()=>0,()=>"Preset",()=>"Out").GetProperty("flow").GetDouble());
            var r=NativeConnectorFlowObservation.Read("DomainElectrical",()=>throw new Exception(),()=>throw new Exception(),()=>throw new Exception());
            Assert.Equal("not_applicable",r.GetProperty("status").GetString());Assert.False(r.TryGetProperty("flow",out _));
        }
        [Fact] public void ModelVisibleChangesRemainBoundedAndExplicitlyUnverified()
        {
            object State(double value) => new { nativePlacementState=new { complete=true,owners=Enumerable.Range(1,25).Select(id=>new {
                elementId=id,uniqueId="uid-"+id,calculatedConnectorFlows=new[] { new { connectorId=1,observation=new { status="observed",value } } } }) } };
            var r=NativeConnectorFlowObservation.Changes(State(100.0/60),State(0));
            Assert.Equal(25,r.GetProperty("count").GetInt32());Assert.Equal(20,r.GetProperty("items").GetArrayLength());
            Assert.True(r.GetProperty("truncated").GetBoolean());Assert.False(r.GetProperty("verification").GetBoolean());
            Assert.False(r.GetProperty("displayVerified").GetBoolean());Assert.Contains("assigned",r.GetProperty("guidance").GetString());
            Assert.Equal(0,NativeConnectorFlowObservation.Changes(State(1),State(1)).GetProperty("count").GetInt32());
            var missing=NativeConnectorFlowObservation.Changes(State(1),new { });
            Assert.Equal("unavailable",missing.GetProperty("status").GetString());Assert.False(missing.TryGetProperty("count",out _));
        }
    }
}
