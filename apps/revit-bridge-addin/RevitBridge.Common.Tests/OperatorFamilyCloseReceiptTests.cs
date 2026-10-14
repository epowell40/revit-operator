using System;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public class OperatorFamilyCloseReceiptTests
    {
        [Fact]
        public void MissingSessionRefusalNeverClaimsClosureOrReconcilesAnEarlierWrite()
        {
            // Exact session from natural short-request binder 17. The old
            // untyped HTTP500 remains unknown; only new native preflight proof
            // qualifies the current refusal as no effect.
            var id = "4e462ecb6fad44da870cac8b02624191";
            var old = new { error = "Family edit session not found (expired or closed).", type = "System.InvalidOperationException" };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(old,"apply","POST","/revit/close-doc").EffectState);
            foreach (var save in new[] {false,true})
            {
                var raw = JsonSerializer.Serialize(OperatorFamilyCloseReceipt.SessionUnavailable(id, save));
                Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(JsonNode.Parse(raw)!,"apply","POST","/revit/close-doc").EffectState);
                foreach (var key in new[] {"session_lookup_succeeded","native_save_started","native_close_started"})
                {
                    var bad = JsonNode.Parse(raw)!; bad["family_close_receipt"]![key] = true;
                    Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(bad,"apply","POST","/revit/close-doc").EffectState);
                }
                var wrong = JsonNode.Parse(raw)!; wrong["familyDocumentId"] = new string('b',32);
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(wrong,"apply","POST","/revit/close-doc").EffectState);
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(JsonNode.Parse(raw)!,"apply","POST","/revit/save-family-doc").EffectState);
            }
            Assert.Throws<ArgumentException>(()=>OperatorFamilyCloseReceipt.SessionUnavailable("",false));
        }
        [Fact]
        public void CloseNeedsVerifiedNativeClosureAndExactSession()
        {
            var id = new string('a',32);
            var raw=JsonSerializer.Serialize(new {ok=true,closed=true,saved=false,familyDocumentId=id,
                family_close_receipt=OperatorFamilyCloseReceipt.Closed(id,false,true,true)});
            var good=JsonNode.Parse(raw)!;
            Assert.Equal("none",OperatorAttemptSuccessfulSettlement.Classify(good,"apply","POST","/revit/close-doc").EffectState);
            foreach(var key in new[]{"native_close_returned","document_closed","session_unregistered"})
            {
                var bad=JsonNode.Parse(raw)!;bad["family_close_receipt"]![key]=false;
                Assert.Equal("unknown",OperatorAttemptSuccessfulSettlement.Classify(bad,"apply","POST","/revit/close-doc").EffectState);
            }
            var wrong=JsonNode.Parse(raw)!;wrong["familyDocumentId"]=new string('b',32);
            Assert.Equal("unknown",OperatorAttemptSuccessfulSettlement.Classify(wrong,"apply","POST","/revit/close-doc").EffectState);
            var saved=JsonNode.Parse(raw)!;saved["saved"]=true;saved["family_close_receipt"]!["save_requested"]=true;
            Assert.Equal("unknown",OperatorAttemptSuccessfulSettlement.Classify(saved,"apply","POST","/revit/close-doc").EffectState);
            Assert.Throws<InvalidOperationException>(()=>OperatorFamilyCloseReceipt.Closed(id,false,false,true));
        }
    }
}
