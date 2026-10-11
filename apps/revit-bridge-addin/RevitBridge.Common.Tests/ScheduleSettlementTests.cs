using System;
using System.Collections.Generic;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public class ScheduleSettlementTests
    {
        // Retained October7 opv2_431f518e: planning response, no native transaction proof.
        private const string Plan = "{\"status\":\"Dry Run\",\"dryRun\":true,\"requested\":{\"name\":\"Air Device Schedule\",\"kind\":\"Regular\",\"category\":\"OST_DuctTerminal\",\"addFields\":[\"Type Mark\",\"Manufacturer\",\"Model\",\"Type\",\"Flow\",\"Count\"],\"includeLinkedFiles\":null,\"filterBySheet\":null,\"reuseIfExists\":true},\"activeView\":{\"id\":1488975,\"name\":\"Notes, Symbols & Schedules\",\"kind\":\"sheet\",\"sheetId\":1488975,\"sheetNumber\":\"M002\"},\"existing\":null,\"source\":null,\"categoryResolution\":{\"resolved\":true,\"categoryId\":-2008013,\"error\":null},\"placeOnSheet\":null}";
        [Fact]
        public void ExactPlanDoesNotClaimPreviewExecution()
        {
            var p = JsonSerializer.Deserialize<Dictionary<string, object?>>(Plan)!;
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(p,"preview","POST","/revit/create-schedule").EffectState);
            p["transaction"] = OperatorNativeTransactionReceipt.NotStarted();
            p["previewExecuted"] = false;
            var result = OperatorAttemptSuccessfulSettlement.Classify(p,"preview","POST","/revit/create-schedule");
            Assert.Equal("none",result.EffectState);
            Assert.Equal("native_transaction_not_started",result.EffectReason);
            Assert.Empty(result.AffectedTargetIdentities);
        }
        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void FailedPlacementCannotMasqueradeAsCommittedCreation(string rollback, string effect)
        {
            string status="Uninitialized";
            var result=OperatorNativeTransactionExecution.Execute(()=>status="Started",()=>status="Committed",()=>status=rollback,()=>status,
                ()=>throw new InvalidOperationException("placement failed after provisional schedule creation"),
                ()=>OperatorNativeTransactionReceipt.Committed(new long[]{42}));
            Assert.False((bool)result["success"]!);
            Assert.Equal(effect,OperatorAttemptSuccessfulSettlement.Classify(result,"apply","POST","/revit/create-schedule").EffectState);
            Assert.False(result.ContainsKey("viewId"));
        }
        [Fact]
        public void FailedPostCommitReadbackPreservesCommit()
        {
            var result=OperatorNativeTransactionExecution.Execute(()=>"Started",()=>"Committed",()=>"RolledBack",()=>"Committed",
                ()=>new Dictionary<string,object?>{["viewId"]=42},()=>OperatorNativeTransactionReceipt.CommittedChanges(new long[]{42},Array.Empty<long>(),Array.Empty<long>()));
            OperatorNativeTransactionExecution.ReadCommitted(result,()=>throw new InvalidOperationException("readback unavailable"));
            Assert.Equal("applied",OperatorAttemptSuccessfulSettlement.Classify(result,"apply","POST","/revit/create-schedule").EffectState);
            Assert.Equal(false,result["verified"]);
            Assert.Equal("CommittedWithErrors",OperatorNativeTransactionExecution.OutcomeStatus(result,"Success"));
        }
    }
}
