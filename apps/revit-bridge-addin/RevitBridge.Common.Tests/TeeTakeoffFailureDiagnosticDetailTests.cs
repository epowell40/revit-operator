using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public class TeeTakeoffFailureDiagnosticDetailTests
    {
        private static JsonNode Fixture()=>JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","tee-preservation-failure108.json")))!;
        private static JsonElement Element(JsonNode n)=>JsonSerializer.SerializeToElement(n);
        private static JsonElement Footprint(JsonNode f)=>JsonSerializer.SerializeToElement(new{
            teeId=f["tee"]!.GetValue<long>(),bridgeId=f["created"]![0]!.GetValue<long>(),fittingId=f["created"]![1]!.GetValue<long>(),retainedIds=f["retained"],
            expectedAddedIds=f["child"]!["addedIds"],expectedDeletedIds=f["child"]!["deletedIds"],addedIds=f["child"]!["addedIds"],deletedIds=f["child"]!["deletedIds"],modifiedIds=f["child"]!["modifiedIds"],allowedModifiedIds=(long[]?)null});
        [Fact] public void SyntheticSystemDifferenceIsExplicitlyTransientAndBounded()
        {
            var f=Fixture();var b=f["before"]!;var a=JsonNode.Parse(b.ToJsonString())!;
            var parameters=JsonNode.Parse(a["system"]!["parameters"]!.GetValue<string>())!.AsArray();
            var id=parameters[0]!["id"]!.GetValue<long>();parameters[0]!["value"]="deliberate diagnostic test change";a["system"]!["parameters"]=parameters.ToJsonString();
            var result=TeeTakeoffPreservationDiagnostic.Describe("transition",Element(b),Element(a),Footprint(f));using var output=JsonDocument.Parse(result);
            Assert.True(output.RootElement.GetProperty("diagnosticOnly").GetBoolean());Assert.True(output.RootElement.GetProperty("transientBeforeRollback").GetBoolean());
            Assert.Contains("system.parameters."+id,result);Assert.Contains("deliberate diagnostic test change",result);Assert.True(result.Length<=8000);
            Assert.False(output.RootElement.TryGetProperty("success",out _));Assert.False(output.RootElement.TryGetProperty("complete",out _));Assert.False(output.RootElement.TryGetProperty("preservationAfter",out _));
        }
        [Fact] public void InvalidOrOversizedInputCannotBecomePreservationEvidence()
        {
            var f=Fixture();var b=Element(f["before"]!);
            foreach(var input in new[]{JsonSerializer.SerializeToElement(new{schema="foreign"}),JsonSerializer.SerializeToElement(new{data=new string('x',1500001)})})
            {
                var result=TeeTakeoffPreservationDiagnostic.Describe("transition",b,input,Footprint(f));Assert.Contains("diagnosticOnly",result);Assert.Contains("reason",result);Assert.DoesNotContain("differences\"",result);Assert.True(result.Length<256);
            }
            Assert.Contains("unsupported_stage",TeeTakeoffPreservationDiagnostic.Describe("arbitrary private error",b,b,Footprint(f)));
        }
        [Fact] public void InvalidatedScopeAndOutputBoundsFailClosedInDiagnostics()
        {
            var f=Fixture();f["before"]!["complete"]=false;
            Assert.Contains("unavailable_state",TeeTakeoffPreservationDiagnostic.Describe("transition",Element(f["before"]!),Element(f["before"]!),Footprint(f)));
            f=Fixture();var a=JsonNode.Parse(f["before"]!.ToJsonString())!;a["system"]!["parameters"]="not-json";
            Assert.Contains("diagnostic_unavailable",TeeTakeoffPreservationDiagnostic.Describe("transition",Element(f["before"]!),Element(a),Footprint(f)));
        }
        [Fact] public void ManySyntheticDifferencesAreTruncatedWithoutSuccessClaim()
        {
            var f=Fixture();var b=f["before"]!;var a=JsonNode.Parse(b.ToJsonString())!;
            var parameters=JsonNode.Parse(a["system"]!["parameters"]!.GetValue<string>())!.AsArray();
            foreach(var row in parameters)row!["value"]=new string('x',256);a["system"]!["parameters"]=parameters.ToJsonString();
            var result=TeeTakeoffPreservationDiagnostic.Describe("transition",Element(b),Element(a),Footprint(f));using var output=JsonDocument.Parse(result);
            Assert.True(result.Length<=8000);Assert.True(output.RootElement.GetProperty("differences").GetArrayLength()<=16);
            if(parameters.Count>16)Assert.True(output.RootElement.GetProperty("differencesTruncated").GetBoolean());
        }
    }
}
