using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class FlexCenterlineObservationTests
    {
        private static JsonArray Centers()=>JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","flex-centerline203.json")))!["centers"]!.AsArray();
        private static JsonElement Element(JsonNode n)=>JsonSerializer.SerializeToElement(n);
        [Fact] public void ActualNativeFlexDependentsAreObservedWithoutInventingHistoricalTransition()
        {
            var rows=Centers();
            Assert.Equal(new[]{1404116L,1404205L},rows.Select(r=>r!["elementId"]!.GetValue<long>()));
            InlineAccessoryBookkeeping.ValidateCenterlines(Element(rows));
            foreach(var row in rows)Assert.True(InlineAccessoryBookkeeping.SameCenterline(Element(row!),Element(row!),false));
        }
        [Fact] public void FlexCollateralMustRemainExactlyUnchangedAndCannotCoverAnotherOwner()
        {
            var centers=Centers();var c=centers[0]!;
            var state=JsonSerializer.SerializeToElement(new{schema="operator.tee_collateral.v1",complete=true,scope="unchanged_connected_system_public_state",
                rows=new[]{new{elementId=c["elementId"]!.GetValue<long>(),uniqueId=c["uniqueId"]!.GetValue<string>(),role="centerline",parentIds=new[]{c["parentId"]!.GetValue<long>()},state=Element(c)}}});
            Assert.Equal(new[]{1404116L},TeeCollateralPreservation.RequireUnchanged(state,state,new[]{1404116L},new[]{99L}));
            Assert.ThrowsAny<Exception>(()=>TeeCollateralPreservation.RequireUnchanged(state,state,new[]{999L},new[]{99L}));
            Assert.ThrowsAny<Exception>(()=>TeeCollateralPreservation.RequireUnchanged(state,state,new[]{1404116L},new[]{1404116L}));
            var changed=JsonNode.Parse(state.GetRawText())!;changed["rows"]![0]!["state"]!["parameters"]![0]!["value"]="changed";
            Assert.ThrowsAny<Exception>(()=>TeeCollateralPreservation.RequireUnchanged(state,Element(changed),new[]{1404116L},new[]{99L}));
        }
        [Fact] public void WrongClassCategorySchemaOrProxyShapeStillRefuses()
        {
            foreach(var field in new[]{"className","categoryId","schemaGuids","parentUniqueId","parentParameters"}){
                var rows=Centers();var c=rows[0]!;
                switch(field){case "className":c[field]="Autodesk.Revit.DB.IndependentTag";break;case "categoryId":c[field]=-2008020;break;
                    case "schemaGuids":c[field]=new JsonArray("custom");break;case "parentUniqueId":c[field]="";break;default:c[field]=new JsonArray();break;}
                Assert.ThrowsAny<Exception>(()=>InlineAccessoryBookkeeping.ValidateCenterlines(Element(rows)));
            }
        }
    }
}
