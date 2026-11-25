using System;
using System.Collections.Generic;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorNativeLifecycleTests
    {
        [Fact]
        public void CadReloadRequiresTransactionAndCannotClaimApiOwnedLifecycleAuthority()
        {
            // Live 2026-11-25: CADLinkType.Reload threw "Attempt to modify the model outside of transaction."
            foreach (var action in new[] { "load", "reload" })
                Assert.False(OperatorNativeLifecycleReceipt.Supports("/revit/link-cad", action));
        }
        [Fact]
        public void DefaultSyncRetainsCompletionJustLikeExplicitSync()
        {
            Assert.True(OperatorNativeCompletionStore.SupportsActiveDocument("POST", "/revit/sync", "{}"));
            Assert.True(OperatorNativeCompletionStore.SupportsActiveDocument("POST", "/revit/sync", "{\"action\":null}"));
            Assert.False(OperatorNativeCompletionStore.SupportsActiveDocument("POST", "/revit/sync", "{\"action\":42}"));
            Assert.False(OperatorNativeCompletionStore.SupportsActiveDocument("POST", "/revit/sync", "{\"docId\":\"foreign\"}"));
        }
        [Theory]
        [InlineData("Committed", "applied")]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void CadReloadOnlySettlesFromActualTransactionStatus(string finalStatus, string effect)
        {
            var state = "Uninitialized"; int calls = 0;
            var result = OperatorNativeTransactionExecution.Execute(() => state = "Started", () => state = finalStatus,
                () => throw new Exception("must not replay"), () => state, () => {
                    Assert.Equal("Started", state); calls++;
                    return new Dictionary<string, object?> { ["status"] = "Success", ["action"] = "reload", ["linkedFileStatus"] = "Loaded" };
                }, () => OperatorNativeTransactionReceipt.Committed(Array.Empty<long>()));
            Assert.Equal(1, calls);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result,"apply","POST","/revit/link-cad").EffectState);
            Assert.False(result.ContainsKey("lifecycle_receipt"));
        }
        [Fact]
        public void WarningOnlyLifecycleAcknowledgesAll61ObservedSpaceWarningsAfterRetainingThem()
        {
            var messages = new string[61]; for (int i = 0; i < messages.Length; i++) messages[i] = "Warning";
            var retained = new List<string>(); int acknowledged = 0;
            Assert.True(OperatorLifecycleWarningPolicy.Acknowledge(true, true, messages,
                m => m == "Warning", retained.Add, m => { Assert.Equal(61, retained.Count); acknowledged++; }));
            Assert.Equal(61, acknowledged);
        }
        [Fact]
        public void MixedErrorUnknownForeignOrOtherProcessorCannotBeAcknowledged()
        {
            foreach (var severity in new[] { "Error", "DocumentCorruption", "unknown" })
            {
                var retained = new List<string>();
                Assert.False(OperatorLifecycleWarningPolicy.Acknowledge(true,true,new[]{"Warning",severity},
                    m=>m=="Warning",retained.Add,m=>throw new Exception("Must not dismiss")));
                Assert.Equal(2,retained.Count);
            }
            foreach (var scope in new[]{(false,true),(true,false)})
                Assert.False(OperatorLifecycleWarningPolicy.Acknowledge(scope.Item1,scope.Item2,new[]{"Warning"},
                    m=>throw new Exception("Must not inspect"),m=>throw new Exception("Must not retain"),m=>throw new Exception("Must not dismiss")));
        }
        [Fact]
        public void FailedWarningObservationNeverDismissesUnreportedWarnings()
        {
            int acknowledged=0;
            Assert.Throws<InvalidOperationException>(()=>OperatorLifecycleWarningPolicy.Acknowledge(true,true,new[]{1,2},
                m=>true,m=>{if(m==2)throw new InvalidOperationException("read failed");},m=>acknowledged++));
            Assert.Equal(0,acknowledged);
        }
        [Theory]
        [InlineData("/revit/link-revit", "unload")]
        [InlineData("/revit/link-revit", "reload")]
        [InlineData("/revit/link-revit", "load")]
        [InlineData("/revit/link-cad", "reload")]
        [InlineData("/revit/link-cad", "load")]
        [InlineData("/revit/sync", "sync")]
        [InlineData("/revit/sync", "reload_latest")]
        public void LifecycleCallsRetainLateCompletionRatherThanLeavingTimedOutWritesUnrecoverable(string path, string action)
        {
            Assert.True(OperatorNativeCompletionStore.SupportsActiveDocument("POST", path, JsonSerializer.Serialize(new { action })));
            Assert.False(OperatorNativeCompletionStore.SupportsActiveDocument("POST", path, JsonSerializer.Serialize(new { action, docId = "foreign" })));
            Assert.False(OperatorNativeCompletionStore.SupportsActiveDocument("POST", path, "{\"action\":\"future-action\"}"));
            Assert.Equal(path == "/revit/sync", OperatorNativeCompletionStore.SupportsActiveDocument("POST", path, "{}"));
        }
        private const string Session = "11111111111111111111111111111111";
        private static Dictionary<string, object?> Read() => new Dictionary<string, object?> { ["status"] = "Success", ["loaded"] = true };
        [Theory]
        [InlineData("/revit/sync", "sync")]
        [InlineData("/revit/sync", "reload_latest")]
        [InlineData("/revit/link-revit", "load")]
        [InlineData("/revit/link-revit", "reload")]
        [InlineData("/revit/link-revit", "unload")]
        public void NativeReturnSettlesWithoutInventingATransaction(string path, string action)
        {
            int calls = 0;
            var result = OperatorNativeLifecycleReceipt.Execute(path, action, Session, () => calls++, Read);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", path);
            Assert.Equal(1, calls); Assert.Equal("applied", settlement.EffectState);
            Assert.Equal("native_lifecycle_returned", settlement.EffectReason);
            Assert.False(result.ContainsKey("transaction"));
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/delete-elements").EffectState);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", path).EffectState);
        }
        [Fact]
        public void ThrownNativeCallIsUnknownAndNeverRetried()
        {
            int calls = 0;
            var result = OperatorNativeLifecycleReceipt.Execute("/revit/sync", "sync", Session,
                () => { calls++; throw new Exception("connection lost after dispatch"); }, () => throw new Exception("must not read"));
            Assert.Equal(1, calls); Assert.Equal("Error", result["status"]);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/sync").EffectState);
        }
        [Fact]
        public void ReadbackFailureDoesNotEraseReturnedSyncOrCauseReplay()
        {
            int calls=0;
            var result=OperatorNativeLifecycleReceipt.Execute("/revit/sync", "sync", Session, () => calls++, () => throw new Exception("read failed"));
            Assert.Equal(1,calls); Assert.Equal("Error",result["status"]);
            Assert.Equal("applied",OperatorAttemptSuccessfulSettlement.Classify(result,"apply","POST","/revit/sync").EffectState);
        }
        [Fact]
        public void InvalidInputsNeverInvokeNativeAndProseCannotSettle()
        {
            Assert.Throws<ArgumentException>(() => OperatorNativeLifecycleReceipt.Execute("/revit/link-cad", "unload", Session, () => throw new Exception(), Read));
            Assert.Throws<ArgumentException>(() => OperatorNativeLifecycleReceipt.Execute("/revit/sync", "sync", "", () => throw new Exception(), Read));
            Assert.Equal("unknown",OperatorAttemptSuccessfulSettlement.Classify(new { status="Success", message="Synced" },"apply","POST","/revit/sync").EffectState);
        }
        [Fact]
        public void ForgedOrIncompleteReceiptCannotBorrowTransactionAuthority()
        {
            var result=OperatorNativeLifecycleReceipt.Execute("/revit/sync","sync",Session,()=>{},Read);
            var receipt=JsonSerializer.Deserialize<Dictionary<string,object?>>(JsonSerializer.Serialize(result["lifecycle_receipt"]))!;
            receipt["native_call_returned"]=false;
            result["lifecycle_receipt"]=receipt;
            result["transaction"]=OperatorNativeTransactionReceipt.Committed(new long[]{1});
            Assert.Equal("unknown",OperatorAttemptSuccessfulSettlement.Classify(result,"apply","POST","/revit/sync").EffectState);
        }
    }
}
