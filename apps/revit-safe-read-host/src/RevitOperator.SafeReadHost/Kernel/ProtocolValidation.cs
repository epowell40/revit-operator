using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal static class ProtocolValidation
    {
        public static bool FixedTimeSecretEquals(string? expected, string? actual)
        {
            if (expected == null || actual == null)
                return false;

            byte[] expectedBytes = Encoding.UTF8.GetBytes(expected);
            byte[] actualBytes = Encoding.UTF8.GetBytes(actual);
            int difference = expectedBytes.Length ^ actualBytes.Length;
            int length = expectedBytes.Length > actualBytes.Length ? expectedBytes.Length : actualBytes.Length;
            for (int index = 0; index < length; index++)
            {
                byte left = index < expectedBytes.Length ? expectedBytes[index] : (byte)0;
                byte right = index < actualBytes.Length ? actualBytes[index] : (byte)0;
                difference |= left ^ right;
            }
            return difference == 0;
        }

        public static bool IsCanonicalGuid(string? value)
        {
            if (value == null || value.Length != 36)
                return false;
            Guid parsed;
            if (!Guid.TryParseExact(value, "D", out parsed))
                return false;
            return string.Equals(parsed.ToString("D"), value, StringComparison.Ordinal);
        }

        public static bool IsBase64UrlSecret(string? value)
        {
            if (value == null || value.Length != SafeReadContract.Base64UrlSecretLength)
                return false;
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                bool allowed = (character >= 'A' && character <= 'Z') ||
                               (character >= 'a' && character <= 'z') ||
                               (character >= '0' && character <= '9') ||
                               character == '-' || character == '_';
                if (!allowed)
                    return false;
            }
            return true;
        }

        public static bool IsSha256(string? value)
        {
            if (value == null || value.Length != SafeReadContract.Sha256DigestLength ||
                !value.StartsWith("sha256:", StringComparison.Ordinal))
                return false;
            for (int index = 7; index < value.Length; index++)
            {
                char character = value[index];
                bool digit = character >= '0' && character <= '9';
                bool lowerHex = character >= 'a' && character <= 'f';
                if (!digit && !lowerHex)
                    return false;
            }
            return true;
        }

        public static string Sha256Hex(string value)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value ?? string.Empty);
            using (SHA256 algorithm = SHA256.Create())
            {
                byte[] digest = algorithm.ComputeHash(bytes);
                StringBuilder builder = new StringBuilder(digest.Length * 2);
                for (int index = 0; index < digest.Length; index++)
                    builder.Append(digest[index].ToString("x2", CultureInfo.InvariantCulture));
                return builder.ToString();
            }
        }

        public static string Sha256Digest(string value)
        {
            return "sha256:" + Sha256Hex(value);
        }

        public static bool IsCapabilityId(string? value)
        {
            return IsPrefixedBase64Url(value, "src1_", SafeReadContract.CapabilityIdLength);
        }

        public static bool IsReceiptId(string? value)
        {
            return IsPrefixedBase64Url(value, "srr1_", SafeReadContract.ReceiptIdLength);
        }

        private static bool IsPrefixedBase64Url(string? value, string prefix, int exactLength)
        {
            if (value == null || value.Length != exactLength || !value.StartsWith(prefix, StringComparison.Ordinal))
                return false;
            for (int index = prefix.Length; index < value.Length; index++)
            {
                char character = value[index];
                bool allowed = (character >= 'A' && character <= 'Z') ||
                               (character >= 'a' && character <= 'z') ||
                               (character >= '0' && character <= '9') ||
                               character == '-' || character == '_';
                if (!allowed)
                    return false;
            }
            return true;
        }

        public static string NewSecret()
        {
            byte[] bytes = new byte[SafeReadContract.SecretByteCount];
            using (RandomNumberGenerator generator = RandomNumberGenerator.Create())
                generator.GetBytes(bytes);
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        public static bool IsBoundedProtocolToken(string? value, int maximumLength)
        {
            if (value == null || value.Length == 0 || value.Length > maximumLength)
                return false;
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                bool allowed = (character >= 'A' && character <= 'Z') ||
                               (character >= 'a' && character <= 'z') ||
                               (character >= '0' && character <= '9') ||
                               character == '-' || character == '_' || character == '.' || character == ':';
                if (!allowed)
                    return false;
            }
            return true;
        }
    }
}
