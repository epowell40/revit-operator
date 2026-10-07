using System;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorFamilySessionReceiptTests
    {
        [Fact]
        public void OpeningIsKnownPreparationNotAProjectCommit()
        {
            var id = new string('a', 32);
            var raw = JsonSerializer.Serialize(new { ok = true, familyDocumentId = id,
                family_session_receipt = OperatorFamilySessionReceipt.Opened(id, "instance", "42", true, true) });
            foreach (var path in new[] { "/revit/open-family-doc", "/revit/edit-family-from-instance" })
            {
                var result = OperatorAttemptSuccessfulSettlement.Classify(JsonNode.Parse(raw)!, "apply", "POST", path);
                Assert.Equal("none", result.EffectState);
                Assert.Equal("native_receipt", result.EffectAuthority);
                Assert.Equal(new[] { "family_session:" + id }, result.ReceiptRefs);
            }
            foreach (var field in new[] { "document_valid", "session_registered", "model_write_performed", "file_write_performed" })
            {
                var changed = JsonNode.Parse(raw)!;
                changed["family_session_receipt"]![field] = field.EndsWith("performed");
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(changed, "apply", "POST", "/revit/open-family-doc").EffectState);
            }
            var stale = JsonNode.Parse(raw)!; stale["familyDocumentId"] = new string('b', 32);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(stale, "apply", "POST", "/revit/open-family-doc").EffectState);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(JsonNode.Parse(raw)!, "apply", "POST", "/revit/save-family-doc").EffectState);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(new { ok = true, familyDocumentId = id }, "apply", "POST", "/revit/open-family-doc").EffectState);
            Assert.Throws<InvalidOperationException>(() => OperatorFamilySessionReceipt.Opened(id, "instance", "42", false, true));
        }
    }
}
