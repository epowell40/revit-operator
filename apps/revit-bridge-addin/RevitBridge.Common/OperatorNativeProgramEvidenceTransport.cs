using System;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace RevitBridge.Common
{
    // Lossless transport only. Receipt authentication and task verification
    // remain the consumer's responsibility; never compact signed native data.
    public static class OperatorNativeProgramEvidenceTransport
    {
        public const int MaxEvidenceBytes = 8 * 1024 * 1024;

        public static object Prepare(byte[] exactEvidence, int exitCode)
        {
            if (exactEvidence == null || exactEvidence.Length == 0 || exactEvidence.Length > MaxEvidenceBytes
                || (exitCode != 0 && exitCode != 1))
                throw new InvalidOperationException("Native C# evidence is missing or outside its bounded transport contract.");
            using var document = JsonDocument.Parse(exactEvidence);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException("Native C# evidence must be an object.");
            var plain = new { schema = "operator.native-program-workstation-result.v1", exitCode, evidence = document.RootElement.Clone() };
            if (JsonSerializer.SerializeToUtf8Bytes(plain).Length <= OperatorCourierResultCompactor.MaxTransportResultBytes)
                return plain;

            using var stream = new MemoryStream();
            using (var gzip = new GZipStream(stream, CompressionLevel.Optimal, leaveOpen: true))
                gzip.Write(exactEvidence, 0, exactEvidence.Length);
            using var sha = SHA256.Create();
            var compressed = new { schema = "operator.native-program-workstation-result.v1", exitCode,
                evidenceTransport = new { encoding = "gzip+base64", uncompressedBytes = exactEvidence.Length,
                    sha256 = "sha256:" + BitConverter.ToString(sha.ComputeHash(exactEvidence)).Replace("-", "").ToLowerInvariant(),
                    data = Convert.ToBase64String(stream.ToArray()) } };
            if (JsonSerializer.SerializeToUtf8Bytes(compressed).Length > OperatorCourierResultCompactor.MaxTransportResultBytes)
                throw new InvalidOperationException("Native C# evidence exceeds lossless courier capacity; retained evidence must be reconciled before retrying.");
            return compressed;
        }
    }
}
