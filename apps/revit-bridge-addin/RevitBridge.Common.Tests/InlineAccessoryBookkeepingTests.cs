using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public sealed class InlineAccessoryBookkeepingTests
    {
        [Fact] public void KnownPipeCenterlineUsesTheSameParentBoundObservationContract()
        {
            // Installed Revit API: OST_PipeCurvesCenterLine = -2008045.
            var center=Fixture()["before"]!["centerlines"]![0]!.DeepClone().AsObject();
            center["categoryId"]=-2008045;
            Assert.True(InlineAccessoryBookkeeping.IsCenterlineCategory(-2008045));
            InlineAccessoryBookkeeping.ValidateCenterlines(JsonSerializer.SerializeToElement(new[]{center}));
            foreach(var invalid in new[]{"category","parent","class","schema"})
            {
                var bad=center.DeepClone().AsObject();
                if(invalid=="category")bad["categoryId"]=-1234567;
                if(invalid=="parent")bad["parentId"]=-1;
                if(invalid=="class")bad["className"]="Autodesk.Revit.DB.FamilyInstance";
                if(invalid=="schema")bad["schemaGuids"]!.AsArray().Add("foreign");
                Assert.ThrowsAny<Exception>(()=>InlineAccessoryBookkeeping.ValidateCenterlines(JsonSerializer.SerializeToElement(new[]{bad})));
            }
        }
        [Fact] public void UnavailableInternalLayoutIsExplicitAndNeverReadsValuesOrDependencies()
        {
            var metadata=Profile();metadata.Remove("parameters");var calls=0;
            var row=InlineAccessoryBookkeeping.ObserveInternalCandidate(JsonSerializer.SerializeToElement(metadata),
                ()=>throw new AccessViolationException("private native details"),
                ()=>{calls++;return JsonSerializer.SerializeToElement(new object[0]);},()=>{calls++;return new long[0];},retainUnavailableLayout:true);
            Assert.True(row.HasValue);Assert.Equal(0,calls);
            Assert.Equal("parameter_layout_read_failed",row.Value.GetProperty("parameterObservation").GetProperty("reason").GetString());
            Assert.False(row.Value.TryGetProperty("parameters",out _));Assert.False(row.Value.TryGetProperty("dependentIds",out _));
            Assert.DoesNotContain("private native details",row.Value.GetRawText());
        }
        [Fact] public void DefaultAndNonLayoutFailuresStillPropagate()
        {
            var profile=Profile();var metadata=profile.DeepClone().AsObject();metadata.Remove("parameters");
            var layout=JsonSerializer.SerializeToElement(profile["parameters"]!.AsArray().Select(p=>new {
                id=p!["id"]!.GetValue<long>(),storage=p["storage"]!.GetValue<string>(),readOnly=true}));
            Assert.Throws<AccessViolationException>(()=>InlineAccessoryBookkeeping.ObserveInternalCandidate(JsonSerializer.SerializeToElement(metadata),
                ()=>throw new AccessViolationException(),()=>layout,()=>new long[0]));
            Assert.Throws<AccessViolationException>(()=>InlineAccessoryBookkeeping.ObserveInternalCandidate(JsonSerializer.SerializeToElement(metadata),
                ()=>layout,()=>throw new AccessViolationException(),()=>new long[0],retainUnavailableLayout:true));
            Assert.Throws<InvalidOperationException>(()=>InlineAccessoryBookkeeping.ObserveInternalCandidate(JsonSerializer.SerializeToElement(metadata),
                ()=>throw new InvalidOperationException(),()=>layout,()=>new long[0],retainUnavailableLayout:true));
        }
        [Fact] public void UnavailableLayoutDoesNotBecomeTransitionCoverage()
        {
            var f=Fixture();var row=Profile();row.Remove("parameters");row["elementId"]=777L;row["uniqueId"]="unavailable-layout";
            row["parameterObservation"]=JsonNode.Parse("{\"status\":\"unavailable\",\"reason\":\"parameter_layout_read_failed\",\"error\":\"AccessViolationException\"}");
            foreach(var stage in new[]{"before","after"})f[stage]!["unavailableInternals"]=new JsonArray(row.DeepClone());
            var result=Check(f);Assert.DoesNotContain(777L,result.Modified);Assert.DoesNotContain(777L,result.Added);
            f["after"]!["unavailableInternals"]![0]!["uniqueId"]="changed";
            Assert.ThrowsAny<Exception>(()=>Check(f));
        }
        [Fact] public void StandaloneInternalProjectionNeedsNoMechanicalSystemOrCenterline()
        {
            var state=Fixture()["before"]!.DeepClone().AsObject();
            state.Remove("system");state.Remove("centerlines");
            InlineAccessoryBookkeeping.ValidateInternalCandidates(JsonSerializer.SerializeToElement(state));
            Assert.ThrowsAny<Exception>(()=>InlineAccessoryBookkeeping.Validate(JsonSerializer.SerializeToElement(state)));
        }
        [Theory]
        [InlineData("scan")] [InlineData("class")] [InlineData("value")] [InlineData("closure")] [InlineData("duplicate")]
        public void StandaloneInternalProjectionRetainsExactGuards(string mode)
        {
            var state=Fixture()["before"]!.DeepClone().AsObject();
            state.Remove("system");state.Remove("centerlines");
            switch(mode){
                case "scan":state["candidateScanComplete"]=false;break;
                case "class":state["internals"]![0]!["className"]="Other";break;
                case "value":state["internals"]![0]!["parameters"]![0]!["value"]="42";break;
                case "closure":state["internals"]![0]!["dependentIds"]!.AsArray().Add(999);break;
                case "duplicate":state["internals"]!.AsArray().Add(state["internals"]![0]!.DeepClone());break;
            }
            Assert.ThrowsAny<Exception>(()=>InlineAccessoryBookkeeping.ValidateInternalCandidates(JsonSerializer.SerializeToElement(state)));
        }
        private static JsonNode Fixture() => JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","inline-accessory-bookkeeping97.json")))!;
        private static (long[] Added,long[] Modified) Check(JsonNode f) => InlineAccessoryBookkeeping.RequireTransition(
            JsonSerializer.SerializeToElement(f["before"]),JsonSerializer.SerializeToElement(f["after"]),10,20,30,new long[]{10,20,30,40,50});
        private static JsonObject Profile()
        {
            var profile=Fixture()["before"]!["internals"]![0]!.DeepClone().AsObject();
            profile.Remove("dependentIds");return profile;
        }
        [Theory]
        [InlineData("bounds")] [InlineData("location")] [InlineData("type")] [InlineData("schema")]
        [InlineData("parameters")] [InlineData("writable")] [InlineData("value")]
        public void DefiniteNonCandidateDoesNotReadIrrelevantDependencies(string mode)
        {
            var profile=Profile();
            switch(mode){
                case "bounds":profile["hasBounds"]=true;break;
                case "location":profile["hasLocation"]=true;break;
                case "type":profile["typeId"]=42;break;
                case "schema":profile["schemaGuids"]!.AsArray().Add("schema");break;
                case "parameters":profile["parameters"]!.AsArray().RemoveAt(0);break;
                case "writable":profile["parameters"]![0]!["readOnly"]=false;break;
                case "value":profile["parameters"]![0]!["value"]="42";break;
            }
            var calls=0;
            var result=InlineAccessoryBookkeeping.ObserveInternalCandidate(JsonSerializer.SerializeToElement(profile),()=>{
                calls++;throw new InvalidOperationException("Ancillary dependency bound exceeded.");});
            Assert.Null(result);Assert.Equal(0,calls);
        }
        [Fact] public void QualifiedCandidateKeepsExactDependenciesAndClosureGuard()
        {
            var f=Fixture();var old=f["before"]!["internals"]![0]!;
            var deps=old["dependentIds"]!.AsArray().Select(v=>v!.GetValue<long>()).ToArray();var calls=0;
            var result=InlineAccessoryBookkeeping.ObserveInternalCandidate(JsonSerializer.SerializeToElement(Profile()),()=>{calls++;return deps;});
            Assert.Equal(1,calls);Assert.True(result.HasValue);
            Assert.Equal(JsonSerializer.Serialize(old),result.Value.GetRawText());
            f["before"]!["internals"]![0]=JsonNode.Parse(result.Value.GetRawText());Check(f);
            f["before"]!["internals"]![0]!["dependentIds"]!.AsArray().Add(999);
            Assert.ThrowsAny<Exception>(()=>Check(f));
        }
        [Fact] public void QualifiedCandidateFailuresAndDependencyBoundsRemainFailures()
        {
            var profile=JsonSerializer.SerializeToElement(Profile());
            Assert.Throws<InvalidOperationException>(()=>InlineAccessoryBookkeeping.ObserveInternalCandidate(profile,()=>throw new InvalidOperationException("native read failed")));
            foreach(var deps in new[]{Enumerable.Range(1,66).Select(x=>(long)x).ToArray(),new long[]{1,1},new long[]{0}})
                Assert.ThrowsAny<Exception>(()=>InlineAccessoryBookkeeping.ObserveInternalCandidate(profile,()=>deps));
        }
        [Fact] public void DerivedProxyAndExactSystemDeltaAreCoveredButNotHiddenState()
        {
            var result=Check(Fixture()); Assert.Equal(new long[]{21},result.Added);
            Assert.Equal(new long[]{11,21,80,90,91},result.Modified.OrderBy(x=>x));
        }
        [Theory]
        [InlineData("scan")] [InlineData("class")] [InlineData("schema")] [InlineData("write")] [InlineData("dependency")]
        [InlineData("system")] [InlineData("member")] [InlineData("network")] [InlineData("parent")]
        [InlineData("input")] [InlineData("shape")] [InlineData("missing")]
        public void UncoveredOrChangedProjectionRequiresRollback(string mode)
        {
            var f=Fixture(); var a=f["after"]!;
            switch(mode){
                case "scan":a["candidateScanComplete"]=false;break;
                case "class":a["internals"]![0]!["className"]="Foreign";break;
                case "schema":a["internals"]![0]!["schemaGuids"]!.AsArray().Add("schema");break;
                case "write":a["internals"]![0]!["parameters"]![0]!["readOnly"]=false;break;
                case "dependency":a["internals"]![0]!["dependentIds"]!.AsArray().Add(999);break;
                case "system":a["system"]!["typeId"]=999;break;
                case "member":a["system"]!["members"]!.AsArray().Clear();break;
                case "network":a["system"]!["network"]!.AsArray().RemoveAt(0);break;
                case "parent":a["centerlines"]![1]!["parentId"]=40;break;
                case "input":a["centerlines"]![0]!["parameters"]![0]!["value"]="100";break;
                case "shape":a["centerlines"]![0]!["parentParameters"]![0]!["readOnly"]=true;break;
                case "missing":a["internals"]!.AsArray().RemoveAt(0);break;
            }
            Assert.ThrowsAny<Exception>(()=>Check(f));
        }
        [Fact] public void ExactProvisional85ParametersPreserveTinyElevationRoundoff()
        {
            using var d=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","inline-split-parameters85.json")));
            var r=d.RootElement;
            Assert.True(InlineAccessoryParameterPreservation.Matches(r.GetProperty("before").GetString()!,r.GetProperty("retained").GetString()!,false));
            Assert.True(InlineAccessoryParameterPreservation.Matches(r.GetProperty("before").GetString()!,r.GetProperty("created").GetString()!,true));
        }
    }
}
