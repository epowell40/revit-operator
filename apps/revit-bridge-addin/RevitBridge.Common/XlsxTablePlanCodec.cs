using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RevitBridge.Common
{
    public static class XlsxTablePlanCodec
    {
        public const int MaxBytes = 16 * 1024 * 1024;
        private static readonly JsonSerializerOptions Json = new JsonSerializerOptions { PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate };
        public static (string Packed, string Sha256) Encode(XlsxTableLayoutPlan plan)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(plan);
            if (bytes.Length > MaxBytes) throw new InvalidOperationException("Complete table plan exceeds16MiB; select a bounded range instead of truncating.");
            using (var output = new MemoryStream())
            {
                using (var gzip = new GZipStream(output, CompressionMode.Compress, true)) gzip.Write(bytes, 0, bytes.Length);
                return (Convert.ToBase64String(output.ToArray()), Hash(bytes));
            }
        }
        public static XlsxTableLayoutPlan Decode(string packed, string expectedSha256)
        {
            if (packed == null || packed.Length > MaxBytes * 2) throw new InvalidOperationException("Packed plan exceeds its complete-read bound.");
            using (var input = new MemoryStream(Convert.FromBase64String(packed), false))
            using (var gzip = new GZipStream(input, CompressionMode.Decompress))
            using (var output = new MemoryStream())
            {
                var buffer = new byte[8192];int count;
                while ((count = gzip.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (output.Length + count > MaxBytes) throw new InvalidOperationException("Expanded plan exceeds16MiB.");
                    output.Write(buffer, 0, count);
                }
                var bytes = output.ToArray();if (Hash(bytes) != expectedSha256) throw new InvalidOperationException("Retained table plan changed.");
                var plan = JsonSerializer.Deserialize<XlsxTableLayoutPlan>(bytes, Json) ?? throw new InvalidOperationException("Retained table plan is missing.");
                XlsxTableAxes.Validate(plan.Range);
                if (plan.Pages.Count == 0 || plan.Pages.Count > 500 || plan.Pages.Select(p => p.Index).Distinct().Count() != plan.Pages.Count)
                    throw new InvalidOperationException("Retained table parts are invalid.");
                foreach (var cell in plan.Pages.SelectMany(p => p.Cells))
                    cell.Style = plan.Styles.TryGetValue(cell.StyleIndex, out var style) ? style : throw new InvalidOperationException("Retained source style is missing.");
                return plan;
            }
        }
        public static string Hash(string text) => Hash(Encoding.UTF8.GetBytes(text));
        public static string Hash(byte[] bytes)
        { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    }
}
