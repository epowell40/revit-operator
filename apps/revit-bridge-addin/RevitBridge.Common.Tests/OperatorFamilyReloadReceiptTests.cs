using System;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorFamilyReloadReceiptTests
    {
        [Fact]
        public void LoadRequiresBoundNativeReturnAndProjectReadback()
        {
            var id = new string('a', 32);
            var raw = JsonSerializer.Serialize(new { ok = true, familyDocumentId = id, loadedFamilyId = 42,
                family_reload_receipt = OperatorFamilyReloadReceipt.Loaded(id, 42, "family-unique", true) });
            foreach (var path in new[] { "/revit/load-family-doc", "/revit/reload-family-edit-session" })
            {
                var result = OperatorAttemptSuccessfulSettlement.Classify(JsonNode.Parse(raw)!, "apply", "POST", path);
                Assert.Equal("applied", result.EffectState);
                Assert.Equal("native_receipt", result.EffectAuthority);
                Assert.Equal(new[] { "element:42" }, result.AffectedTargetIdentities);
                foreach (var flag in new[] { "native_load_returned", "project_readback_verified" })
                {
                    var changed = JsonNode.Parse(raw)!; changed["family_reload_receipt"]![flag] = false;
                    Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(changed, "apply", "POST", path).EffectState);
                }
                var wrong = JsonNode.Parse(raw)!; wrong["loadedFamilyId"] = 43;
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(wrong, "apply", "POST", path).EffectState);
                wrong = JsonNode.Parse(raw)!; wrong["familyDocumentId"] = new string('b', 32);
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(wrong, "apply", "POST", path).EffectState);
            }
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(JsonNode.Parse(raw)!, "apply", "POST", "/revit/save-family-doc").EffectState);
            Assert.Throws<InvalidOperationException>(() => OperatorFamilyReloadReceipt.Loaded(id, 42, "family-unique", false));
        }
    }
}
