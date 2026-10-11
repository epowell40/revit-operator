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
        public void CapacityRefusalProvesNoOpenAndNeverInventsSuccess()
        {
            var raw = JsonSerializer.Serialize(OperatorFamilySessionReceipt.CapacityRefusal(3, 3));
            foreach (var path in new[] { "/revit/open-family-doc", "/revit/edit-family-from-instance" })
            {
                var result = OperatorAttemptSuccessfulSettlement.Classify(JsonNode.Parse(raw)!, "apply", "POST", path);
                Assert.Equal("none", result.EffectState);
                Assert.True(result.RequestDispatched);
                Assert.Equal("native_receipt", result.EffectAuthority);
                Assert.Equal("family_session_capacity_reached", result.EffectReason);
            }
            foreach (var field in new[] { "native_open_started", "retained_sessions_unchanged", "model_write_performed", "file_write_performed" })
            {
                var altered = JsonNode.Parse(raw)!;
                altered["family_session_receipt"]![field] = field != "retained_sessions_unchanged";
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(altered, "apply", "POST", "/revit/open-family-doc").EffectState);
            }
            var insufficient = JsonNode.Parse(raw)!; insufficient["family_session_receipt"]!["retained_count"] = 2;
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(insufficient, "apply", "POST", "/revit/open-family-doc").EffectState);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(JsonNode.Parse(raw)!, "apply", "POST", "/revit/load-family-doc").EffectState);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(new { error = "Close an existing family edit session before opening another; retained edits were not discarded." }, "apply", "POST", "/revit/open-family-doc").EffectState);
            Assert.Throws<ArgumentOutOfRangeException>(() => OperatorFamilySessionReceipt.CapacityRefusal(2, 3));
        }

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
