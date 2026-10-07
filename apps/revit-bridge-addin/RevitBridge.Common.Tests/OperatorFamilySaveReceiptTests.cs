using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorFamilySaveReceiptTests
    {
        [Fact]
        public void SaveRequiresStableFileAndExactSession()
        {
            var file = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".rfa");
            try
            {
                File.WriteAllText(file, "test fixture bytes");
                var session = new string('a', 32);
                var raw = JsonSerializer.Serialize(new { ok = true, saved = true, familyDocumentId = session, filePath = file,
                    family_save_receipt = OperatorFamilySaveReceipt.Saved(session, file, true) });
                Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(JsonNode.Parse(raw)!, "apply", "POST", "/revit/save-family-doc").EffectState);
                foreach (var field in new[] { "native_save_returned", "document_path_verified", "stable_read" })
                {
                    var changed = JsonNode.Parse(raw)!; changed["family_save_receipt"]![field] = false;
                    Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(changed, "apply", "POST", "/revit/save-family-doc").EffectState);
                }
                var wrong = JsonNode.Parse(raw)!; wrong["familyDocumentId"] = new string('b', 32);
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(wrong, "apply", "POST", "/revit/save-family-doc").EffectState);
                Assert.Throws<InvalidOperationException>(() => OperatorFamilySaveReceipt.Saved(session, file, false));
                File.WriteAllText(file, "");
                Assert.Throws<InvalidOperationException>(() => OperatorFamilySaveReceipt.Saved(session, file, true));
            }
            finally { File.Delete(file); }
        }
    }
}
