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

        [Theory]
        [InlineData("/revit/open-family-doc")]
        [InlineData("/revit/edit-family-from-instance")]
        public void ActiveFamilyRefusalProvesNoNativeOpenAndNamesProjectRecovery(string path)
        {
            var raw = JsonNode.Parse(@"{
                ""ok"": false,
                ""code"": ""family_session_project_document_required"",
                ""family_session_receipt"": {
                    ""schema"": ""revit-operator.family-session-open.v1"",
                    ""status"": ""project_document_required"",
                    ""active_document_kind"": ""family"",
                    ""native_open_started"": false,
                    ""retained_sessions_unchanged"": true,
                    ""model_write_performed"": false,
                    ""file_write_performed"": false
                }
            }")!;
            var result = OperatorAttemptSuccessfulSettlement.Classify(raw, "apply", "POST", path);
            Assert.Equal("none", result.EffectState);
            Assert.True(result.RequestDispatched);
            Assert.Equal("native_receipt", result.EffectAuthority);
            Assert.Equal("family_session_project_document_required", result.EffectReason);
            Assert.Empty(result.AffectedTargetIdentities);
            Assert.Empty(result.ReceiptRefs);
            var produced = JsonNode.Parse(JsonSerializer.Serialize(OperatorFamilySessionReceipt.ProjectDocumentRefusal()))!;
            Assert.Equal(raw["family_session_receipt"]!.ToJsonString(), produced["family_session_receipt"]!.ToJsonString());
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(produced, "apply", "POST", path).EffectState);
            Assert.Contains("original project tab", produced["hint"]!.GetValue<string>());
            Assert.Contains("GET /revit/context", produced["hint"]!.GetValue<string>());

            foreach (var field in new[] { "native_open_started", "retained_sessions_unchanged", "model_write_performed", "file_write_performed" })
            {
                var invalid = JsonNode.Parse(raw.ToJsonString())!;
                invalid["family_session_receipt"]![field] = field != "retained_sessions_unchanged";
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(invalid, "apply", "POST", path).EffectState);
            }
            var wrongDocument = JsonNode.Parse(raw.ToJsonString())!;
            wrongDocument["family_session_receipt"]!["active_document_kind"] = "project";
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(wrongDocument, "apply", "POST", path).EffectState);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(raw, "apply", "POST", "/revit/load-family-doc").EffectState);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(
                new { error = "Active document is a family document. Open a project document (.rvt)." }, "apply", "POST", path).EffectState);
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
