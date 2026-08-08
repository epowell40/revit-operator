using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Common
{
    /// <summary>
    /// Process-local, one-use preview authority. Only native Revit rollback
    /// readback can mint a token, and apply consumes the token before mutation.
    /// No backend or MCP-shaped value can populate this ledger.
    /// </summary>
    public static class OperatorCertifiedMovePreviewAuthority
    {
        public const string ReceiptSchema = "revit-operator.certified-move-preview-receipt.v1";
        private const int MaximumEntries = 4096;
        private static readonly TimeSpan MaximumAge = TimeSpan.FromMinutes(15);
        private static readonly object Gate = new object();
        private static readonly Dictionary<string, Entry> Issued = new Dictionary<string, Entry>(StringComparer.Ordinal);

        public static object AttachReceiptAfterVerifiedRollback(
            UIApplication app,
            object handlerResult,
            OperatorCourierCertificationEnvelope? envelope,
            string effectiveBodyJson)
        {
            var admission = envelope?.RequestFamilyAdmission;
            if (admission == null) return handlerResult;
            if (admission.Phase != "apply")
                return AttachReceiptCore(app, handlerResult, envelope!, effectiveBodyJson);

            try
            {
                return AttachReceiptCore(app, handlerResult, envelope!, effectiveBodyJson);
            }
            catch (OperatorCertifiedFamilyOutcomeUnknownException)
            {
                throw;
            }
            catch (Exception error)
            {
                // After an apply handler has returned, every failure to bind,
                // serialize, validate, read back, or attach the native receipt
                // is an unknown mutation outcome unless the handler explicitly
                // and parseably reported rollback. Never make such an attempt
                // retryable and never restore its consumed preview token.
                if (ReportsRolledBack(handlerResult) && error is OperatorNativeHttpAdmissionException)
                    throw;
                throw new OperatorCertifiedFamilyOutcomeUnknownException(
                    "Committed move outcome could not be independently certified after handler dispatch.",
                    error);
            }
        }

        private static object AttachReceiptCore(
            UIApplication app,
            object handlerResult,
            OperatorCourierCertificationEnvelope envelope,
            string effectiveBodyJson)
        {
            var admission = envelope.RequestFamilyAdmission!;
            OperatorNativeDocumentSessionAuthority.RequireCurrent(app, admission);

            var json = JsonSerializer.Serialize(handlerResult);
            using var resultDocument = JsonDocument.Parse(json);
            var result = resultDocument.RootElement;
            var now = DateTimeOffset.UtcNow;
            Dictionary<string, object?>? previewReceipt = null;
            string outcome;
            if (admission.Phase == "preview")
            {
                RequirePreviewResult(result, admission.ElementId);
                RequireRollbackReadback(app.ActiveUIDocument.Document, result, admission.ElementId);
                var tokenBytes = new byte[32];
                using (var random = RandomNumberGenerator.Create()) random.GetBytes(tokenBytes);
                var token = "cmpr1_" + Convert.ToBase64String(tokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
                var tokenHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(token);
                var vector = ReadVector(effectiveBodyJson);
                var entry = new Entry(admission, envelope, now, vector);
                lock (Gate)
                {
                    Prune(now);
                    if (Issued.Count >= MaximumEntries)
                        throw Denied("Native preview receipt ledger is full; no reusable token was issued.");
                    Issued.Add(tokenHash, entry);
                }
                previewReceipt = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["schema"] = ReceiptSchema,
                    ["preview_receipt"] = token,
                    ["preview_receipt_hash"] = tokenHash,
                    ["preview_instance_hash"] = admission.RequestInstanceHash,
                    ["admission_session_id"] = admission.AdmissionSessionId,
                    ["issued_at_utc"] = now.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)
                };
                outcome = "rolled_back";
            }
            else
            {
                if (Boolean(result, "rolledBack", out var rolledBack) && rolledBack)
                    throw Denied("Move apply rolled back and did not produce a committed native receipt.");
                try
                {
                    RequireApplyResult(result, admission.ElementId);
                    RequireApplyReadback(app.ActiveUIDocument.Document, result, admission.ElementId);
                }
                catch (Exception error)
                {
                    throw new OperatorCertifiedFamilyOutcomeUnknownException(
                        "Committed move outcome could not be independently certified after handler dispatch.",
                        error);
                }
                outcome = "committed";
            }

            var executionReceipt = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schema"] = "revit-operator.certified-family-execution-receipt.v1",
                ["phase"] = admission.Phase,
                ["request_instance_hash"] = admission.RequestInstanceHash,
                ["family_id"] = admission.FamilyId,
                ["family_hash"] = admission.FamilyHash,
                ["document_fingerprint"] = admission.DocumentFingerprint,
                ["document_session_id"] = admission.DocumentSessionId,
                ["source_scoped_id"] = admission.SourceScopedId,
                ["element_id"] = admission.ElementId,
                ["observation_id"] = admission.ObservationId,
                ["observation_binding_hash"] = admission.ObservationBindingHash,
                ["admission_session_id"] = admission.AdmissionSessionId,
                ["policy_hash"] = envelope.PolicyHash,
                ["policy_record_hash"] = envelope.PolicyRecordHash,
                ["evidence_record_hash"] = envelope.EvidenceRecordHash,
                ["effect_hash"] = envelope.EffectHash,
                ["channel"] = envelope.Channel,
                ["alias"] = envelope.Alias,
                ["outcome"] = outcome,
                ["affected_element_ids"] = new[] { admission.ElementId },
                ["outcome_unknown"] = false
            };
            var output = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var property in result.EnumerateObject())
            {
                if (property.Name == "certified_preview_receipt" || property.Name == "certified_execution_receipt")
                    throw Denied("Move preview result attempted to supply native certification metadata.");
                output.Add(property.Name, property.Value.Clone());
            }
            if (previewReceipt != null) output.Add("certified_preview_receipt", previewReceipt);
            output.Add("certified_execution_receipt", executionReceipt);
            return output;
        }

        private static bool ReportsRolledBack(object handlerResult)
        {
            try
            {
                using var document = JsonDocument.Parse(JsonSerializer.Serialize(handlerResult));
                return Boolean(document.RootElement, "rolledBack", out var rolledBack) && rolledBack;
            }
            catch
            {
                return false;
            }
        }

        public static void RequireApplyReceiptAndConsume(
            OperatorCourierCertificationEnvelope? envelope,
            string effectiveBodyJson)
        {
            var admission = envelope?.RequestFamilyAdmission;
            if (admission == null || admission.Phase != "apply") return;
            if (admission.PreviewReceipt == null || admission.PreviewReceiptHash == null || admission.PreviewInstanceHash == null)
                throw Denied("Certified move apply is missing its native preview receipt.");
            if (admission.PreviewReceiptHash != OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(admission.PreviewReceipt))
                throw Denied("Certified move apply preview receipt hash is invalid.");

            Entry? entry;
            lock (Gate)
            {
                Prune(DateTimeOffset.UtcNow);
                if (!Issued.TryGetValue(admission.PreviewReceiptHash, out entry))
                    throw Denied("Certified move apply preview receipt is unknown, expired, or already consumed.");
                // Consume before every remaining comparison and before handler
                // dispatch. An unknown post-dispatch outcome can never restore it.
                Issued.Remove(admission.PreviewReceiptHash);
            }
            if (entry == null
                || entry.PreviewInstanceHash != admission.PreviewInstanceHash
                || entry.AdmissionSessionId != admission.AdmissionSessionId
                || entry.FamilyId != admission.FamilyId
                || entry.FamilyHash != admission.FamilyHash
                || entry.DocumentFingerprint != admission.DocumentFingerprint
                || entry.DocumentSessionId != admission.DocumentSessionId
                || entry.SourceScopedId != admission.SourceScopedId
                || entry.ElementId != admission.ElementId
                || entry.ObservationId != admission.ObservationId
                || entry.ObservationBindingHash != admission.ObservationBindingHash
                || entry.PolicyHash != envelope!.PolicyHash
                || entry.Channel != envelope.Channel
                || entry.Alias != envelope.Alias)
                throw Denied("Certified move apply does not match the one-use native preview lineage.");

            var applyVector = ReadVector(effectiveBodyJson);
            if (entry.VectorX != applyVector.X || entry.VectorY != applyVector.Y || entry.VectorZ != applyVector.Z)
                throw Denied("Certified move apply vector differs from its native preview.");
        }

        private static void RequirePreviewResult(JsonElement result, long expectedId)
        {
            if (result.ValueKind != JsonValueKind.Object
                || !String(result, "status", out var status) || status != "Dry Run"
                || !Boolean(result, "rolledBack", out var rolledBack) || !rolledBack
                || !Boolean(result, "movedTogether", out var movedTogether) || movedTogether)
                throw Denied("Move preview did not report the reviewed rollback outcome.");
            var movedIds = Required(result, "movedIds", JsonValueKind.Array);
            if (movedIds.GetArrayLength() != 1 || !movedIds[0].TryGetInt64(out var movedId) || movedId != expectedId)
                throw Denied("Move preview result does not contain the exact admitted target.");
            if (Required(result, "skipped", JsonValueKind.Array).GetArrayLength() != 0)
                throw Denied("Move preview skipped a target and cannot issue certification.");
            var snapshots = Required(result, "snapshots", JsonValueKind.Array);
            if (snapshots.GetArrayLength() != 1)
                throw Denied("Move preview result must contain exactly one rollback snapshot.");
            var snapshot = snapshots[0];
            if (snapshot.ValueKind != JsonValueKind.Object
                || !snapshot.TryGetProperty("id", out var id) || !id.TryGetInt64(out var snapshotId) || snapshotId != expectedId
                || !snapshot.TryGetProperty("before", out var before) || before.ValueKind != JsonValueKind.Object
                || !snapshot.TryGetProperty("after", out var after) || after.ValueKind != JsonValueKind.Object)
                throw Denied("Move preview rollback snapshot is incomplete or targets another element.");
        }

        private static void RequireApplyResult(JsonElement result, long expectedId)
        {
            if (result.ValueKind != JsonValueKind.Object
                || !String(result, "status", out var status) || status != "Moved"
                || !Boolean(result, "rolledBack", out var rolledBack) || rolledBack
                || !Boolean(result, "movedTogether", out var movedTogether) || movedTogether)
                throw Denied("Move apply did not report the reviewed committed outcome.");
            var movedIds = Required(result, "movedIds", JsonValueKind.Array);
            if (movedIds.GetArrayLength() != 1 || !movedIds[0].TryGetInt64(out var movedId) || movedId != expectedId)
                throw Denied("Move apply result does not contain the exact admitted target.");
            if (Required(result, "skipped", JsonValueKind.Array).GetArrayLength() != 0)
                throw Denied("Move apply skipped a target and cannot issue a committed receipt.");
            var snapshots = Required(result, "snapshots", JsonValueKind.Array);
            if (snapshots.GetArrayLength() != 1)
                throw Denied("Move apply result must contain exactly one committed snapshot.");
            var snapshot = snapshots[0];
            if (snapshot.ValueKind != JsonValueKind.Object
                || !snapshot.TryGetProperty("id", out var id) || !id.TryGetInt64(out var snapshotId) || snapshotId != expectedId
                || !snapshot.TryGetProperty("before", out var before) || before.ValueKind != JsonValueKind.Object
                || !snapshot.TryGetProperty("after", out var after) || after.ValueKind != JsonValueKind.Object)
                throw Denied("Move apply snapshot is incomplete or targets another element.");
        }

        private static void RequireRollbackReadback(Document document, JsonElement result, long elementId)
        {
            var element = document.GetElement(ElementIdCompat.Create(elementId));
            if (element == null || !element.IsValidObject) throw Denied("Move preview target no longer exists after rollback.");
            var before = result.GetProperty("snapshots")[0].GetProperty("before");
            if (!SameLocation(before, element)) throw Denied("Independent native readback did not confirm exact move rollback.");
        }

        private static void RequireApplyReadback(Document document, JsonElement result, long elementId)
        {
            var element = document.GetElement(ElementIdCompat.Create(elementId));
            if (element == null || !element.IsValidObject) throw Denied("Move apply target no longer exists after commit.");
            var after = result.GetProperty("snapshots")[0].GetProperty("after");
            if (!SameLocation(after, element)) throw Denied("Independent native readback did not confirm the exact committed move location.");
        }

        private static bool SameLocation(JsonElement snapshot, Element element)
        {
            if (!String(snapshot, "kind", out var kind)) return false;
            if (kind == "LocationPoint" && element.Location is LocationPoint point)
                return SameXyz(snapshot, "pointXyz", point.Point);
            if (kind == "LocationCurve" && element.Location is LocationCurve curve)
                return SameXyz(snapshot, "startXyz", curve.Curve.GetEndPoint(0))
                    && SameXyz(snapshot, "endXyz", curve.Curve.GetEndPoint(1));
            if (kind == "BboxCenter")
            {
                var box = element.get_BoundingBox(null);
                return box != null && SameXyz(snapshot, "centerXyz", (box.Min + box.Max) * 0.5);
            }
            return false;
        }

        private static bool SameXyz(JsonElement value, string name, XYZ xyz)
        {
            if (!value.TryGetProperty(name, out var array) || array.ValueKind != JsonValueKind.Array || array.GetArrayLength() != 3) return false;
            return Near(array[0], xyz.X) && Near(array[1], xyz.Y) && Near(array[2], xyz.Z);
        }

        private static bool Near(JsonElement value, double expected)
            => value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var actual) && Math.Abs(actual - expected) <= 1e-9;

        private static (double X, double Y, double Z) ReadVector(string bodyJson)
        {
            if (string.IsNullOrEmpty(bodyJson)) return (0, 0, 0);
            using var document = JsonDocument.Parse(bodyJson);
            var body = document.RootElement;
            return (body.GetProperty("vectorX").GetDouble(), body.GetProperty("vectorY").GetDouble(), body.GetProperty("vectorZ").GetDouble());
        }

        private static JsonElement Required(JsonElement value, string name, JsonValueKind kind)
        {
            if (!value.TryGetProperty(name, out var result) || result.ValueKind != kind) throw Denied("Move preview result field " + name + " is invalid.");
            return result;
        }

        private static bool String(JsonElement value, string name, out string result)
        {
            result = "";
            if (!value.TryGetProperty(name, out var item) || item.ValueKind != JsonValueKind.String) return false;
            result = item.GetString() ?? "";
            return true;
        }

        private static bool Boolean(JsonElement value, string name, out bool result)
        {
            result = false;
            if (!value.TryGetProperty(name, out var item) || (item.ValueKind != JsonValueKind.True && item.ValueKind != JsonValueKind.False)) return false;
            result = item.GetBoolean();
            return true;
        }

        private static void Prune(DateTimeOffset now)
        {
            foreach (var key in Issued.Where(pair => now - pair.Value.IssuedAtUtc > MaximumAge).Select(pair => pair.Key).ToList()) Issued.Remove(key);
        }

        private static OperatorNativeHttpAdmissionException Denied(string message)
            => new OperatorNativeHttpAdmissionException("CERTIFICATION_NATIVE_PREVIEW_DENIED", message, 403, false, "healthy");

        private sealed class Entry
        {
            public Entry(OperatorCertifiedRequestFamilyAdmission admission, OperatorCourierCertificationEnvelope envelope, DateTimeOffset issuedAtUtc, (double X, double Y, double Z) vector)
            {
                PreviewInstanceHash = admission.RequestInstanceHash; AdmissionSessionId = admission.AdmissionSessionId;
                FamilyId = admission.FamilyId; FamilyHash = admission.FamilyHash; DocumentFingerprint = admission.DocumentFingerprint;
                DocumentSessionId = admission.DocumentSessionId; SourceScopedId = admission.SourceScopedId; ElementId = admission.ElementId;
                ObservationId = admission.ObservationId; ObservationBindingHash = admission.ObservationBindingHash;
                PolicyHash = envelope.PolicyHash; PolicyRecordHash = envelope.PolicyRecordHash; EvidenceRecordHash = envelope.EvidenceRecordHash;
                EffectHash = envelope.EffectHash; Channel = envelope.Channel; Alias = envelope.Alias; IssuedAtUtc = issuedAtUtc;
                VectorX = vector.X; VectorY = vector.Y; VectorZ = vector.Z;
            }
            public string PreviewInstanceHash { get; } public string AdmissionSessionId { get; }
            public string FamilyId { get; } public string FamilyHash { get; } public string DocumentFingerprint { get; }
            public string DocumentSessionId { get; } public string SourceScopedId { get; } public long ElementId { get; }
            public string ObservationId { get; } public string ObservationBindingHash { get; }
            public string PolicyHash { get; } public string PolicyRecordHash { get; } public string EvidenceRecordHash { get; }
            public string EffectHash { get; } public string Channel { get; } public string Alias { get; }
            public DateTimeOffset IssuedAtUtc { get; } public double VectorX { get; } public double VectorY { get; } public double VectorZ { get; }
        }
    }

    public sealed class OperatorCertifiedFamilyOutcomeUnknownException : InvalidOperationException, IOperatorRevitFailureMetadata
    {
        public OperatorCertifiedFamilyOutcomeUnknownException(string message, Exception inner) : base(message, inner) { }
        public string Code => "CERTIFICATION_NATIVE_OUTCOME_UNKNOWN";
        public bool Retryable => false;
        public string Phase => "certification_native_post_dispatch";
        public string HostHealth => "degraded";
        public bool OpensCircuit => true;
        public bool OutcomeUnknown => true;
    }
}
