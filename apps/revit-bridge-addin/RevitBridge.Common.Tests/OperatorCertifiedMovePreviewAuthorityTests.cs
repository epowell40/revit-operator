using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorCertifiedMovePreviewAuthorityTests
    {
        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void NativeTransactionMetadataPreservesCertifiedMoveProofAndRejectsContradictions(bool preview)
        {
            var start = new OperatorCertifiedMoveExecutionStart("sha256:" + new string('a', 64), preview ? "preview" : "apply", 0, 0, 0, 2, -0.5, 0.25);
            var result = new Dictionary<string, object?>
            {
                ["status"] = preview ? "Dry Run" : "Moved", ["movedIds"] = new[] { 4821L },
                ["skipped"] = Array.Empty<object>(), ["warnings"] = Array.Empty<string>(),
                ["snapshots"] = new[] { new { id = 4821L,
                    before = new { kind = "LocationPoint", pointXyz = new[] { 0d, 0d, 0d }, rotationRadians = 0d },
                    after = new { kind = "LocationPoint", pointXyz = new[] { 2d, -0.5, 0.25 }, rotationRadians = 0d } } },
                ["movedTogether"] = false, ["rolledBack"] = preview
            };
            using var legacy = JsonDocument.Parse(JsonSerializer.Serialize(result));
            var hash = OperatorCertifiedMovePreviewAuthority.ComputeCertifiedMoveResultHash(legacy.RootElement);
            result["success"] = true;
            result["transaction"] = preview ? OperatorNativeTransactionReceipt.RolledBack(Array.Empty<long>()) : OperatorNativeTransactionReceipt.Committed(new[] { 4821L });
            result["changeTracking"] = new { exhaustiveChangeInventory = true };
            if (!preview) { result["applied"] = true; result["verified"] = true; result["ok"] = true; }
            void Verify()
            {
                using var wire = JsonDocument.Parse(JsonSerializer.Serialize(result));
                if (preview) OperatorCertifiedMovePreviewAuthority.RequirePreviewResult(wire.RootElement, 4821L, start);
                else OperatorCertifiedMovePreviewAuthority.RequireApplyResult(wire.RootElement, 4821L, start);
                Assert.Equal(hash, OperatorCertifiedMovePreviewAuthority.ComputeCertifiedMoveResultHash(wire.RootElement));
                using var projected = JsonDocument.Parse(JsonSerializer.Serialize(
                    OperatorCertifiedMovePreviewAuthority.ProjectCertifiedMoveWireResult(wire.RootElement)));
                // Backend/MCP exact-key verifiers intentionally keep this legacy
                // contract; richer ordinary responses must not leak into it.
                Assert.Equal(new[] { "movedIds", "movedTogether", "rolledBack", "skipped", "snapshots", "status", "warnings" },
                    projected.RootElement.EnumerateObject().Select(p => p.Name).OrderBy(x => x, StringComparer.Ordinal));
                foreach (var point in new[] { "before", "after" })
                    Assert.Equal(new[] { "kind", "pointXyz" }, projected.RootElement.GetProperty("snapshots")[0].GetProperty(point)
                        .EnumerateObject().Select(p => p.Name).OrderBy(x => x, StringComparer.Ordinal));
                Assert.Equal(hash, OperatorCertifiedMovePreviewAuthority.ComputeCertifiedMoveResultHash(projected.RootElement));
            }
            Verify();
            var receipt = result["transaction"];
            foreach (var wrong in new[] { OperatorNativeTransactionReceipt.Unknown("Pending"),
                preview ? OperatorNativeTransactionReceipt.Committed(new[] { 4821L }) : OperatorNativeTransactionReceipt.RolledBack(Array.Empty<long>()) })
            {
                result["transaction"] = wrong;
                Assert.Throws<OperatorNativeHttpAdmissionException>(Verify);
            }
            result["transaction"] = receipt;
            result["success"] = false;
            Assert.Throws<OperatorNativeHttpAdmissionException>(Verify);
            result["success"] = true;
            result["unreviewed"] = true;
            Assert.Throws<OperatorNativeHttpAdmissionException>(Verify);
        }

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
