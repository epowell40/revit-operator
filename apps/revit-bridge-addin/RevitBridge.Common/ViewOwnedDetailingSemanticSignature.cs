using System;
using System.Security.Cryptography;
using System.Text;

namespace RevitBridge.Common
{
    /// <summary>A copy-stable digest of observable detailing attributes, without owner or element IDs.</summary>
    public static class ViewOwnedDetailingSemanticSignature
    {
        public static string Create(string className, string categoryToken, string? typeUniqueId,
            string? visibleText, string geometryKey)
        {
            if (string.IsNullOrWhiteSpace(className) || string.IsNullOrWhiteSpace(categoryToken)
                || string.IsNullOrWhiteSpace(geometryKey))
                throw new ArgumentException("Detailing signature requires class, category and relative geometry.");
            var source = new StringBuilder();
            foreach (var field in new[] { className, categoryToken, typeUniqueId ?? "", visibleText ?? "", geometryKey })
                source.Append(field.Length).Append(':').Append(field);
            using (var sha = SHA256.Create())
                return "sha256:" + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(source.ToString())))
                    .Replace("-", "").ToLowerInvariant();
        }
    }
}
