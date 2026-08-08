using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativeExecutionAttestationAuthorityTests
    {
        [Fact]
        public void Process_local_key_signs_exact_canonical_receipt_and_rejects_tamper()
        {
            var payload = new Dictionary<string, object?>
            {
                ["schema"] = "revit-operator.certified-family-execution-receipt.v1",
                ["request_instance_hash"] = "sha256:" + new string('a', 64),
                ["outcome"] = "rolled_back"
            };
            var signature = OperatorNativeExecutionAttestationAuthority.SignCanonicalPayload(payload);
            Assert.True(OperatorNativeExecutionAttestationAuthority.VerifyCanonicalPayloadForTests(payload, signature));
            payload["outcome"] = "committed";
            Assert.False(OperatorNativeExecutionAttestationAuthority.VerifyCanonicalPayloadForTests(payload, signature));
            Assert.Equal(
                OperatorNativeExecutionAttestationAuthority.KeyId,
                OperatorNativeExecutionAttestationAuthority.ComputeKeyId(
                    OperatorNativeExecutionAttestationAuthority.ModulusBase64Url,
                    OperatorNativeExecutionAttestationAuthority.ExponentBase64Url));
        }
    }
}
