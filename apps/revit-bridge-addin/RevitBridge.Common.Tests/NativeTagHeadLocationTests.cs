using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class NativeTagHeadLocationTests
    {
        [Fact]
        public void NativeHeadAndSeparateSummaryPreserveDistinctKindAndStableOwnership()
        {
            var xyz = new[] {2d,3d,4d};
            var anchor = NativeTagHeadLocation.Create("tag-uid",41,"view-uid",xyz);
            xyz[0]=99; var exposed=anchor.pointXyz; exposed[1]=88;
            Assert.Equal(new[]{2d,3d,4d},anchor.pointXyz);
            using var wire=JsonDocument.Parse(JsonSerializer.Serialize(anchor));
            Assert.Equal("TagHead",wire.RootElement.GetProperty("kind").GetString());
            Assert.Equal("tag-uid",wire.RootElement.GetProperty("elementUniqueId").GetString());
            using var summary=JsonDocument.Parse(JsonSerializer.Serialize(anchor.SummaryLocation()));
            Assert.Equal("tagHead",summary.RootElement.GetProperty("type").GetString());
            Assert.Equal(41,summary.RootElement.GetProperty("ownerViewId").GetInt64());
            Assert.Equal("view-uid",summary.RootElement.GetProperty("ownerViewUniqueId").GetString());
            Assert.Equal(4,summary.RootElement.GetProperty("z").GetDouble());
        }

        [Fact]
        public void IncompleteNonfiniteOrUnownedAnchorsAreNeverCoercedToModelPoints()
        {
            foreach(var point in new double[][] {null!,Array.Empty<double>(),new[]{1d,2d},new[]{double.NaN,2d,3d},new[]{1d,double.PositiveInfinity,3d},new[]{1d,2d,double.NegativeInfinity}})
                Assert.Throws<ArgumentException>(()=>NativeTagHeadLocation.Create("tag",41,"view",point));
            Assert.Throws<ArgumentException>(()=>NativeTagHeadLocation.Create("",41,"view",new[]{1d,2d,3d}));
            Assert.Throws<ArgumentException>(()=>NativeTagHeadLocation.Create("tag",0,"view",new[]{1d,2d,3d}));
            Assert.Throws<ArgumentException>(()=>NativeTagHeadLocation.Create("tag",41," ",new[]{1d,2d,3d}));
        }

        [Fact]
        public void RetainedCommittedFailureStillSettlesAppliedWithoutMovementProof()
        {
            using var fixture=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","tag-head-move-readback-259.json")));
            var raw=fixture.RootElement.GetProperty("native_failed");
            using var hash=SHA256.Create();
            var actual="sha256:"+string.Concat(hash.ComputeHash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(raw))).Select(b=>b.ToString("x2")));
            Assert.Equal(fixture.RootElement.GetProperty("retained_failed_payload_sha256").GetString(),actual);
            var response=JsonSerializer.Deserialize<Dictionary<string,object?>>(raw.GetRawText())!;
            var settled=OperatorAttemptSuccessfulSettlement.Classify(response,"apply","POST","/revit/move-elements");
            Assert.Equal("applied",settled.EffectState);
            Assert.Contains("element_id:631097",settled.AffectedTargetIdentities);
            Assert.False(raw.GetProperty("verified").GetBoolean());
            Assert.Empty(raw.GetProperty("snapshots").EnumerateArray());
        }

        [Fact]
        public void CommittedTagMoveUsesPersistedAnchorAndKeepsCommitWhenReadbackFails()
        {
            foreach(var available in new[]{true,false})
            {
                int mutations=0;
                var before=NativeTagHeadLocation.Create("tag",41,"view",new[]{2d,3d,4d});
                var response=OperatorNativeTransactionExecution.Execute(()=>"Started",()=>"Committed",()=>throw new Exception("Do not replay or roll back a retained commit"),()=>"Committed",
                    ()=>{mutations++;return new Dictionary<string,object?>{["movedIds"]=new[]{631097L},["snapshots"]=new[]{new{id=631097L,before,after=before}}};},
                    ()=>OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(),new[]{631097L},Array.Empty<long>()));
                response.Remove("snapshots");
                OperatorNativeTransactionExecution.ReadCommitted(response,()=>{
                    if(!available)throw new InvalidOperationException("Native tag-head anchor readback is unavailable.");
                    return new Dictionary<string,object?>{["snapshots"]=new[]{new{id=631097L,before,after=NativeTagHeadLocation.Create("tag",41,"view",new[]{2d,3d,4.55})}}};
                });
                Assert.Equal(1,mutations);Assert.Equal(available,response["verified"]);
                Assert.Equal("applied",OperatorAttemptSuccessfulSettlement.Classify(response,"apply","POST","/revit/move-elements").EffectState);
                Assert.Equal(available,response.ContainsKey("snapshots"));
            }
        }
    }
}
