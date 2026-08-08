using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Runtime.CompilerServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Common
{
    /// <summary>
    /// Immutable wire binding emitted by one reviewed request-family validator.
    /// This object is never an authority by itself. Native admission validates
    /// it against the exact effective body and the embedded policy record.
    /// </summary>
    public sealed class OperatorCertifiedRequestFamilyAdmission
    {
        public const string Schema = "revit-operator.certified-request-family-admission.v1";
        public const string MoveOneFamilyId = "revit-operator.certified-move-one.request-family.v1";
        public const string MoveOneFamilyHash = "sha256:cef4b3d5613abd85772cb844a91376d057d7f835a0c4691d7c461bb010bf460b";

        public string FamilyId { get; internal set; } = "";
        public string FamilyHash { get; internal set; } = "";
        public string RequestInstanceHash { get; internal set; } = "";
        public string AdmissionSessionId { get; internal set; } = "";
        public string Phase { get; internal set; } = "";
        public string? PreviewInstanceHash { get; internal set; }
        public string? PreviewReceipt { get; internal set; }
        public string? PreviewReceiptHash { get; internal set; }
        public string DocumentFingerprint { get; internal set; } = "";
        public string DocumentSessionId { get; internal set; } = "";
        public string SourceScopedId { get; internal set; } = "";
        public string ObservationId { get; internal set; } = "";
        public string ObservationBindingHash { get; internal set; } = "";
        public long ElementId { get; internal set; }
        public string OutboundBodySha256 { get; internal set; } = "";
    }

    /// <summary>
    /// Native, independently implemented validator for the first reviewed
    /// parameterized family. It deliberately recognizes one family and one
    /// exact body shape; there is no route or wildcard fallback.
    /// </summary>
    public static class OperatorCertifiedRequestFamilyAdmissionVerifier
    {
        private const long MaximumJavaScriptSafeInteger = 9_007_199_254_740_991L;
        private const double MaximumMoveFeet = 2.0;
        private static readonly Regex Sha256 = new Regex("^sha256:[0-9a-f]{64}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex AdmissionSession = new Regex("^[0-9a-f]{32}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex PreviewReceiptToken = new Regex("^cmpr1_[A-Za-z0-9_-]{43}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly HashSet<string> AdmissionKeys = Set(
            "schema", "family_id", "family_hash", "request_instance_hash", "admission_session_id", "phase",
            "preview_instance_hash", "preview_receipt", "preview_receipt_hash", "document_fingerprint", "document_session_id", "source_scoped_id",
            "observation_id", "observation_binding_hash", "element_id", "outbound_body_sha256");
        private static readonly HashSet<string> BodyKeys = Set(
            "ids", "mode", "vectorX", "vectorY", "vectorZ", "dryRun", "behavior",
            "moveTogether", "options");
        private static readonly HashSet<string> OptionKeys = Set("failOnPinned", "unpinIfAllowed");
        private static readonly JsonDocumentOptions StrictJson = new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = 16
        };

        public static OperatorCertifiedRequestFamilyAdmission Parse(JsonElement value)
        {
            RequireExactKeys(value, AdmissionKeys, "request-family admission");
            RequireString(value, "schema", OperatorCertifiedRequestFamilyAdmission.Schema);
            var familyId = RequireString(value, "family_id");
            if (familyId != OperatorCertifiedRequestFamilyAdmission.MoveOneFamilyId)
                throw Invalid("Native request-family admission names an unreviewed family.");
            var familyHash = RequireHash(value, "family_hash");
            if (familyHash != OperatorCertifiedRequestFamilyAdmission.MoveOneFamilyHash)
                throw Invalid("Native request-family admission validator hash is not the reviewed move-one family.");
            var requestInstanceHash = RequireHash(value, "request_instance_hash");
            var admissionSessionId = RequireString(value, "admission_session_id");
            if (!AdmissionSession.IsMatch(admissionSessionId)) throw Invalid("Native request-family admission session is invalid.");
            var phase = RequireString(value, "phase");
            if (phase != "preview" && phase != "apply") throw Invalid("Native request-family admission phase is invalid.");
            var previewInstanceHash = RequireStringOrNull(value, "preview_instance_hash");
            var previewReceipt = RequireStringOrNull(value, "preview_receipt");
            var previewReceiptHash = RequireStringOrNull(value, "preview_receipt_hash");
            if ((phase == "preview" && (previewInstanceHash != null || previewReceipt != null || previewReceiptHash != null))
                || (phase == "apply" && (previewInstanceHash == null || !Sha256.IsMatch(previewInstanceHash)
                    || previewReceipt == null || !PreviewReceiptToken.IsMatch(previewReceipt)
                    || previewReceiptHash == null || !Sha256.IsMatch(previewReceiptHash)
                    || previewReceiptHash != OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(previewReceipt))))
                throw Invalid("Native request-family admission preview lineage is invalid.");
            var documentFingerprint = RequireHash(value, "document_fingerprint");
            var documentSessionId = RequireCanonicalSessionId(value, "document_session_id");
            var sourceScopedId = RequireBoundedNfc(value, "source_scoped_id", 1024);
            var observationId = RequireBoundedNfc(value, "observation_id", 1024);
            var observationBindingHash = RequireHash(value, "observation_binding_hash");
            var elementId = RequirePositiveSafeInteger(value, "element_id");
            var expectedObservationBinding = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                observationId + "\n" + documentFingerprint + "\n" + documentSessionId + "\n" + sourceScopedId + "\n"
                + elementId.ToString(CultureInfo.InvariantCulture));
            if (observationBindingHash != expectedObservationBinding)
                throw Invalid("Native request-family observation binding does not match the exact document/session/source/target lineage.");
            var outboundBodySha256 = RequireHash(value, "outbound_body_sha256");
            return new OperatorCertifiedRequestFamilyAdmission
            {
                FamilyId = familyId,
                FamilyHash = familyHash,
                RequestInstanceHash = requestInstanceHash,
                AdmissionSessionId = admissionSessionId,
                Phase = phase,
                PreviewInstanceHash = previewInstanceHash,
                PreviewReceipt = previewReceipt,
                PreviewReceiptHash = previewReceiptHash,
                DocumentFingerprint = documentFingerprint,
                DocumentSessionId = documentSessionId,
                SourceScopedId = sourceScopedId,
                ObservationId = observationId,
                ObservationBindingHash = observationBindingHash,
                ElementId = elementId,
                OutboundBodySha256 = outboundBodySha256
            };
        }

        /// <summary>
        /// Revalidates the exact effective handler body and independently
        /// recomputes the request-instance digest. The body digest is over the
        /// exact UTF-8 string that will be dispatched, while the instance digest
        /// uses the family's key-sorted canonical material.
        /// </summary>
        public static void RequireValidEffectiveBody(
            OperatorCertifiedRequestFamilyAdmission admission,
            string effectiveBodyJson)
        {
            if (admission == null) throw Invalid("Native request-family admission is missing.");
            if (!string.Equals(
                admission.OutboundBodySha256,
                OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(effectiveBodyJson ?? ""),
                StringComparison.Ordinal))
                throw Invalid("Native request-family admission does not bind the exact effective body bytes.");

            JsonDocument document;
            try { document = JsonDocument.Parse(effectiveBodyJson ?? "", StrictJson); }
            catch (JsonException) { throw Invalid("Native request-family effective body is malformed."); }
            using (document)
            {
                var body = document.RootElement;
                RequireExactKeys(body, BodyKeys, "move-one effective body");
                RequireString(body, "mode", "vector");
                RequireString(body, "behavior", "allOrNothing");
                RequireBoolean(body, "moveTogether", false);
                var dryRun = RequireBooleanValue(body, "dryRun");
                if (dryRun != (admission.Phase == "preview"))
                    throw Invalid("Native request-family phase does not bind the exact preview/apply effect.");

                var ids = Unique(body, "ids", JsonValueKind.Array);
                if (ids.GetArrayLength() != 1)
                    throw Invalid("Native move-one family requires exactly one target.");
                var target = ids.EnumerateArray().Single();
                if (target.ValueKind != JsonValueKind.Number
                    || !target.TryGetInt64(out var elementId)
                    || elementId <= 0
                    || elementId > MaximumJavaScriptSafeInteger
                    || elementId != admission.ElementId)
                    throw Invalid("Native move-one family target does not match the admitted element.");

                var options = Unique(body, "options", JsonValueKind.Object);
                RequireExactKeys(options, OptionKeys, "move-one options");
                RequireBoolean(options, "failOnPinned", true);
                RequireBoolean(options, "unpinIfAllowed", false);

                var vectorX = RequireFiniteNumber(body, "vectorX");
                var vectorY = RequireFiniteNumber(body, "vectorY");
                var vectorZ = RequireFiniteNumber(body, "vectorZ");
                var magnitude = Math.Sqrt((vectorX * vectorX) + (vectorY * vectorY) + (vectorZ * vectorZ));
                if (!(magnitude > 0.0) || magnitude > MaximumMoveFeet)
                    throw Invalid("Native move-one family vector is outside the reviewed displacement bound.");

                var canonicalBody = CanonicalMoveBody(elementId, vectorX, vectorY, vectorZ, dryRun);
                if (!string.Equals(effectiveBodyJson, canonicalBody, StringComparison.Ordinal))
                    throw Invalid("Native request-family effective body is not the reviewed canonical JSON encoding.");
                var requestMaterial = CanonicalRequestMaterial(admission, canonicalBody, vectorX, vectorY, vectorZ);
                var computedInstanceHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(requestMaterial);
                if (!string.Equals(computedInstanceHash, admission.RequestInstanceHash, StringComparison.Ordinal))
                    throw Invalid("Native request-family instance hash is invalid for the exact request and effect.");
            }
        }

        private static string CanonicalMoveBody(long elementId, double x, double y, double z, bool dryRun)
        {
            return "{\"behavior\":\"allOrNothing\",\"dryRun\":" + (dryRun ? "true" : "false")
                + ",\"ids\":[" + elementId.ToString(CultureInfo.InvariantCulture) + "]"
                + ",\"mode\":\"vector\",\"moveTogether\":false"
                + ",\"options\":{\"failOnPinned\":true,\"unpinIfAllowed\":false}"
                + ",\"vectorX\":" + CanonicalFiniteNumber(x)
                + ",\"vectorY\":" + CanonicalFiniteNumber(y)
                + ",\"vectorZ\":" + CanonicalFiniteNumber(z) + "}";
        }

        private static string CanonicalRequestMaterial(
            OperatorCertifiedRequestFamilyAdmission admission,
            string canonicalBody,
            double x,
            double y,
            double z)
        {
            var request = "{\"documentFingerprint\":" + Quote(admission.DocumentFingerprint)
                + ",\"documentSessionId\":" + Quote(admission.DocumentSessionId)
                + ",\"elementId\":" + admission.ElementId.ToString(CultureInfo.InvariantCulture)
                + ",\"observationBindingHash\":" + Quote(admission.ObservationBindingHash)
                + ",\"observationId\":" + Quote(admission.ObservationId)
                + ",\"phase\":" + Quote(admission.Phase)
                + (admission.PreviewInstanceHash == null ? "" : ",\"previewInstanceHash\":" + Quote(admission.PreviewInstanceHash))
                + (admission.PreviewReceiptHash == null ? "" : ",\"previewReceiptHash\":" + Quote(admission.PreviewReceiptHash))
                + ",\"sourceScopedId\":" + Quote(admission.SourceScopedId)
                + ",\"vectorFeet\":{\"x\":" + CanonicalFiniteNumber(x)
                + ",\"y\":" + CanonicalFiniteNumber(y)
                + ",\"z\":" + CanonicalFiniteNumber(z) + "}}";
            return "{\"admissionSessionId\":" + Quote(admission.AdmissionSessionId)
                + ",\"familyHash\":" + Quote(admission.FamilyHash)
                + ",\"outboundBody\":" + canonicalBody
                + ",\"request\":" + request + "}";
        }

        private static string CanonicalFiniteNumber(double value)
        {
            // System.Text.Json's round-trip representation is ECMAScript-compatible
            // for this bounded finite domain except exponent decoration. Normalize
            // that decoration to JSON.stringify spelling and fail closed later if a
            // producer supplied a value whose digest differs.
            var text = JsonSerializer.Serialize(value);
            var exponent = text.IndexOfAny(new[] { 'E', 'e' });
            if (exponent < 0) return text == "-0" ? "0" : text;
            var mantissa = text.Substring(0, exponent);
            var exponentText = text.Substring(exponent + 1);
            var sign = "";
            if (exponentText.StartsWith("+", StringComparison.Ordinal)) exponentText = exponentText.Substring(1);
            else if (exponentText.StartsWith("-", StringComparison.Ordinal)) { sign = "-"; exponentText = exponentText.Substring(1); }
            exponentText = exponentText.TrimStart('0');
            if (exponentText.Length == 0) exponentText = "0";
            return mantissa + "e" + (sign.Length == 0 ? "+" : sign) + exponentText;
        }

        private static string Quote(string value)
        {
            var builder = new StringBuilder();
            builder.Append('"');
            foreach (var character in value.Normalize(NormalizationForm.FormC))
            {
                switch (character)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\b': builder.Append("\\b"); break;
                    case '\t': builder.Append("\\t"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\f': builder.Append("\\f"); break;
                    case '\r': builder.Append("\\r"); break;
                    default:
                        if (character < 0x20) builder.Append("\\u00").Append(((int)character).ToString("x2", CultureInfo.InvariantCulture));
                        else builder.Append(character);
                        break;
                }
            }
            builder.Append('"');
            return builder.ToString();
        }

        private static void RequireExactKeys(JsonElement value, HashSet<string> expected, string location)
        {
            if (value.ValueKind != JsonValueKind.Object) throw Invalid("Native " + location + " must be an object.");
            var found = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!expected.Contains(property.Name) || !found.Add(property.Name))
                    throw Invalid("Native " + location + " contains an unknown or duplicate field.");
            }
            if (found.Count != expected.Count) throw Invalid("Native " + location + " is missing a required field.");
        }

        private static JsonElement Unique(JsonElement value, string name, params JsonValueKind[] kinds)
        {
            var count = 0;
            var result = default(JsonElement);
            foreach (var property in value.EnumerateObject())
            {
                if (property.Name != name) continue;
                count++;
                result = property.Value;
            }
            if (count != 1 || !kinds.Contains(result.ValueKind)) throw Invalid("Native request-family field " + name + " is invalid.");
            return result;
        }

        private static string RequireString(JsonElement value, string name)
        {
            var text = Unique(value, name, JsonValueKind.String).GetString() ?? "";
            if (text.Length == 0 || text != text.Normalize(NormalizationForm.FormC)) throw Invalid("Native request-family field " + name + " is invalid.");
            return text;
        }

        private static void RequireString(JsonElement value, string name, string expected)
        {
            if (RequireString(value, name) != expected) throw Invalid("Native request-family field " + name + " is unsupported.");
        }

        private static string RequireHash(JsonElement value, string name)
        {
            var text = RequireString(value, name);
            if (!Sha256.IsMatch(text)) throw Invalid("Native request-family digest " + name + " is invalid.");
            return text;
        }

        private static string? RequireStringOrNull(JsonElement value, string name)
        {
            var element = Unique(value, name, JsonValueKind.String, JsonValueKind.Null);
            if (element.ValueKind == JsonValueKind.Null) return null;
            var text = element.GetString() ?? "";
            if (text.Length == 0 || text != text.Normalize(NormalizationForm.FormC)) throw Invalid("Native request-family field " + name + " is invalid.");
            return text;
        }

        private static string RequireBoundedNfc(JsonElement value, string name, int maximumLength)
        {
            var text = RequireString(value, name);
            if (text.Length > maximumLength || text.Any(character => character <= 0x1f || character == 0x7f))
                throw Invalid("Native request-family field " + name + " is outside its bound.");
            return text;
        }

        private static string RequireCanonicalSessionId(JsonElement value, string name)
        {
            var text = RequireString(value, name);
            if (!Guid.TryParseExact(text, "N", out var parsed)
                || !string.Equals(text, parsed.ToString("N"), StringComparison.Ordinal))
                throw Invalid("Native request-family document session identity is invalid.");
            return text;
        }

        private static long RequirePositiveSafeInteger(JsonElement value, string name)
        {
            var element = Unique(value, name, JsonValueKind.Number);
            if (!element.TryGetInt64(out var number) || number <= 0 || number > MaximumJavaScriptSafeInteger)
                throw Invalid("Native request-family field " + name + " must be a positive safe integer.");
            return number;
        }

        private static double RequireFiniteNumber(JsonElement value, string name)
        {
            var element = Unique(value, name, JsonValueKind.Number);
            if (!element.TryGetDouble(out var number) || double.IsNaN(number) || double.IsInfinity(number))
                throw Invalid("Native request-family vector field " + name + " is invalid.");
            return number;
        }

        private static bool RequireBooleanValue(JsonElement value, string name)
        {
            return Unique(value, name, JsonValueKind.True, JsonValueKind.False).GetBoolean();
        }

        private static void RequireBoolean(JsonElement value, string name, bool expected)
        {
            if (RequireBooleanValue(value, name) != expected) throw Invalid("Native request-family boolean " + name + " is invalid.");
        }

        private static HashSet<string> Set(params string[] values) => new HashSet<string>(values, StringComparer.Ordinal);

        private static InvalidDataException Invalid(string message) => new InvalidDataException(message);
    }

    /// <summary>
    /// Process-local identity for an actual Autodesk Document object. A close,
    /// reopen, replacement document, or Revit restart necessarily receives a
    /// new identity even when title/path/project identity are unchanged.
    /// </summary>
    public static class OperatorNativeDocumentSessionAuthority
    {
        private sealed class Session { public string Id { get; } = Guid.NewGuid().ToString("N"); }
        private static readonly ConditionalWeakTable<Document, Session> Sessions = new ConditionalWeakTable<Document, Session>();

        public static string GetSessionId(Document document)
        {
            if (document == null) throw new ArgumentNullException(nameof(document));
            return Sessions.GetValue(document, _ => new Session()).Id;
        }

        public static void RequireCurrent(UIApplication app, OperatorCertifiedRequestFamilyAdmission? admission)
        {
            if (admission == null) return;
            var document = app?.ActiveUIDocument?.Document;
            if (document == null || !document.IsValidObject)
                throw Denied("The admitted request has no current active Revit document.");
            string? projectUniqueId = null;
            try { projectUniqueId = document.ProjectInformation?.UniqueId; } catch { }
            var fingerprint = "sha256:" + OperatorRevitBatchBinding.ComputeProjectFingerprint(document.Title, document.PathName, projectUniqueId);
            if (!string.Equals(fingerprint, admission.DocumentFingerprint, StringComparison.Ordinal)
                || !string.Equals(GetSessionId(document), admission.DocumentSessionId, StringComparison.Ordinal))
                throw Denied("The active Revit document or its process-local session changed after request-family admission.");
            if (!string.Equals(admission.SourceScopedId, "host:" + admission.ElementId.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal))
                throw Denied("The certified move target is not the exact admitted host-document element.");
            var element = document.GetElement(ElementIdCompat.Create(admission.ElementId));
            if (element == null || !element.IsValidObject || !(element.Location is LocationPoint))
                throw Denied("The certified move target is missing or is not point-located.");
            bool pinned;
            try { pinned = element.Pinned; }
            catch { throw Denied("The certified move target pinned state is unavailable."); }
            if (pinned || (element.GroupId != null && element.GroupId != ElementId.InvalidElementId))
                throw Denied("The certified move target is pinned or belongs to a group.");
        }

        private static OperatorNativeHttpAdmissionException Denied(string message)
            => new OperatorNativeHttpAdmissionException(
                "CERTIFICATION_DIRECT_DOCUMENT_BINDING_DENIED",
                message,
                403,
                false,
                "healthy");
    }
}
