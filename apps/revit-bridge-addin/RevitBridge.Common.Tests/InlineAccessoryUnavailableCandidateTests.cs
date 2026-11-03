using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public sealed class InlineAccessoryUnavailableCandidateTests
    {
        private static JsonNode ClosureFixture()=>JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","internal-dependency-closure149.json")))!;
        private static JsonNode WithNative149Dependencies()
        {
            var f=Fixture();var actual=ClosureFixture();var r=Profile();
            // Parameter profile is synthetic; identity and complete dependency set are actual149.
            r["elementId"]=actual["owner"]!["id"]!.DeepClone();r["uniqueId"]=actual["owner"]!["unique_id"]!.DeepClone();
            r["dependentIds"]=new JsonArray(actual["dependencies"]!["items"]!.AsArray().Select(x=>x!["id"]!.DeepClone()).ToArray());
            f["before"]!["internals"]!.AsArray().Add(r);return f["before"]!;
        }
        private static JsonElement Classify(JsonNode s)
        {
            var method=typeof(InlineAccessoryBookkeeping).GetMethod("ClassifyInternalCandidates",new[]{typeof(JsonElement)});
            Assert.NotNull(method);return (JsonElement)method!.Invoke(null,new object[]{JsonSerializer.SerializeToElement(s)})!;
        }
        [Fact] public void Actual149DependencySetIsNonCoveringWithoutBlockingQualifiedGroup()
        {
            var state=WithNative149Dependencies();var before=state.ToJsonString();
            Assert.Throws<InvalidOperationException>(()=>InlineAccessoryBookkeeping.ValidateInternalCandidates(JsonSerializer.SerializeToElement(state)));
            var result=Classify(state);InlineAccessoryBookkeeping.ValidateInternalCandidates(result);
            Assert.Equal(before,state.ToJsonString());
            Assert.DoesNotContain(result.GetProperty("internals").EnumerateArray(),r=>r.GetProperty("elementId").GetInt64()==17);
            var excluded=Assert.Single(result.GetProperty("unavailableInternals").EnumerateArray());
            Assert.Equal(17,excluded.GetProperty("elementId").GetInt64());
            Assert.Equal("dependency_closure_not_eligible",excluded.GetProperty("dependencyObservation").GetProperty("reason").GetString());
            Assert.False(excluded.TryGetProperty("dependentIds",out _));
            Assert.Equal(new long[]{16,17,19,17902,17962,22072,43517,43518},excluded.GetProperty("dependencyObservation").GetProperty("observedDependentIds").EnumerateArray().Select(x=>x.GetInt64()));
        }
        [Fact] public void ClassificationPropagatesExclusionButPreservesClosedCyclesAndAllFacts()
        {
            var s=WithNative149Dependencies();
            foreach(var pair in new[]{(200L,new long[]{200,17}),(201L,new long[]{201,200}),(202L,new long[]{202,203}),(203L,new long[]{202,203}),(204L,Array.Empty<long>())})
            {
                var r=Profile();r["elementId"]=pair.Item1;r["uniqueId"]="synthetic-"+pair.Item1;
                r["dependentIds"]=new JsonArray(pair.Item2.Select(x=>JsonValue.Create(x)).ToArray());s["internals"]!.AsArray().Add(r);
            }
            var result=Classify(s);var ids=result.GetProperty("internals").EnumerateArray().Select(r=>r.GetProperty("elementId").GetInt64()).ToArray();
            Assert.Contains(202L,ids);Assert.Contains(203L,ids);Assert.DoesNotContain(200L,ids);Assert.DoesNotContain(201L,ids);Assert.DoesNotContain(204L,ids);
            Assert.Equal(new long[]{17,200,201,204},result.GetProperty("unavailableInternals").EnumerateArray().Select(r=>r.GetProperty("elementId").GetInt64()));
            Assert.Equal(s["internals"]!.AsArray().Count,result.GetProperty("internals").GetArrayLength()+result.GetProperty("unavailableInternals").GetArrayLength());
            Assert.Equal(result.GetRawText(),InlineAccessoryBookkeeping.ClassifyInternalCandidates(result).GetRawText());
        }
        [Fact] public void ClassifiedUnknownCannotEnterChangedOwnerCoverage()
        {
            var f=Fixture();var classified=Classify(WithNative149Dependencies());
            foreach(var k in new[]{"before","after"}){
                f[k]!["internals"]=JsonNode.Parse(classified.GetProperty("internals").GetRawText());
                f[k]!["unavailableInternals"]=JsonNode.Parse(classified.GetProperty("unavailableInternals").GetRawText());
            }
            var covered=Check(f).Modified;Assert.DoesNotContain(17L,covered);
            Assert.Throws<InvalidOperationException>(()=>InlineAccessoryFootprint.RequireExpected(Array.Empty<long>(),Array.Empty<long>(),new long[]{17},Array.Empty<long>(),covered));
        }
        [Theory][InlineData("duplicate")][InlineData("profile")][InlineData("null")][InlineData("negative")][InlineData("too-many")][InlineData("byte-bound")][InlineData("scan")]
        public void ClassificationDoesNotRepairMalformedOrIncompleteInput(string mode)
        {
            var s=WithNative149Dependencies();var r=s["internals"]!.AsArray().Last()!;
            switch(mode){
                case "duplicate":s["internals"]!.AsArray().Add(r.DeepClone());break;
                case "profile":r["hasLocation"]=true;break;
                case "null":r["dependentIds"]=null;break;
                case "negative":r["dependentIds"]=new JsonArray(-1);break;
                case "too-many":r["dependentIds"]=new JsonArray(Enumerable.Range(1,65).Select(x=>JsonValue.Create(x)).ToArray());break;
                case "byte-bound":r["padding"]=new string('x',1048577);break;
                case "scan":s["candidateScanComplete"]=false;break;
            }
            Assert.ThrowsAny<Exception>(()=>Classify(s));
        }
        [Fact] public void ClosedSelfOnlyCandidateCannotBeFalselyLabelledExcluded()
        {
            var state=JsonNode.Parse(Classify(WithNative149Dependencies()).GetRawText())!;
            state["unavailableInternals"]![0]!["dependencyObservation"]!["observedDependentIds"]=new JsonArray(17);
            Assert.ThrowsAny<Exception>(()=>InlineAccessoryBookkeeping.ValidateInternalCandidates(JsonSerializer.SerializeToElement(state)));
        }
        [Theory][InlineData("self")][InlineData("closure")][InlineData("profile")]
        public void FailedInventoryRetainsExactPredicateWithoutBecomingValid(string mode)
        {
            var s=Fixture()["before"]!;var row=s["internals"]![0]!;
            var id=row["elementId"]!.GetValue<long>();
            if(mode=="self")row["dependentIds"]=new JsonArray();
            else if(mode=="closure")row["dependentIds"]!.AsArray().Add(999999);
            else row["parameters"]![0]!["value"]="42";
            var method=typeof(InlineAccessoryBookkeeping).GetMethod("ValidateInternalCandidates",new[]{typeof(JsonElement),typeof(Action<string,long?>)});
            Assert.NotNull(method);string? stage=null;long? owner=null;
            Action<string,long?> callback=(s,i)=>{stage=s;owner=i;};
            var error=Assert.Throws<System.Reflection.TargetInvocationException>(()=>method!.Invoke(null,new object[]{JsonSerializer.SerializeToElement(s),callback}));
            Assert.IsType<InvalidOperationException>(error.InnerException);
            Assert.Equal(mode=="self"?"bookkeeping_self_dependency":mode=="closure"?"bookkeeping_dependency_closure":"bookkeeping_profile",stage);
            Assert.Equal(id,owner);
        }
        private static JsonNode Fixture()=>JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","inline-accessory-bookkeeping97.json")))!;
        private static JsonObject Profile(){var p=Fixture()["before"]!["internals"]![0]!.DeepClone().AsObject();p.Remove("dependentIds");p["elementId"]=999;p["uniqueId"]="unavailable-999";return p;}
        private static JsonNode Unavailable(){var p=Profile();p["dependencyObservation"]=new JsonObject{["status"]="unavailable",["reason"]="dependency_limit_exceeded",["limit"]=64,["observedAtLeast"]=65};return p;}
        private static (long[] Added,long[] Modified) Check(JsonNode f)=>InlineAccessoryBookkeeping.RequireTransition(JsonSerializer.SerializeToElement(f["before"]),JsonSerializer.SerializeToElement(f["after"]),10,20,30,new long[]{10,20,30,40,50});
        private static JsonNode WithUnavailable(){var f=Fixture();foreach(var k in new[]{"before","after"})f[k]!["unavailableInternals"]=new JsonArray(Unavailable());return f;}
        [Fact] public void SuccessfulInventoryDoesNotEmitFailureOrAlterProjection()
        {
            var state=JsonSerializer.SerializeToElement(WithUnavailable()["before"]);var text=state.GetRawText();var calls=0;
            InlineAccessoryBookkeeping.ValidateInternalCandidates(state,(_,__)=>calls++);
            Assert.Equal(0,calls);Assert.Equal(text,state.GetRawText());
        }
        [Fact] public void QualifiedSixtyFiveSentinelIsExplicitlyUnavailableNotEmpty()
        {
            // Exact retained102 failure stage/limit; profile and IDs are synthetic, not a claim about its unknown owner.
            var row=InlineAccessoryBookkeeping.ObserveInternalCandidate(JsonSerializer.SerializeToElement(Profile()),()=>Enumerable.Range(1,65).Select(x=>(long)x).ToArray());
            Assert.True(row.HasValue);Assert.Equal("unavailable",row.Value.GetProperty("dependencyObservation").GetProperty("status").GetString());Assert.False(row.Value.TryGetProperty("dependentIds",out _));
        }
        [Fact] public void UnavailableCandidateNeverPermitsItsChangedFootprint()
        {
            var r=Check(WithUnavailable());Assert.DoesNotContain(999L,r.Modified);
            InlineAccessoryFootprint.RequireExpected(new long[]{20,30,21},new long[]{20,30,21},new long[]{10},Array.Empty<long>(),r.Modified.Concat(new long[]{10,20,30}));
            Assert.Throws<InvalidOperationException>(()=>InlineAccessoryFootprint.RequireExpected(new long[]{20,30,21},new long[]{20,30,21},new long[]{999},Array.Empty<long>(),r.Modified.Concat(new long[]{10,20,30})));
        }
        [Theory][InlineData("removed")][InlineData("identity")][InlineData("duplicate")][InlineData("reason")][InlineData("bound")][InlineData("falseCoverage")][InlineData("physical")][InlineData("profile")]
        public void IncompleteOrForgedUnavailableObservationRejects(string mode)
        {
            var f=WithUnavailable();var a=f["after"]!;var u=a["unavailableInternals"]![0]!;
            switch(mode){case "removed":a["unavailableInternals"]!.AsArray().Clear();break;case "identity":u["uniqueId"]="replaced";break;case "duplicate":u["elementId"]=90;break;case "reason":u["dependencyObservation"]!["reason"]="read_error";break;case "bound":u["dependencyObservation"]!["limit"]=128;break;case "falseCoverage":u["dependentIds"]=new JsonArray(999);break;case "physical":u["elementId"]=10;break;case "profile":u["hasBounds"]=true;break;}
            Assert.ThrowsAny<Exception>(()=>Check(f));
        }
        [Fact] public void NativeReadErrorsMalformedAndExcessSentinelsRemainFailures()
        {
            var p=JsonSerializer.SerializeToElement(Profile());Assert.Throws<InvalidOperationException>(()=>InlineAccessoryBookkeeping.ObserveInternalCandidate(p,()=>throw new InvalidOperationException("native failure")));
            foreach(var d in new[]{Enumerable.Repeat(1L,65).ToArray(),Enumerable.Range(1,66).Select(x=>(long)x).ToArray(),new long[]{0}})Assert.ThrowsAny<Exception>(()=>InlineAccessoryBookkeeping.ObserveInternalCandidate(p,()=>d));
        }
        [Fact] public void LargerUnavailableCohortNeverConsumesEligibleCoverageBudget()
        {
            // Retained143 proves combined cohort >64, not its exact size or rows.
            // This synthetic boundary exercises65 unavailable identities.
            var f=Fixture();
            foreach(var k in new[]{"before","after"})
            {
                var rows=new JsonArray();
                for(int i=0;i<65;i++){var r=Unavailable();r["elementId"]=1000+i;r["uniqueId"]="unavailable-"+i;rows.Add(r);}
                f[k]!["unavailableInternals"]=rows;
            }
            var result=Check(f);Assert.DoesNotContain(result.Modified,x=>x>=1000);
            Assert.Throws<InvalidOperationException>(()=>InlineAccessoryFootprint.RequireExpected(Array.Empty<long>(),Array.Empty<long>(),new long[]{1064},Array.Empty<long>(),result.Modified));
        }
        [Fact] public void LegacyTransitionCohortStillCannotExceedSixtyFour()
        {
            var s=Fixture()["before"]!;var rows=new JsonArray();
            for(int i=0;i<65;i++){var r=Profile();r["elementId"]=1000+i;r["uniqueId"]="eligible-"+i;r["dependentIds"]=new JsonArray(1000+i);rows.Add(r);}
            s["internals"]=rows;
            Assert.ThrowsAny<Exception>(()=>InlineAccessoryBookkeeping.Validate(JsonSerializer.SerializeToElement(s)));
        }
        [Fact] public void CompleteInventoryCanExceedLegacyTransitionCohortWithinExistingByteBudget()
        {
            // Actual145 reports eligible_candidate_cohort_bound_exceeded. Its total
            // is unknown; these65 rows are synthetic boundary data, not backfilled evidence.
            var s=Fixture()["before"]!;var rows=new JsonArray();
            for(int i=0;i<65;i++){var r=Profile();r["elementId"]=1000+i;r["uniqueId"]="eligible-"+i;r["dependentIds"]=new JsonArray(1000+i);rows.Add(r);}
            s["internals"]=rows;
            InlineAccessoryBookkeeping.ValidateInternalCandidates(JsonSerializer.SerializeToElement(s));
        }
        [Fact] public void LargerInventoryStillRequiresClosedDependenciesAndByteBound()
        {
            var s=Fixture()["before"]!;var rows=new JsonArray();
            for(int i=0;i<65;i++){var r=Profile();r["elementId"]=1000+i;r["uniqueId"]="eligible-"+i;r["dependentIds"]=new JsonArray(1000+i);rows.Add(r);}
            s["internals"]=rows;
            s["internals"]![64]!["dependentIds"]=new JsonArray(1064,99999);
            Assert.ThrowsAny<Exception>(()=>InlineAccessoryBookkeeping.ValidateInternalCandidates(JsonSerializer.SerializeToElement(s)));
            s["internals"]![64]!["dependentIds"]=new JsonArray(1064);
            s["internals"]![64]!["padding"]=new string('x',1048577);
            Assert.ThrowsAny<Exception>(()=>InlineAccessoryBookkeeping.ValidateInternalCandidates(JsonSerializer.SerializeToElement(s)));
        }
        [Fact] public void UnavailableCohortCannotBypassObservationByteBound()
        {
            var s=WithUnavailable()["before"]!;
            s["unavailableInternals"]![0]!["padding"]=new string('x',1048577);
            Assert.ThrowsAny<Exception>(()=>InlineAccessoryBookkeeping.ValidateInternalCandidates(JsonSerializer.SerializeToElement(s)));
        }
    }
}
