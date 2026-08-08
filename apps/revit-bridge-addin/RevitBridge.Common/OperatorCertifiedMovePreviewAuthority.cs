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
            string effectiveBodyJson,
            OperatorCertifiedMoveExecutionStart? executionStart,
            OperatorCertifiedFamilyExecutionContext? executionContext)
        {
            var admission = envelope?.RequestFamilyAdmission;
            if (admission == null) return handlerResult;
            if (executionStart == null || executionStart.RequestInstanceHash != admission.RequestInstanceHash)
                throw Denied("Certified move execution is missing its native pre-dispatch state capability.");
            if (!ReferenceEquals(executionStart.ExecutionContext, executionContext))
                throw Denied("Certified move execution transport context changed after native pre-dispatch capture.");
            if (admission.Phase != "apply")
                return AttachReceiptCore(app, handlerResult, envelope!, effectiveBodyJson, executionStart, RequireExecutionContext(executionContext, envelope!));

            try
            {
                return AttachReceiptCore(app, handlerResult, envelope!, effectiveBodyJson, executionStart, RequireExecutionContext(executionContext, envelope!));
            }
            catch (OperatorCertifiedFamilyOutcomeUnknownException)
            {
                throw;
            }
            catch (Exception error)
            {
                // After an apply handler has returned, every failure to bind,
                // serialize, validate, read back, or attach the native receipt
                // is an unknown mutation outcome. Handler-authored rolledBack
                // metadata is not rollback proof. Never make such an attempt
                // retryable and never restore its consumed preview token.
                throw new OperatorCertifiedFamilyOutcomeUnknownException(
                    "Committed move outcome could not be independently certified after handler dispatch.",
                    error);
            }
        }

        private static object AttachReceiptCore(
            UIApplication app,
            object handlerResult,
            OperatorCourierCertificationEnvelope envelope,
            string effectiveBodyJson,
            OperatorCertifiedMoveExecutionStart executionStart,
            OperatorCertifiedFamilyExecutionContext executionContext)
        {
            var admission = envelope.RequestFamilyAdmission!;
            OperatorNativeDocumentSessionAuthority.RequireCurrent(app, admission);

            var json = JsonSerializer.Serialize(handlerResult);
            using var resultDocument = JsonDocument.Parse(json);
            var result = resultDocument.RootElement;
            var now = DateTimeOffset.UtcNow;
            Dictionary<string, object?>? previewReceipt = null;
            string outcome;
            string nativeResultHash;
            if (admission.Phase == "preview")
            {
                RequirePreviewResult(result, admission.ElementId, executionStart);
                RequireRollbackReadback(app.ActiveUIDocument.Document, admission.ElementId, executionStart);
                nativeResultHash = ComputeCertifiedMoveResultHash(result);
                var tokenBytes = new byte[32];
                using (var random = RandomNumberGenerator.Create()) random.GetBytes(tokenBytes);
                var token = "cmpr1_" + Convert.ToBase64String(tokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
                var tokenHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(token);
                var vector = ReadVector(effectiveBodyJson);
                var entry = new Entry(admission, envelope, now, vector, executionStart);
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
                    RequireApplyResult(result, admission.ElementId, executionStart);
                    RequireApplyReadback(app.ActiveUIDocument.Document, admission.ElementId, executionStart);
                    nativeResultHash = ComputeCertifiedMoveResultHash(result);
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
                ["outcome_unknown"] = false,
                ["result_hash"] = nativeResultHash,
                ["native_attestation_key_id"] = OperatorNativeExecutionAttestationAuthority.KeyId
            };
            executionReceipt["transport_kind"] = executionContext.TransportKind;
            executionReceipt["dispatch_id"] = executionContext.DispatchId;
            executionReceipt["correlation_id"] = executionContext.CorrelationId;
            executionReceipt["execution_session_id"] = executionContext.ExecutionSessionId;
            executionReceipt["executor_id"] = executionContext.ExecutorId;
            executionReceipt["certification_envelope_hash"] = executionContext.CertificationEnvelopeHash;
            executionReceipt["completion_challenge_hash"] = executionContext.CompletionChallengeHash;
            executionReceipt["preview_receipt_schema"] = previewReceipt == null ? null : previewReceipt["schema"];
            executionReceipt["preview_receipt_hash"] = previewReceipt == null ? null : previewReceipt["preview_receipt_hash"];
            executionReceipt["preview_instance_hash"] = previewReceipt == null ? null : previewReceipt["preview_instance_hash"];
            executionReceipt["preview_admission_session_id"] = previewReceipt == null ? null : previewReceipt["admission_session_id"];
            executionReceipt["preview_issued_at_utc"] = previewReceipt == null ? null : previewReceipt["issued_at_utc"];
            executionReceipt["native_attestation_signature"] =
                OperatorNativeExecutionAttestationAuthority.SignCanonicalPayload(executionReceipt);
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

        private static OperatorCertifiedFamilyExecutionContext RequireExecutionContext(
            OperatorCertifiedFamilyExecutionContext? executionContext,
            OperatorCourierCertificationEnvelope envelope)
        {
            if (executionContext == null
                || !string.Equals(executionContext.CertificationEnvelopeHash, envelope.EnvelopeHash, StringComparison.Ordinal))
                throw Denied("Certified move execution is missing its exact native transport context.");
            if (string.Equals(executionContext.TransportKind, "direct", StringComparison.Ordinal))
            {
                if (executionContext.CompletionChallengeHash != null
                    || !string.Equals(executionContext.DispatchId, executionContext.CorrelationId, StringComparison.Ordinal)
                    || !string.Equals(executionContext.ExecutionSessionId, envelope.RequestFamilyAdmission!.AdmissionSessionId, StringComparison.Ordinal)
                    || !string.Equals(executionContext.ExecutorId, OperatorNativeExecutionAttestationAuthority.KeyId, StringComparison.Ordinal))
                    throw Denied("Certified direct execution transport context is invalid.");
            }
            else if (string.Equals(executionContext.TransportKind, "courier", StringComparison.Ordinal))
            {
                if (string.IsNullOrWhiteSpace(executionContext.CompletionChallengeHash))
                    throw Denied("Certified courier execution transport context is not challenge-bound.");
            }
            else
            {
                throw Denied("Certified move execution transport kind is invalid.");
            }
            return executionContext;
        }

        public static OperatorCertifiedMoveExecutionStart? CaptureStartAndConsumeApplyReceipt(
            UIApplication app,
            OperatorCourierCertificationEnvelope? envelope,
            string effectiveBodyJson,
            OperatorCertifiedFamilyExecutionContext? executionContext)
        {
            var admission = envelope?.RequestFamilyAdmission;
            if (admission == null) return null;
            RequireExecutionContext(executionContext, envelope!);
            OperatorNativeDocumentSessionAuthority.RequireCurrent(app, admission);
            var element = app.ActiveUIDocument.Document.GetElement(ElementIdCompat.Create(admission.ElementId));
            if (element == null || !element.IsValidObject || !(element.Location is LocationPoint locationPoint))
                throw Denied("Certified move target is not an exact native LocationPoint immediately before dispatch.");
            var vector = ReadVector(effectiveBodyJson);
            var executionStart = new OperatorCertifiedMoveExecutionStart(
                admission.RequestInstanceHash,
                admission.Phase,
                locationPoint.Point.X,
                locationPoint.Point.Y,
                locationPoint.Point.Z,
                vector.X,
                vector.Y,
                vector.Z,
                executionContext);
            if (admission.Phase != "apply") return executionStart;
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

            if (entry.VectorX != vector.X || entry.VectorY != vector.Y || entry.VectorZ != vector.Z)
                throw Denied("Certified move apply vector differs from its native preview.");
            if (!Near(entry.StartX, executionStart.StartX)
                || !Near(entry.StartY, executionStart.StartY)
                || !Near(entry.StartZ, executionStart.StartZ))
                throw Denied("Certified move target location changed after its native rollback preview.");
            return executionStart;
        }

        private static void RequirePreviewResult(JsonElement result, long expectedId, OperatorCertifiedMoveExecutionStart executionStart)
        {
            RequireExactResultKeys(result);
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
            RequireExactSnapshotDelta(before, after, executionStart, "preview");
        }

        private static void RequireApplyResult(JsonElement result, long expectedId, OperatorCertifiedMoveExecutionStart executionStart)
        {
            RequireExactResultKeys(result);
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
            RequireExactSnapshotDelta(before, after, executionStart, "apply");
        }

        private static void RequireRollbackReadback(Document document, long elementId, OperatorCertifiedMoveExecutionStart executionStart)
        {
            var element = document.GetElement(ElementIdCompat.Create(elementId));
            if (element == null || !element.IsValidObject) throw Denied("Move preview target no longer exists after rollback.");
            if (!(element.Location is LocationPoint point) || !SamePoint(point.Point, executionStart.StartX, executionStart.StartY, executionStart.StartZ))
                throw Denied("Independent native readback did not confirm exact move rollback to the captured start point.");
        }

        private static void RequireApplyReadback(Document document, long elementId, OperatorCertifiedMoveExecutionStart executionStart)
        {
            var element = document.GetElement(ElementIdCompat.Create(elementId));
            if (element == null || !element.IsValidObject) throw Denied("Move apply target no longer exists after commit.");
            if (!(element.Location is LocationPoint point)
                || !SamePoint(point.Point,
                    executionStart.StartX + executionStart.VectorX,
                    executionStart.StartY + executionStart.VectorY,
                    executionStart.StartZ + executionStart.VectorZ))
                throw Denied("Independent native readback did not confirm the exact sealed committed move delta.");
        }

        internal static void RequireExactSnapshotDelta(
            JsonElement before,
            JsonElement after,
            OperatorCertifiedMoveExecutionStart executionStart,
            string phase)
        {
            if (!String(before, "kind", out var beforeKind) || beforeKind != "LocationPoint"
                || !String(after, "kind", out var afterKind) || afterKind != "LocationPoint"
                || !SameXyz(before, "pointXyz", executionStart.StartX, executionStart.StartY, executionStart.StartZ)
                || !SameXyz(after, "pointXyz",
                    executionStart.StartX + executionStart.VectorX,
                    executionStart.StartY + executionStart.VectorY,
                    executionStart.StartZ + executionStart.VectorZ))
                throw Denied("Move " + phase + " snapshots do not prove the exact captured start point and sealed vector.");
        }

        internal static string ComputeCertifiedMoveResultHash(JsonElement result)
        {
            RequireExactResultKeys(result);
            var movedIds = Required(result, "movedIds", JsonValueKind.Array).EnumerateArray()
                .Select(item => item.GetInt64()).ToArray();
            var warnings = Required(result, "warnings", JsonValueKind.Array).EnumerateArray()
                .Select(item => item.ValueKind == JsonValueKind.String
                    ? item.GetString() ?? ""
                    : throw Denied("Certified move warnings must be strings."))
                .ToArray();
            var snapshots = Required(result, "snapshots", JsonValueKind.Array).EnumerateArray()
                .Select(snapshot => new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["id"] = snapshot.GetProperty("id").GetInt64(),
                    ["before"] = SnapshotProjection(snapshot.GetProperty("before")),
                    ["after"] = SnapshotProjection(snapshot.GetProperty("after"))
                }).ToArray();
            var projection = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["status"] = result.GetProperty("status").GetString(),
                ["movedIds"] = movedIds,
                ["skipped"] = Array.Empty<object>(),
                ["warnings"] = warnings,
                ["snapshots"] = snapshots,
                ["movedTogether"] = result.GetProperty("movedTogether").GetBoolean(),
                ["rolledBack"] = result.GetProperty("rolledBack").GetBoolean()
            };
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(projection));
            return OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                OperatorCourierCertificationEnvelopeVerifier.Canonicalize(document.RootElement));
        }

        public static bool IsIndependentlyVerifiedCertifiedFamilyResult(object result)
        {
            try
            {
                using var document = JsonDocument.Parse(JsonSerializer.Serialize(result));
                if (document.RootElement.ValueKind != JsonValueKind.Object
                    || !document.RootElement.TryGetProperty("certified_execution_receipt", out var receipt)
                    || receipt.ValueKind != JsonValueKind.Object
                    || !String(receipt, "schema", out var schema)
                    || schema != "revit-operator.certified-family-execution-receipt.v1"
                    || !String(receipt, "native_attestation_key_id", out var keyId)
                    || keyId != OperatorNativeExecutionAttestationAuthority.KeyId
                    || !String(receipt, "native_attestation_signature", out var signature)
                    || !Boolean(receipt, "outcome_unknown", out var outcomeUnknown)
                    || outcomeUnknown) return false;
                var signedPayload = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var property in receipt.EnumerateObject())
                {
                    if (property.Name == "native_attestation_signature") continue;
                    signedPayload.Add(property.Name, property.Value.Clone());
                }
                if (!OperatorNativeExecutionAttestationAuthority.VerifyCanonicalPayload(signedPayload, signature)
                    || !String(receipt, "result_hash", out var signedResultHash)) return false;
                var nativeResult = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var property in document.RootElement.EnumerateObject())
                {
                    if (property.Name == "certified_execution_receipt" || property.Name == "certified_preview_receipt") continue;
                    nativeResult.Add(property.Name, property.Value.Clone());
                }
                using var nativeResultDocument = JsonDocument.Parse(JsonSerializer.Serialize(nativeResult));
                if (signedResultHash != ComputeCertifiedMoveResultHash(nativeResultDocument.RootElement)
                    || !String(receipt, "phase", out var phase)) return false;
                if (phase == "preview")
                {
                    if (!document.RootElement.TryGetProperty("certified_preview_receipt", out var preview)
                        || preview.ValueKind != JsonValueKind.Object) return false;
                    return SignedPreviewFieldMatches(receipt, "preview_receipt_schema", preview, "schema")
                        && SignedPreviewFieldMatches(receipt, "preview_receipt_hash", preview, "preview_receipt_hash")
                        && SignedPreviewFieldMatches(receipt, "preview_instance_hash", preview, "preview_instance_hash")
                        && SignedPreviewFieldMatches(receipt, "preview_admission_session_id", preview, "admission_session_id")
                        && SignedPreviewFieldMatches(receipt, "preview_issued_at_utc", preview, "issued_at_utc");
                }
                return phase == "apply"
                    && !document.RootElement.TryGetProperty("certified_preview_receipt", out _)
                    && IsNull(receipt, "preview_receipt_schema")
                    && IsNull(receipt, "preview_receipt_hash")
                    && IsNull(receipt, "preview_instance_hash")
                    && IsNull(receipt, "preview_admission_session_id")
                    && IsNull(receipt, "preview_issued_at_utc");
            }
            catch
            {
                return false;
            }
        }

        private static bool SignedPreviewFieldMatches(JsonElement receipt, string receiptName, JsonElement preview, string previewName)
            => String(receipt, receiptName, out var signed)
                && String(preview, previewName, out var claimed)
                && signed == claimed;

        private static bool IsNull(JsonElement value, string name)
            => value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.Null;

        private static Dictionary<string, object?> SnapshotProjection(JsonElement snapshot)
        {
            var point = Required(snapshot, "pointXyz", JsonValueKind.Array);
            if (point.GetArrayLength() != 3) throw Denied("Certified move point snapshot is invalid.");
            return new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["kind"] = snapshot.GetProperty("kind").GetString(),
                ["point_bits"] = point.EnumerateArray().Select(value =>
                    unchecked((ulong)BitConverter.DoubleToInt64Bits(value.GetDouble())).ToString("x16", CultureInfo.InvariantCulture)).ToArray()
            };
        }

        private static void RequireExactResultKeys(JsonElement result)
        {
            if (result.ValueKind != JsonValueKind.Object) throw Denied("Certified move result must be an object.");
            var expected = new HashSet<string>(new[]
            {
                "status", "movedIds", "skipped", "warnings", "snapshots", "movedTogether", "rolledBack"
            }, StringComparer.Ordinal);
            var found = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in result.EnumerateObject())
                if (!expected.Contains(property.Name) || !found.Add(property.Name))
                    throw Denied("Certified move result contains unknown or duplicate fields.");
            if (found.Count != expected.Count) throw Denied("Certified move result is missing a required field.");
        }

        private static bool SameXyz(JsonElement value, string name, double x, double y, double z)
        {
            if (!value.TryGetProperty(name, out var array) || array.ValueKind != JsonValueKind.Array || array.GetArrayLength() != 3) return false;
            return Near(array[0], x) && Near(array[1], y) && Near(array[2], z);
        }

        private static bool SamePoint(XYZ point, double x, double y, double z)
            => Near(point.X, x) && Near(point.Y, y) && Near(point.Z, z);

        private static bool Near(JsonElement value, double expected)
            => value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var actual) && Math.Abs(actual - expected) <= 1e-9;

        private static bool Near(double actual, double expected) => Math.Abs(actual - expected) <= 1e-9;

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
            public Entry(OperatorCertifiedRequestFamilyAdmission admission, OperatorCourierCertificationEnvelope envelope, DateTimeOffset issuedAtUtc, (double X, double Y, double Z) vector, OperatorCertifiedMoveExecutionStart executionStart)
            {
                PreviewInstanceHash = admission.RequestInstanceHash; AdmissionSessionId = admission.AdmissionSessionId;
                FamilyId = admission.FamilyId; FamilyHash = admission.FamilyHash; DocumentFingerprint = admission.DocumentFingerprint;
                DocumentSessionId = admission.DocumentSessionId; SourceScopedId = admission.SourceScopedId; ElementId = admission.ElementId;
                ObservationId = admission.ObservationId; ObservationBindingHash = admission.ObservationBindingHash;
                PolicyHash = envelope.PolicyHash; PolicyRecordHash = envelope.PolicyRecordHash; EvidenceRecordHash = envelope.EvidenceRecordHash;
                EffectHash = envelope.EffectHash; Channel = envelope.Channel; Alias = envelope.Alias; IssuedAtUtc = issuedAtUtc;
                VectorX = vector.X; VectorY = vector.Y; VectorZ = vector.Z;
                StartX = executionStart.StartX; StartY = executionStart.StartY; StartZ = executionStart.StartZ;
            }
            public string PreviewInstanceHash { get; } public string AdmissionSessionId { get; }
            public string FamilyId { get; } public string FamilyHash { get; } public string DocumentFingerprint { get; }
            public string DocumentSessionId { get; } public string SourceScopedId { get; } public long ElementId { get; }
            public string ObservationId { get; } public string ObservationBindingHash { get; }
            public string PolicyHash { get; } public string PolicyRecordHash { get; } public string EvidenceRecordHash { get; }
            public string EffectHash { get; } public string Channel { get; } public string Alias { get; }
            public DateTimeOffset IssuedAtUtc { get; } public double VectorX { get; } public double VectorY { get; } public double VectorZ { get; }
            public double StartX { get; } public double StartY { get; } public double StartZ { get; }
        }
    }

    public sealed class OperatorCertifiedMoveExecutionStart
    {
        internal OperatorCertifiedMoveExecutionStart(
            string requestInstanceHash,
            string phase,
            double startX,
            double startY,
            double startZ,
            double vectorX,
            double vectorY,
            double vectorZ,
            OperatorCertifiedFamilyExecutionContext? executionContext = null)
        {
            RequestInstanceHash = requestInstanceHash;
            Phase = phase;
            StartX = startX; StartY = startY; StartZ = startZ;
            VectorX = vectorX; VectorY = vectorY; VectorZ = vectorZ;
            ExecutionContext = executionContext;
        }

        public string RequestInstanceHash { get; }
        public string Phase { get; }
        public double StartX { get; }
        public double StartY { get; }
        public double StartZ { get; }
        public double VectorX { get; }
        public double VectorY { get; }
        public double VectorZ { get; }
        internal OperatorCertifiedFamilyExecutionContext? ExecutionContext { get; }
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
