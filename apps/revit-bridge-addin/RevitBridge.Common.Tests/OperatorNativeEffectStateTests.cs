using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public class OperatorNativeEffectStateTests
    {
        private static JsonElement Json(object value)=>JsonSerializer.SerializeToElement(value);
        [Fact] public void NativeProfileAndReferenceBoundsNeverSilentlyTruncate()
        {
            Assert.Equal(new[]{1,2,3},OperatorNativeEffectState.Bounded(new[]{1,2,3},3));
            Assert.Throws<InvalidOperationException>(()=>OperatorNativeEffectState.Bounded(new[]{1,2,3,4},3));
            Assert.Throws<ArgumentException>(()=>OperatorNativeEffectState.Bounded(new[]{1},0));
            var result=Json(OperatorNativeEffectState.Observe("f","s",new long[]{1},id=>{
                var edges=OperatorNativeEffectState.Bounded(Enumerable.Range(0,2049),2048);
                return OperatorNativeEffectState.Capture(id,true,new {elementId=id,found=true,edges});
            }));
            Assert.False(result.GetProperty("complete").GetBoolean());
            var failed=Json(OperatorNativeEffectState.Observe("f","s",new long[]{1},id=>throw new InvalidOperationException("private model field value")));
            var reason=failed.GetProperty("items")[0].GetProperty("reason").GetString();
            Assert.StartsWith("native_state_read_failed:InvalidOperationException.",reason);
            Assert.DoesNotContain("private model field value",reason);Assert.True(reason!.Length<=145);
            Assert.False(failed.GetProperty("complete").GetBoolean());
        }
        [Fact] public void EqualRegionBoxesCannotHideChangedContoursFillOrConstraintReferences()
        {
            string Hash(int interior,int fill,int reference) => OperatorNativeEffectState.Capture(1,true,new {
                elementId=1,found=true,box=new[]{0,0,1,1},contour=new[]{0,interior,1},pattern=fill,reference }).stateHash!;
            Assert.NotEqual(Hash(1,2,3),Hash(2,2,3));
            Assert.NotEqual(Hash(1,2,3),Hash(1,4,3));
            Assert.NotEqual(Hash(1,2,3),Hash(1,2,4));
        }
        private static OperatorNativeEffectState.Item Opaque(long id) => OperatorNativeEffectState.Capture(id, true,
            new { elementId=id, found=true, shape=new {kind="opaque_element_public_state",privateStateInspected=false} });
        [Fact] public void OpaqueStateRequiresTrustedStableNativeVersionAndRetainsExplicitCoverage()
        {
            var store = new OperatorDocumentChangeObservationStore(1234);
            var good = Json(OperatorNativeEffectState.Observe("f", "s", new long[]{1}, Opaque, store.CaptureVersion));
            Assert.True(good.GetProperty("complete").GetBoolean());
            Assert.Equal(1234, good.GetProperty("nativeVersion").GetProperty("ProcessId").GetInt32());
            Assert.Contains("not inspected", good.GetProperty("meaning").GetString());
            var missing = Json(OperatorNativeEffectState.Observe("f", "s", new long[]{1}, Opaque));
            Assert.False(missing.GetProperty("complete").GetBoolean());
            Assert.False(missing.GetProperty("items")[0].GetProperty("complete").GetBoolean());
            Assert.Equal("opaque_state_requires_stable_native_version", missing.GetProperty("items")[0].GetProperty("reason").GetString());
        }
        [Fact] public void InterveningChangesCaptureFailuresAndForeignVersionsCannotCertifyOpaqueContinuity()
        {
            foreach (var failure in new[]{false,true})
            {
                var store=new OperatorDocumentChangeObservationStore(1234);
                var changed=Json(OperatorNativeEffectState.Observe("f","s",new long[]{1},id=>{
                    if(failure)store.RecordCaptureFailure(DateTimeOffset.UtcNow);
                    else store.Record("s","transaction",Array.Empty<string>(),new long[]{2},Array.Empty<long>(),Array.Empty<long>(),DateTimeOffset.UtcNow);
                    return Opaque(id);
                },store.CaptureVersion));
                Assert.False(changed.GetProperty("complete").GetBoolean());
                Assert.Equal(JsonValueKind.Null,changed.GetProperty("nativeVersion").ValueKind);
            }
            foreach(var mode in new[]{"foreign-session","foreign-process","foreign-epoch","throw"})
            {
                var store=new OperatorDocumentChangeObservationStore(1234);var other=new OperatorDocumentChangeObservationStore(mode=="foreign-process"?4321:1234);
                int calls=0;
                OperatorDocumentChangeVersion Capture(string session)
                {
                    if(mode=="throw")throw new InvalidOperationException();
                    return mode=="foreign-session"?store.CaptureVersion("foreign"):
                        ++calls==1?store.CaptureVersion(session):other.CaptureVersion(session);
                }
                var result=Json(OperatorNativeEffectState.Observe("f","s",new long[]{1},Opaque,Capture));
                Assert.False(result.GetProperty("complete").GetBoolean());
            }
        }
        [Theory]
        [InlineData("FamilyInstance")]
        [InlineData("ViewSchedule")]
        [InlineData("ViewSheet")]
        [InlineData("ScheduleSheetInstance")]
        [InlineData("Viewport")]
        [InlineData("ViewSheetSet")]
        [InlineData("Wall")]
        public void PublicElementObservationRequiresStableVersionWithoutClaimingPrivateGeometry(string className)
        {
            OperatorNativeEffectState.Item Public(long id) => OperatorNativeEffectState.Capture(id,true,new {
                elementId=id,found=true,className,shape=new {
                    kind="public_element_observation",privateStateInspected=false,geometryTopologyInspected=false}});
            var missing=Json(OperatorNativeEffectState.Observe("f","s",new long[]{1},Public));
            Assert.False(missing.GetProperty("complete").GetBoolean());
            var store=new OperatorDocumentChangeObservationStore(1234);
            var good=Json(OperatorNativeEffectState.Observe("f","s",new long[]{1},Public,store.CaptureVersion));
            Assert.True(good.GetProperty("complete").GetBoolean());
            var changed=Json(OperatorNativeEffectState.Observe("f","s",new long[]{1},id=>{
                store.Record("s","transaction",Array.Empty<string>(),new long[]{2},Array.Empty<long>(),Array.Empty<long>(),DateTimeOffset.UtcNow);
                return Public(id);
            },store.CaptureVersion));
            Assert.False(changed.GetProperty("complete").GetBoolean());
        }
        [Fact] public void ExactNativeStateIncludesActualIdentityAndDeletedAbsence()
        {
            var value=Json(OperatorNativeEffectState.Observe("fingerprint","session",new long[]{2,1},id=>
                OperatorNativeEffectState.Capture(id,id==1,new {elementId=id,found=id==1,position=new[]{1.0,2.0,3.0}})));
            Assert.True(value.GetProperty("complete").GetBoolean());
            Assert.Equal(new long[]{1,2},value.GetProperty("requestedElementIds").EnumerateArray().Select(i=>i.GetInt64()));
            var first=value.GetProperty("items")[0];Assert.StartsWith("sha256:",first.GetProperty("stateHash").GetString());
            Assert.Equal(1,JsonDocument.Parse(first.GetProperty("stateJson").GetString()!).RootElement.GetProperty("elementId").GetInt64());
        }
        [Fact] public void ReadFailureUnsupportedIdentityAndOversizeNeverBecomeComplete()
        {
            var failed=Json(OperatorNativeEffectState.Observe("f","s",new long[]{1},id=>throw new InvalidOperationException()));
            Assert.False(failed.GetProperty("complete").GetBoolean());
            Assert.False(OperatorNativeEffectState.Capture(1,true,new {elementId=1,found=true,text=new string('x',70000)}).complete);
            Assert.Throws<ArgumentException>(()=>OperatorNativeEffectState.Capture(1,true,new {elementId=2,found=true}));
            Assert.Throws<ArgumentException>(()=>OperatorNativeEffectState.Observe("f","s",new long[]{1,1},id=>throw new Exception()));
            var bounded=Json(OperatorNativeEffectState.Observe("f","s",Enumerable.Range(1,50).Select(n=>(long)n),id=>
                OperatorNativeEffectState.Capture(id,true,new {elementId=id,found=true,text=new string('x',60000)})));
            Assert.False(bounded.GetProperty("complete").GetBoolean());Assert.True(bounded.GetProperty("items").GetArrayLength()<50);
            Assert.Equal(bounded.GetProperty("items").EnumerateArray().Sum(i=>Encoding.UTF8.GetByteCount(i.GetProperty("stateJson").GetString()!)),
                bounded.GetProperty("observedStateBytes").GetInt32());
        }
        [Fact] public void PostCommitObserverFailurePreservesOriginalAppliedReceiptAndProgramResult()
        {
            var tx=OperatorNativeTransactionReceipt.CommittedChanges(new long[]{1},new long[]{2},new long[]{3});
            var result=new Dictionary<string,object?>{{"success",true},{"transaction",tx},{"program_result","not proof"}};
            OperatorNativeEffectState.AttachAfterCommit(result,ids=>{Assert.Equal(new long[]{1,2,3},ids);throw new InvalidOperationException();});
            Assert.Equal(true,result["success"]);Assert.Same(tx,result["transaction"]);Assert.Equal("not proof",result["program_result"]);
            Assert.False(Json(result["effect_observation"]!).GetProperty("complete").GetBoolean());
        }
        [Fact] public void FailedRolledBackUnknownAndReadResultsNeverGainCommitObservation()
        {
            foreach(var result in new[]{new Dictionary<string,object?>{{"success",false},{"transaction",OperatorNativeTransactionReceipt.Committed(new long[]{1})}},
                new Dictionary<string,object?>{{"success",true},{"transaction",OperatorNativeTransactionReceipt.RolledBack(new long[]{1})}},
                new Dictionary<string,object?>{{"success",true},{"transaction",OperatorNativeTransactionReceipt.NotStarted()}}})
            {OperatorNativeEffectState.AttachAfterCommit(result,_=>throw new Exception("must not run"));Assert.False(result.ContainsKey("effect_observation"));}
        }
    }
}
