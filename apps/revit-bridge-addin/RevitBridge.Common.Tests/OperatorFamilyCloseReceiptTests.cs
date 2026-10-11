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
