using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>
    /// Process-local native signing authority. Its private key never leaves the
    /// Revit add-in process. The public key is observed over the authenticated
    /// native transport and then sealed into the exact request-family instance.
    /// </summary>
    public static class OperatorNativeExecutionAttestationAuthority
    {
        public const string Algorithm = "RS256";
        private static readonly RSA Key = CreateKey();
        private static readonly RSAParameters PublicParameters = Key.ExportParameters(false);
        public static readonly string ModulusBase64Url = Base64Url(PublicParameters.Modulus ?? throw new InvalidOperationException("Native attestation modulus is unavailable."));
        public static readonly string ExponentBase64Url = Base64Url(PublicParameters.Exponent ?? throw new InvalidOperationException("Native attestation exponent is unavailable."));
        public static readonly string KeyId = ComputeKeyId(ModulusBase64Url, ExponentBase64Url);

        public static object PublicBinding() => new
        {
            schema = "revit-operator.native-execution-attestation-key.v1",
            algorithm = Algorithm,
            key_id = KeyId,
            modulus_base64url = ModulusBase64Url,
            exponent_base64url = ExponentBase64Url
        };

        public static void RequireCurrentBinding(OperatorCertifiedRequestFamilyAdmission admission)
        {
            if (admission.NativeAttestationKeyId != KeyId
                || admission.NativeAttestationModulusBase64Url != ModulusBase64Url
                || admission.NativeAttestationExponentBase64Url != ExponentBase64Url)
                throw new InvalidOperationException("Request-family admission is not bound to this Revit process's native attestation authority.");
        }

        public static string SignCanonicalPayload(Dictionary<string, object?> payload)
        {
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(payload));
            var canonical = OperatorCourierCertificationEnvelopeVerifier.Canonicalize(document.RootElement);
            var bytes = new UTF8Encoding(false, true).GetBytes(canonical);
            return Base64Url(Key.SignData(bytes, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
        }

        public static bool VerifyCanonicalPayload(Dictionary<string, object?> payload, string signatureBase64Url)
        {
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(payload));
            var canonical = OperatorCourierCertificationEnvelopeVerifier.Canonicalize(document.RootElement);
            try
            {
                return Key.VerifyData(
                    new UTF8Encoding(false, true).GetBytes(canonical),
                    DecodeBase64Url(signatureBase64Url),
                    HashAlgorithmName.SHA256,
                    RSASignaturePadding.Pkcs1);
            }
            catch { return false; }
        }

        public static bool VerifyCanonicalPayloadWithPublicBinding(
            Dictionary<string, object?> payload,
            string signatureBase64Url,
            string keyId,
            string modulusBase64Url,
            string exponentBase64Url)
        {
            try
            {
                var modulus = DecodeBase64Url(modulusBase64Url);
                var exponent = DecodeBase64Url(exponentBase64Url);
                if (modulus.Length != 256
                    || exponent.Length != 3
                    || exponent[0] != 0x01 || exponent[1] != 0x00 || exponent[2] != 0x01
                    || keyId != ComputeKeyId(modulusBase64Url, exponentBase64Url)) return false;
                using var document = JsonDocument.Parse(JsonSerializer.Serialize(payload));
                var canonical = OperatorCourierCertificationEnvelopeVerifier.Canonicalize(document.RootElement);
#if NETFRAMEWORK
                using RSA verifier = new RSACryptoServiceProvider(2048);
#else
                using RSA verifier = RSA.Create(2048);
#endif
                verifier.ImportParameters(new RSAParameters { Modulus = modulus, Exponent = exponent });
                return verifier.VerifyData(
                    new UTF8Encoding(false, true).GetBytes(canonical),
                    DecodeBase64Url(signatureBase64Url),
                    HashAlgorithmName.SHA256,
                    RSASignaturePadding.Pkcs1);
            }
            catch { return false; }
        }

        public static string ComputeKeyId(string modulusBase64Url, string exponentBase64Url)
        {
            var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["algorithm"] = Algorithm,
                ["exponent_base64url"] = exponentBase64Url,
                ["modulus_base64url"] = modulusBase64Url
            };
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(payload));
            return OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                OperatorCourierCertificationEnvelopeVerifier.Canonicalize(document.RootElement));
        }

        private static RSA CreateKey()
        {
#if NETFRAMEWORK
            // RSA.Create() returns a legacy 1024-bit CSP instance on .NET
            // Framework and silently ignores a later KeySize assignment.
            return new RSACryptoServiceProvider(2048);
#else
            return RSA.Create(2048);
#endif
        }

        private static string Base64Url(byte[] value)
            => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        private static byte[] DecodeBase64Url(string value)
        {
            var normalized = value.Replace('-', '+').Replace('_', '/');
            switch (normalized.Length % 4)
            {
                case 2: normalized += "=="; break;
                case 3: normalized += "="; break;
            }
            return Convert.FromBase64String(normalized);
        }
    }
}
