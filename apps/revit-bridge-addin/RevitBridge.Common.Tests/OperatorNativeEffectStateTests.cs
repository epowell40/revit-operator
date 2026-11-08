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
