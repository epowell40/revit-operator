using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public sealed class InlineAccessoryStagedProfileTests
    {
        private static JsonObject Profile()=>JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","inline-accessory-bookkeeping97.json")))!["before"]!["internals"]![0]!.DeepClone().AsObject();
        private static JsonElement J(JsonNode n)=>JsonSerializer.SerializeToElement(n);
        private static JsonObject Metadata(JsonObject p){var m=p.DeepClone().AsObject();m.Remove("parameters");m.Remove("dependentIds");return m;}
        private static JsonArray Layout(JsonObject p)=>new JsonArray(p["parameters"]!.AsArray().Select(x=>{var v=x!.DeepClone().AsObject();v.Remove("value");return (JsonNode)v;}).ToArray());
        [Theory][InlineData("typeId")][InlineData("hasLocation")][InlineData("hasBounds")][InlineData("schemaGuids")][InlineData("className")][InlineData("categoryId")]
        public void ExcludedMetadataNeverTouchesNativeParameters(string mode)
        {
            var m=Metadata(Profile());switch(mode){case "typeId":m[mode]=123;break;case "hasLocation":case "hasBounds":m[mode]=true;break;case "schemaGuids":m[mode]=new JsonArray("schema");break;case "className":m[mode]="Autodesk.Revit.DB.FamilyInstance";break;default:m[mode]=-1;break;}
            Assert.Null(InlineAccessoryBookkeeping.ObserveInternalCandidate(J(m),()=>throw new AccessViolationException(),()=>throw new AccessViolationException(),()=>throw new AccessViolationException()));
        }
        [Theory][InlineData("six")][InlineData("missing")][InlineData("wrongId")][InlineData("wrongStorage")][InlineData("writable")]
        public void NonmatchingLayoutNeverReadsValuesOrDependencies(string mode)
        {
            var p=Profile();var l=Layout(p);switch(mode){case "six":l.Add(l[0]!.DeepClone());break;case "missing":l.RemoveAt(0);break;case "wrongId":l[0]!["id"]=123;break;case "wrongStorage":l[0]!["storage"]="String";break;default:l[0]!["readOnly"]=false;break;}
            Assert.Null(InlineAccessoryBookkeeping.ObserveInternalCandidate(J(Metadata(p)),()=>J(l),()=>throw new AccessViolationException(),()=>throw new AccessViolationException()));
        }
        [Fact] public void QualifiedProfileKeepsExactlyTheExistingObservation()
        {
            var p=Profile();var deps=p["dependentIds"]!.AsArray().Select(x=>x!.GetValue<long>()).ToArray();var calls=0;
            var actual=InlineAccessoryBookkeeping.ObserveInternalCandidate(J(Metadata(p)),()=>{Assert.Equal(0,calls++);return J(Layout(p));},()=>{Assert.Equal(1,calls++);return J(p["parameters"]!);},()=>{Assert.Equal(2,calls++);return deps;});
            var oldProfile=p.DeepClone().AsObject();oldProfile.Remove("dependentIds");
            var old=InlineAccessoryBookkeeping.ObserveInternalCandidate(J(oldProfile),()=>deps);
            Assert.Equal(old!.Value.GetRawText(),actual!.Value.GetRawText());Assert.Equal(3,calls);
        }
        [Theory][InlineData("layout")][InlineData("values")][InlineData("dependencies")]
        public void RequiredNativeReadFailureStillBlocks(string stage)
        {
            var p=Profile();Assert.Throws<AccessViolationException>(()=>InlineAccessoryBookkeeping.ObserveInternalCandidate(J(Metadata(p)),()=>stage=="layout"?throw new AccessViolationException():J(Layout(p)),()=>stage=="values"?throw new AccessViolationException():J(p["parameters"]!),()=>throw new AccessViolationException()));
        }
        [Fact] public void NonmatchingObservedValueDoesNotGrantEligibility()
        {
            var p=Profile();p["parameters"]![0]!["value"]="123";
            Assert.Null(InlineAccessoryBookkeeping.ObserveInternalCandidate(J(Metadata(p)),()=>J(Layout(p)),()=>J(p["parameters"]!),()=>throw new Exception("Must not read dependencies")));
        }
    }
}
