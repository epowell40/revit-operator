using System;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class TeeCollateralPreservationTests
    {
        private static JsonElement Read(string body) => JsonSerializer.SerializeToElement(new {
            schema = "operator.tee_collateral.v1", complete = true,
            scope = "unchanged_connected_system_public_state", rows = new[] {
                new {elementId=1402993L,uniqueId="remote-1402993",role="physical",parentIds=new long[0],
                    state=JsonDocument.Parse(body).RootElement.Clone()}
            }
        });
        private const string Physical="{\"metadata\":{\"className\":\"Autodesk.Revit.DB.Mechanical.Duct\",\"elementId\":1402993,\"uniqueId\":\"remote-1402993\"},\"geometry\":{\"UniqueId\":\"remote-1402993\",\"geometryKind\":\"Line\",\"points\":[[0,0,0],[1,0,0]],\"ports\":[{}]},\"parameters\":[],\"connections\":[{\"origin\":[0,0,0],\"basisX\":[1,0,0],\"basisY\":[0,1,0],\"basisZ\":[0,0,1],\"peers\":[]}]}";
        private static long[] Check(JsonElement before,JsonElement after,long[] changed,long[] protectedIds)
        {
            var type=typeof(TeeTakeoffPreservation).Assembly.GetType("RevitBridge.Common.TeeCollateralPreservation");
            Assert.NotNull(type);
            return (long[])type!.GetMethod("RequireUnchanged")!.Invoke(null,new object[]{before,after,changed,protectedIds})!;
        }
        [Fact] public void ProspectiveUnchangedRemoteStateAddsOnlyRequestedCoveredOwner()
        {
            var before=Read(Physical);
            Assert.Equal(new[]{1402993L},Check(before,before,new[]{1402993L},new[]{1L,2,3,4}));
            Assert.Empty(Check(before,before,Array.Empty<long>(),new[]{1L,2,3,4}));
        }
        [Fact] public void ChangedMissingUnknownOrAliasedCollateralDoesNotGainCoverage()
        {
            var before=Read(Physical);
            foreach(var changed in new[]{Physical.Replace("[1,0,0]","[2,0,0]"),"{}",Physical.Replace("\"Line\"","\"Unknown\"")})
                Assert.ThrowsAny<Exception>(()=>Check(before,Read(changed),new[]{1402993L},new[]{1L}));
            Assert.ThrowsAny<Exception>(()=>Check(before,before,new[]{999L},new[]{1L}));
            Assert.ThrowsAny<Exception>(()=>Check(before,before,new[]{1402993L},new[]{1402993L}));
            Assert.ThrowsAny<Exception>(()=>Check(JsonDocument.Parse("{}").RootElement,before,new[]{1402993L},new[]{1L}));
        }
    }
}
