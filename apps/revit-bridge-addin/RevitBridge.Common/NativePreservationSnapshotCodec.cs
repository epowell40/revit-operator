using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text.Json;
namespace RevitBridge.Common
{
    /// <summary>Lossless transport for two native snapshots, not a comparison or
    /// authority assertion. Legacy snapshots retain their existing2MB bound.</summary>
    public static class NativePreservationSnapshotCodec
    {
        public const int MaximumBytes = 2000000;
        // Versioned placement-only transport: preserve the legacy codec bound,
        // bound each expansion independently. A full connected system can require
        // more encoded bytes than a small legacy snapshot. Model-facing projections
        // remain separately bounded. This data is never a preservation verdict.
        public const int MaximumPlacementBytes = 64000000;
        public const int MaximumPlacementSegments = 32;
        public const int MaximumPlacementEnvelopeBytes = 3000000;
        public static object PackPlacement(object value)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
            return bytes.Length <= MaximumBytes ? Pack(value) : PackSegments(bytes);
        }
        public static object PackPlacementRead(object value)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
            // Keep all existing small get-connectors response shapes unchanged.
            return bytes.Length <= MaximumBytes ? value : PackSegments(bytes);
        }
        private static object PackSegments(byte[] bytes)
        {
            if (bytes.Length > MaximumPlacementBytes)
                throw new InvalidOperationException("Native placement snapshot exceeds its bounded segmented transport.");
            var segments = new List<object>();
            var encodedLength = 0;
            for (var offset = 0; offset < bytes.Length; offset += MaximumBytes)
            {
                var count = Math.Min(MaximumBytes, bytes.Length - offset);
                var part = new byte[count]; Array.Copy(bytes, offset, part, 0, count);
                using var output = new MemoryStream();
                using (var gzip = new GZipStream(output, CompressionMode.Compress, true)) gzip.Write(part, 0, count);
                var data = Convert.ToBase64String(output.ToArray()); encodedLength += data.Length;
                if (encodedLength > MaximumPlacementEnvelopeBytes)
                    throw new InvalidOperationException("Native placement snapshot exceeds its encoded evidence bound.");
                segments.Add(new { index = segments.Count, uncompressedBytes = count,
                    sha256 = XlsxTablePlanCodec.Hash(part), data });
            }
            var result = new { schema = "operator.native_preservation_json.v2", encoding = "segmented-gzip-base64",
                uncompressedBytes = bytes.Length, sha256 = XlsxTablePlanCodec.Hash(bytes), segments };
            if (JsonSerializer.SerializeToUtf8Bytes(result).Length > MaximumPlacementEnvelopeBytes)
                throw new InvalidOperationException("Native placement snapshot envelope exceeds its evidence bound.");
            return result;
        }
        public static object Pack(object value)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
            if (bytes.Length > MaximumBytes) throw new InvalidOperationException("Native preservation snapshot exceeds its complete-read bound.");
            if (bytes.Length <= 128000) return value;
            using var output = new MemoryStream();
            using (var gzip = new GZipStream(output, CompressionMode.Compress, true)) gzip.Write(bytes, 0, bytes.Length);
            var data = Convert.ToBase64String(output.ToArray());
            // Two snapshots plus the ordinary transaction receipt must remain
            // below the existing retained evidence reader bound, without truncation.
            if (data.Length > 900000) throw new InvalidOperationException("Native preservation snapshot does not fit its lossless transport bound.");
            return new { schema = "operator.native_preservation_json.v1", encoding = "gzip-base64",
                uncompressedBytes = bytes.Length, sha256 = XlsxTablePlanCodec.Hash(bytes), data };
        }
    }
}
