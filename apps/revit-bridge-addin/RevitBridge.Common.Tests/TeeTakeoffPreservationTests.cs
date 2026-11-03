using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class TeeTakeoffPreservationTests
    {
        // Synthetic transition expectations; IDs 1404060/1404063 are the retained
        // diagnostic104 deletion pair. This fixture does not assert live success.
        private const long Tee = 1404060, Center = 1404063, Bridge = 80, Fitting = 81;
        private static Dictionary<string, object?> Row(params object?[] fields)
        { var d = new Dictionary<string, object?>(); for (int i=0;i<fields.Length;i+=2) d.Add((string)fields[i]!, fields[i+1]); return d; }
        private static Dictionary<string, object?> Identity(long id) => Row("elementId",id,"uniqueId","u"+id);
        private static Dictionary<string, object?> Owner(long id) => Row("elementId",id,"uniqueId","u"+id,"typeId",900,
            "state",Row("UniqueId","u"+id,"metadata",Row("type",900,"phase",1,"demolished",-1,"workset",1,"level",2),"geometryKind","Line","parameters","[]"));
        private static Dictionary<string, object?> Centerline(long id, long parent) => Row("elementId",id,"uniqueId","u"+id,
            "parentId",parent,"parentUniqueId","u"+parent,"className","Autodesk.Revit.DB.Element","categoryId",-2008001,
            "schemaGuids",new string[0],"parameters",new object[0],"parentParameters",new object[0]);
        private static Dictionary<string, object?> State(bool after)
        {
            var owners = after ? new[]{1L,2,3,Bridge,Fitting} : new[]{1L,2,3,Tee};
            return Row("schema","operator.tee_takeoff_replacement_state.v1","complete",true,"scope","active_document_public_semantic_projection",
                "requestedElementIds",owners,"owners",owners.Select(Owner).ToArray(),"types",new[]{Row("elementId",900,"uniqueId","type900","parameters","[]")},
                "requestedRemovedIds",after?new[]{Tee,Center}:new long[0],"removed",after?new[]{Row("elementId",Tee,"exists",false,"uniqueId",null),Row("elementId",Center,"exists",false,"uniqueId",null)}:new object[0],
                "centerlines",after?new[]{Centerline(20,1),Centerline(82,Bridge),Centerline(83,Fitting)}:new[]{Centerline(20,1),Centerline(Center,Tee)},
                "system",Row("elementId",500,"uniqueId","sys","className","Autodesk.Revit.DB.Mechanical.MechanicalSystem","typeId",501,"typeUniqueId","systype",
                    "parameters","[]","typeParameters","[]","members",new[]{Identity(600)},"network",owners.Concat(new[]{600L}).OrderBy(x=>x).Select(Identity).ToArray()),
                "schedulePreservation",Row("schema","operator.annotation_schedule_read.v1","complete",true,"requestedElementIds",new[]{700L},"items",new[]{Row("elementId",700,"complete",true,"text","same")}));
        }
        private static long[] Check(Dictionary<string, object?> after) => TeeTakeoffPreservation.RequireTransition(JsonSerializer.SerializeToElement(State(false)),
            JsonSerializer.SerializeToElement(after),Tee,Bridge,Fitting,new[]{1L,2,3});
        [Fact] public void ParentBoundReplacementPreservesExistingPublicStateAndExactFootprint()
        {
            var allowed=Check(State(true));
            Assert.Equal(new[]{1L,2,3,20,80,81,82,83,500,700},allowed.OrderBy(x=>x));
            TeeTakeoffPreservation.RequireFootprint(new[]{80L,81,82,83},new[]{Tee,Center},allowed,new[]{83L,80,82,81},new[]{Center,Tee},new[]{1L,2,3,500,700});
        }
        [Fact] public void UnknownOrDeletedModifiedOwnerAndIncompleteAddedDeletedSetsReject()
        {
            var allowed=Check(State(true));
            foreach(var bad in new[]{999L,Center,Tee,900}) Assert.Throws<InvalidOperationException>(()=>
                TeeTakeoffPreservation.RequireFootprint(new[]{80L,81,82,83},new[]{Tee,Center},allowed,new[]{80L,81,82,83},new[]{Tee,Center},new[]{bad}));
            Assert.Throws<InvalidOperationException>(()=>TeeTakeoffPreservation.RequireFootprint(new[]{80L,81,82,83},new[]{Tee,Center},allowed,new[]{80L,81},new[]{Tee,Center},new long[0]));
            Assert.Throws<InvalidOperationException>(()=>TeeTakeoffPreservation.RequireFootprint(new[]{80L,81,82,83},new[]{Tee,Center},allowed,new[]{80L,81,82,83},new[]{Tee},new long[0]));
        }
        [Fact] public void AlteredRetainedInputIdentitySystemScheduleTypeAndAbsenceReject()
        {
            void Bad(Action<Dictionary<string,object?>> mutate){var a=State(true);mutate(a);Assert.ThrowsAny<Exception>(()=>Check(a));}
            Bad(a=>((Dictionary<string,object?>[])a["owners"]!)[0]["uniqueId"]="foreign");
            Bad(a=>((Dictionary<string,object?>)((Dictionary<string,object?>[])a["owners"]!)[0]["state"]!)["parameters"]="[{\"id\":1,\"storage\":\"String\",\"value\":\"changed\"}]");
            Bad(a=>((Dictionary<string,object?>)a["system"]!)["members"]=new[]{Identity(601)});
            Bad(a=>((Dictionary<string,object?>)a["system"]!)["parameters"]="changed");
            Bad(a=>((Dictionary<string,object?>[])a["types"]!)[0]["parameters"]="changed");
            Bad(a=>((Dictionary<string,object?>)a["schedulePreservation"]!)["complete"]=false);
            Bad(a=>((Dictionary<string,object?>[])((Dictionary<string,object?>)a["schedulePreservation"]!)["items"]!)[0]["text"]="changed");
            Bad(a=>((Dictionary<string,object?>[])a["removed"]!)[0]["exists"]=true);
            Bad(a=>((Dictionary<string,object?>[])a["centerlines"]!)[0]["parentUniqueId"]="foreign");
            Bad(a=>((Dictionary<string,object?>)((Dictionary<string,object?>)((Dictionary<string,object?>[])a["owners"]!)[4]["state"]!)["metadata"]!)["level"]=-1);
            Bad(a=>a["complete"]=false);
        }
        [Theory]
        [InlineData("{}", true)]
        [InlineData("{\"elementIds\":[1],\"includeTeeReplacementState\":true,\"replacementRemovedIds\":[2],\"replacementTypeIds\":[3],\"preservationScheduleIds\":[4]}", true)]
        [InlineData("{\"replacementRemovedIds\":[]}", false)]
        [InlineData("{\"includeTeeReplacementState\":\"true\"}", false)]
        [InlineData("{\"elementIds\":[1],\"includeTeeReplacementState\":true,\"replacementRemovedIds\":[null],\"replacementTypeIds\":[],\"preservationScheduleIds\":[]}", false)]
        [InlineData("{\"elementIds\":[1],\"includeTeeReplacementState\":true,\"replacementRemovedIds\":[1],\"replacementTypeIds\":[],\"preservationScheduleIds\":[]}", false)]
        [InlineData("{\"elementIds\":[1],\"includeTeeReplacementState\":true,\"includeInlineAccessoryState\":true,\"replacementRemovedIds\":[],\"replacementTypeIds\":[],\"preservationScheduleIds\":[]}", false)]
        [InlineData("{\"elementIds\":[1],\"includeTeeReplacementState\":true,\"onlyOpenPhysicalConnectors\":true,\"replacementRemovedIds\":[],\"replacementTypeIds\":[],\"preservationScheduleIds\":[]}", false)]
        public void ExistingReadRouteSeparatesPhysicalFromRemovedAndAncillaryScopes(string text,bool expected)
        { using var json=JsonDocument.Parse(text);Assert.Equal(expected,DuctVerificationInspectionPolicy.TryValidate(json.RootElement,out _)); }
    }
}
