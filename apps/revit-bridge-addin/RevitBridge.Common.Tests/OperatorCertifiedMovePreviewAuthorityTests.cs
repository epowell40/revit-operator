using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorCertifiedMovePreviewAuthorityTests
    {
        [Fact]
        public void Snapshot_proof_requires_captured_start_plus_exact_sealed_vector()
        {
            var start = new OperatorCertifiedMoveExecutionStart("sha256:" + new string('a', 64), "preview", 10, 20, 30, 0.25, -0.5, 1);
            using var exact = JsonDocument.Parse("{\"before\":{\"kind\":\"LocationPoint\",\"pointXyz\":[10,20,30]},\"after\":{\"kind\":\"LocationPoint\",\"pointXyz\":[10.25,19.5,31]}}");
            OperatorCertifiedMovePreviewAuthority.RequireExactSnapshotDelta(
                exact.RootElement.GetProperty("before"), exact.RootElement.GetProperty("after"), start, "preview");

            using var wrongDelta = JsonDocument.Parse("{\"before\":{\"kind\":\"LocationPoint\",\"pointXyz\":[10,20,30]},\"after\":{\"kind\":\"LocationPoint\",\"pointXyz\":[10.5,19.5,31]}}");
            Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorCertifiedMovePreviewAuthority.RequireExactSnapshotDelta(
                    wrongDelta.RootElement.GetProperty("before"), wrongDelta.RootElement.GetProperty("after"), start, "preview"));
        }

        [Fact]
        public void Result_hash_uses_the_cross_runtime_ieee754_projection()
        {
            using var result = JsonDocument.Parse(
                "{\"status\":\"Dry Run\",\"movedIds\":[4821],\"skipped\":[],\"warnings\":[]," +
                "\"snapshots\":[{\"id\":4821,\"before\":{\"kind\":\"LocationPoint\",\"pointXyz\":[0,0,0]}," +
                "\"after\":{\"kind\":\"LocationPoint\",\"pointXyz\":[2,-0.5,0.25]}}]," +
                "\"movedTogether\":false,\"rolledBack\":true}");

            Assert.Equal(
                "sha256:aa71f14c13dc2abd42cb82a325e294aebb8ea7de3461ba3b541400aa3b002ee4",
                OperatorCertifiedMovePreviewAuthority.ComputeCertifiedMoveResultHash(result.RootElement));
        }
    }
}
