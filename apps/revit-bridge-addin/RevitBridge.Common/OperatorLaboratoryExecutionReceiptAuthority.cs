using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Common
{
    /// <summary>
    /// Native-only evidence for the explicitly selected protected laboratory lane.
    /// This is execution evidence, not a production certification decision.
    /// </summary>
    public static class OperatorLaboratoryExecutionReceiptAuthority
    {
        public const string Schema = "revit-operator.laboratory-execution-receipt.v2";
        public const string ResultField = "laboratory_execution_receipt";
        private static readonly string CourierProcessEpoch = RandomBase64Url(32);
        private static readonly string[] RuntimeDependencyNames = new[]
        {
            "Microsoft.Bcl.AsyncInterfaces.dll", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll",
            "Microsoft.Web.WebView2.Wpf.dll", "RevitBridge.Common.dll", "RevitBridge.dll", "RevitBridge.Logic.dll",
            "System.Buffers.dll", "System.Memory.dll", "System.Numerics.Vectors.dll", "System.Runtime.CompilerServices.Unsafe.dll",
            "System.Security.Cryptography.ProtectedData.dll", "System.Text.Encodings.Web.dll", "System.Text.Json.dll",
            "System.Threading.Tasks.Extensions.dll", "System.ValueTuple.dll", "WebView2Loader.dll"
        };
        private sealed class ApprovedHostRuntimeDependency
        {
            public ApprovedHostRuntimeDependency(string path, string sha256, string assemblyFullName)
            {
                Path = path;
                Sha256 = sha256;
                AssemblyFullName = assemblyFullName;
            }

            public string Path { get; }
            public string Sha256 { get; }
            public string AssemblyFullName { get; }
        }

        // Revit 2024 loads these platform assemblies before Operator. Each
        // exception is an exact reviewed path + strong identity + file digest;
        // same-name assemblies from any other location remain denied.
        private static readonly IReadOnlyDictionary<string, ApprovedHostRuntimeDependency> ApprovedHostRuntimeDependencies =
            new Dictionary<string, ApprovedHostRuntimeDependency>(StringComparer.Ordinal)
            {
                ["Microsoft.Web.WebView2.Core.dll"] = new ApprovedHostRuntimeDependency(
                    @"C:\Program Files\Autodesk\Revit 2024\Microsoft.Web.WebView2.Core.dll",
                    "sha256:f351435147bd9c6f70d9704ca1de3f170234fa9ccc536f1ac736c1c9bd20dcc3",
                    "Microsoft.Web.WebView2.Core, Version=1.0.1343.22, Culture=neutral, PublicKeyToken=2a8ab48044d2601e"),
                ["Microsoft.Web.WebView2.WinForms.dll"] = new ApprovedHostRuntimeDependency(
                    @"C:\Program Files\Autodesk\Revit 2024\Microsoft.Web.WebView2.WinForms.dll",
                    "sha256:41e75eae9d79b33254fcff4f147f1bc905363b6faf9e94e22a9fcdfbbf398532",
                    "Microsoft.Web.WebView2.WinForms, Version=1.0.1343.22, Culture=neutral, PublicKeyToken=2a8ab48044d2601e"),
                ["Microsoft.Web.WebView2.Wpf.dll"] = new ApprovedHostRuntimeDependency(
                    @"C:\Program Files\Autodesk\Revit 2024\Microsoft.Web.WebView2.Wpf.dll",
                    "sha256:e0f391bb35f8b954fb8e816a177bdd491c15bb0c1480fa0a6fad0b3224144681",
                    "Microsoft.Web.WebView2.Wpf, Version=1.0.1343.22, Culture=neutral, PublicKeyToken=2a8ab48044d2601e"),
                ["System.Buffers.dll"] = new ApprovedHostRuntimeDependency(
                    @"C:\Program Files\Autodesk\Revit 2024\System.Buffers.dll",
                    "sha256:c65fff603b283dc966d1a8b730c11d5e5e750e8021bd24640612f6cc3f2c6fb7",
                    "System.Buffers, Version=4.0.3.0, Culture=neutral, PublicKeyToken=cc7b13ffcd2ddd51"),
                ["System.Memory.dll"] = new ApprovedHostRuntimeDependency(
                    @"C:\Program Files\Autodesk\Revit 2024\System.Memory.dll",
                    "sha256:8e76318e8b06692abf7dab1169d27d15557f7f0a34d36af6463eff0fe21213c7",
                    "System.Memory, Version=4.0.1.1, Culture=neutral, PublicKeyToken=cc7b13ffcd2ddd51"),
                ["System.Numerics.Vectors.dll"] = new ApprovedHostRuntimeDependency(
                    @"C:\Program Files\Autodesk\Revit 2024\System.Numerics.Vectors.dll",
                    "sha256:1d3ef8698281e7cf7371d1554afef5872b39f96c26da772210a33da041ba1183",
                    "System.Numerics.Vectors, Version=4.1.4.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a"),
                ["System.Runtime.CompilerServices.Unsafe.dll"] = new ApprovedHostRuntimeDependency(
                    @"C:\Program Files\Autodesk\Revit 2024\System.Runtime.CompilerServices.Unsafe.dll",
                    "sha256:66409f670315afe8610f17a4d3a1ee52d72b6a46c544cec97544e8385f90ad74",
                    "System.Runtime.CompilerServices.Unsafe, Version=4.0.4.1, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a")
            };

        public static OperatorLaboratoryCourierReceiptContext BeginCourierExecution(
            OperatorLaboratoryEvidenceDispatch laboratoryEvidence,
            OperatorLaboratoryMoveEvidenceAdmission? moveAdmission,
            string method,
            string path,
            string bodyJson)
        {
            if (laboratoryEvidence == null || laboratoryEvidence.TransportKind != "courier"
                || laboratoryEvidence.JobId == null || laboratoryEvidence.CorrelationId == null
                || laboratoryEvidence.JobId != laboratoryEvidence.CorrelationId)
                throw Denied("Courier laboratory execution requires exact authenticated job/correlation identity.");
            RequireExactLaboratoryLane();
            OperatorNativeToolExposureEmbeddedAuthority.Instance.RequireLaboratoryEvidenceAuthorized(
                laboratoryEvidence, method, path, laboratoryEvidence.Channel, laboratoryEvidence.Alias, moveAdmission);
            var bodyPresent = string.Equals(method, "POST", StringComparison.Ordinal);
            var bytes = new UTF8Encoding(false, true).GetBytes(bodyJson ?? "");
            var request = OperatorNativeHttpRequestFence.Prepare(
                method, path, false, bodyPresent, bytes, laboratoryEvidence.CorrelationId,
                laboratoryEvidence.Channel, laboratoryEvidence.Alias);
            RequireNoCallerAuthoredReceipt(request.BodyPresent, request.BodyJson);
            var isMove = request.Method == "POST" && request.Path == "/revit/move-elements";
            if (isMove != (moveAdmission != null))
                throw Denied(isMove
                    ? "Courier laboratory move requires its exact reviewed family admission."
                    : "Courier move evidence admission is forbidden for every other route.");
            if (moveAdmission != null)
            {
                if (moveAdmission.EvidenceRunId != laboratoryEvidence.EvidenceRunId
                    || moveAdmission.CandidateSourceHash != laboratoryEvidence.CandidateSourceHash
                    || moveAdmission.Channel != laboratoryEvidence.Channel || moveAdmission.Alias != laboratoryEvidence.Alias)
                    throw Denied("Courier laboratory move admission changed its dispatch identity.");
                _ = moveAdmission.RequireValidEffectiveBody(request.BodyJson);
            }
            var nativeContext = new OperatorNativeTransportRequestContext(
                request,
                RandomBase64Url(32),
                CourierProcessEpoch,
                "",
                DateTimeOffset.UtcNow,
                laboratoryEvidence,
                moveAdmission);
            return new OperatorLaboratoryCourierReceiptContext(nativeContext);
        }

        public static object AttachAfterRevitThreadCompletion(
            UIApplication app,
            object result,
            OperatorLaboratoryCourierReceiptContext courierContext,
            DateTimeOffset issuedAtUtc,
            OperatorCertifiedMoveExecutionStart? laboratoryMoveExecutionStart = null)
        {
            if (courierContext == null) throw new ArgumentNullException(nameof(courierContext));
            return AttachAfterRevitThreadCompletion(
                app, result, courierContext.NativeTransportContext, issuedAtUtc, laboratoryMoveExecutionStart);
        }

        public static object AttachAfterRevitThreadCompletion(
            UIApplication app,
            object result,
            OperatorNativeTransportRequestContext transport,
            DateTimeOffset issuedAtUtc,
            OperatorCertifiedMoveExecutionStart? laboratoryMoveExecutionStart = null)
        {
            if (app == null) throw new ArgumentNullException(nameof(app));
            if (transport == null) throw new ArgumentNullException(nameof(transport));
            var request = transport.Request;
            if (request == null) throw new ArgumentNullException(nameof(request));
            RequireNoCallerAuthoredReceipt(request.BodyPresent, request.BodyJson);
            if (request.CertificationEnvelope != null)
                throw Denied("Protected laboratory evidence cannot carry a certification envelope or request-family admission.");
            if (transport.LaboratoryEvidence == null)
                throw Denied("Protected laboratory evidence is missing authenticated evidence dispatch metadata.");

            using var resultDocument = JsonDocument.Parse(JsonSerializer.Serialize(result));
            if (resultDocument.RootElement.ValueKind != JsonValueKind.Object)
                throw Denied("Protected laboratory evidence requires an object-shaped native handler result.");
            if (resultDocument.RootElement.TryGetProperty(ResultField, out _))
                throw Denied("Native handler result attempted to author the reserved laboratory receipt field.");

            var document = app.ActiveUIDocument?.Document;
            if (document == null || !document.IsValidObject)
                throw Denied("Protected laboratory evidence requires a current active Revit document.");

            var phase = DerivePhase(request.Method, request.Path, request.BodyPresent, request.BodyJson);
            var outcome = RequireSuccessfulOutcome(phase, resultDocument.RootElement);
            var canonicalResult = OperatorCourierCertificationEnvelopeVerifier.Canonicalize(resultDocument.RootElement);
            var resultHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(canonicalResult);
            var canonicalBody = CanonicalBody(request.BodyPresent, request.BodyJson);
            var effectId = DeriveEffectId(request.Method, request.Path, phase);
            var effectPayload = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["effect_id"] = effectId,
                ["method"] = request.Method,
                ["path"] = request.Path,
                ["phase"] = phase
            };
            using var effectDocument = JsonDocument.Parse(JsonSerializer.Serialize(effectPayload));
            var effectHash = DeriveEffectHash(request.Path, phase, effectDocument.RootElement);
            Dictionary<string, object?>? moveProjection = null;
            if (transport.LaboratoryMoveEvidenceAdmission != null)
            {
                if (laboratoryMoveExecutionStart == null)
                    throw Denied("Laboratory move evidence is missing its native pre-dispatch state.");
                moveProjection = OperatorLaboratoryMoveEvidenceAuthority.BuildProjectionAfterResult(
                    app, result, transport.LaboratoryMoveEvidenceAdmission, transport.LaboratoryEvidence,
                    laboratoryMoveExecutionStart, request.BodyJson);
                if (transport.LaboratoryMoveEvidenceAdmission.Phase != phase
                    || transport.LaboratoryMoveEvidenceAdmission.EffectId != effectId
                    || transport.LaboratoryMoveEvidenceAdmission.EffectHash != effectHash)
                    throw Denied("Laboratory move admission does not match the natively derived phase and effect.");
            }
            else if (string.Equals(request.Path, "/revit/move-elements", StringComparison.Ordinal))
            {
                throw Denied("Laboratory move evidence requires its exact reviewed family admission.");
            }

            string? projectUniqueId = null;
            try { projectUniqueId = document.ProjectInformation?.UniqueId; } catch { }
            var documentFingerprint = "sha256:" + OperatorRevitBatchBinding.ComputeProjectFingerprint(
                document.Title,
                document.PathName,
                projectUniqueId);
            using var hostProcess = Process.GetCurrentProcess();
            var processImagePath = hostProcess.MainModule?.FileName;
            if (string.IsNullOrWhiteSpace(processImagePath) || !File.Exists(processImagePath))
                throw Denied("Protected laboratory evidence cannot identify the exact Revit host process image.");

            var runtimeDependencies = RuntimeDependencies();
            using var runtimeDependenciesDocument = JsonDocument.Parse(JsonSerializer.Serialize(runtimeDependencies));
            var runtimeDependenciesHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                OperatorCourierCertificationEnvelopeVerifier.Canonicalize(runtimeDependenciesDocument.RootElement));
            var receipt = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schema"] = Schema,
                ["request_id"] = request.RequestId,
                ["dispatch_id"] = request.RequestId,
                ["transport_request_nonce"] = transport.RequestNonce,
                ["transport_server_epoch"] = transport.ServerEpoch,
                ["transport_issued_at_utc"] = transport.IssuedAtUtc.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                ["laboratory_evidence"] = transport.LaboratoryEvidence.CanonicalObject.Clone(),
                ["laboratory_evidence_hash"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                    OperatorCourierCertificationEnvelopeVerifier.Canonicalize(transport.LaboratoryEvidence.CanonicalObject)),
                ["laboratory_move_evidence"] = moveProjection,
                ["method"] = request.Method,
                ["path"] = request.Path,
                ["body_present"] = request.BodyPresent,
                ["raw_body_sha256"] = request.SourceBodySha256,
                ["canonical_body_sha256"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(canonicalBody),
                ["phase"] = phase,
                ["effect_id"] = effectId,
                ["effect_hash"] = effectHash,
                ["channel"] = request.Channel,
                ["alias"] = request.Alias,
                ["document_fingerprint"] = documentFingerprint,
                ["document_session_id"] = OperatorNativeDocumentSessionAuthority.GetSessionId(document),
                ["revit_process_id"] = hostProcess.Id,
                ["revit_process_start_utc"] = hostProcess.StartTime.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                ["revit_process_image_path"] = Path.GetFullPath(processImagePath),
                ["native_common_assembly_path"] = LoadedAssemblyPath("RevitBridge.Common"),
                ["native_common_assembly_sha256"] = LoadedAssemblySha256("RevitBridge.Common"),
                ["native_logic_assembly_path"] = LoadedAssemblyPath("RevitBridge.Logic"),
                ["native_logic_assembly_sha256"] = LoadedAssemblySha256("RevitBridge.Logic"),
                ["native_bridge_assembly_path"] = LoadedAssemblyPath("RevitBridge"),
                ["native_bridge_assembly_sha256"] = LoadedAssemblySha256("RevitBridge"),
                ["native_runtime_dependencies"] = runtimeDependencies,
                ["native_runtime_dependencies_hash"] = runtimeDependenciesHash,
                ["native_attestation_algorithm"] = OperatorNativeExecutionAttestationAuthority.Algorithm,
                ["native_attestation_key_id"] = OperatorNativeExecutionAttestationAuthority.KeyId,
                ["native_attestation_modulus_base64url"] = OperatorNativeExecutionAttestationAuthority.ModulusBase64Url,
                ["native_attestation_exponent_base64url"] = OperatorNativeExecutionAttestationAuthority.ExponentBase64Url,
                ["result_hash"] = resultHash,
                ["outcome"] = outcome,
                ["outcome_unknown"] = false,
                ["issued_at_utc"] = issuedAtUtc.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)
            };
            receipt["native_attestation_signature"] =
                OperatorNativeExecutionAttestationAuthority.SignCanonicalPayload(receipt);
            using (var receiptDocument = JsonDocument.Parse(JsonSerializer.Serialize(receipt)))
            {
                var canonicalSignedReceipt = OperatorCourierCertificationEnvelopeVerifier.Canonicalize(receiptDocument.RootElement);
                if (transport.LaboratoryMoveEvidenceAdmission != null)
                {
                    OperatorLaboratoryMoveEvidenceAuthority.RecordVerifiedPreviewReceipt(
                        transport.LaboratoryMoveEvidenceAdmission,
                        transport.LaboratoryEvidence,
                        laboratoryMoveExecutionStart!,
                        canonicalSignedReceipt,
                        issuedAtUtc);
                    OperatorLaboratoryMoveEvidenceAuthority.RecordSuccessfulMoveReceipt(
                        transport.LaboratoryMoveEvidenceAdmission,
                        transport.LaboratoryEvidence);
                }
            }

            var attached = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var property in resultDocument.RootElement.EnumerateObject())
                attached.Add(property.Name, property.Value.Clone());
            attached.Add(ResultField, receipt);
            return attached;
        }

        public static void RequireNoCallerAuthoredReceipt(bool bodyPresent, string bodyJson)
        {
            if (!bodyPresent) return;
            using var document = JsonDocument.Parse(bodyJson);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty(ResultField, out _))
                throw Denied("Caller-authored laboratory execution receipts are forbidden.");
        }

        private static string LoadedAssemblySha256(string simpleName)
        {
            using var stream = File.Open(LoadedAssemblyPath(simpleName), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var algorithm = SHA256.Create();
            var hash = algorithm.ComputeHash(stream);
            return "sha256:" + BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
        }

        private static string LoadedAssemblyPath(string simpleName)
        {
            var matches = AppDomain.CurrentDomain.GetAssemblies()
                .Where(value => string.Equals(value.GetName().Name, simpleName, StringComparison.Ordinal))
                .ToList();
            if (matches.Count != 1 || string.IsNullOrWhiteSpace(matches[0].Location) || !File.Exists(matches[0].Location))
                throw Denied("Protected laboratory evidence cannot identify the exact loaded " + simpleName + " binary.");
            return Path.GetFullPath(matches[0].Location);
        }

        private static List<Dictionary<string, object?>> RuntimeDependencies()
        {
            var directory = Path.GetDirectoryName(LoadedAssemblyPath("RevitBridge"));
            if (string.IsNullOrWhiteSpace(directory)) throw Denied("Protected laboratory evidence cannot identify the deployed native dependency directory.");
            var result = new List<Dictionary<string, object?>>(RuntimeDependencyNames.Length);
            foreach (var name in RuntimeDependencyNames)
            {
                var dependencyPath = RuntimeDependencyPath(directory, name);
                using var stream = File.Open(dependencyPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var algorithm = SHA256.Create();
                result.Add(new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["name"] = name,
                    ["origin"] = IsApprovedHostRuntimeDependency(name, dependencyPath) ? "revit_host" : "deployed_addin",
                    ["path"] = dependencyPath,
                    ["sha256"] = "sha256:" + BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant()
                });
            }
            return result;
        }

        private static string RuntimeDependencyPath(string directory, string name)
        {
            var deployedPath = Path.GetFullPath(Path.Combine(directory, name));
            if (!File.Exists(deployedPath)) throw Denied("Protected laboratory evidence is missing runtime dependency " + name + ".");

            if (string.Equals(name, "WebView2Loader.dll", StringComparison.Ordinal))
            {
                var nativeMatches = Process.GetCurrentProcess().Modules.Cast<ProcessModule>()
                    .Where(value => string.Equals(value.ModuleName, name, StringComparison.OrdinalIgnoreCase))
                    .Select(value => Path.GetFullPath(value.FileName))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();
                if (nativeMatches.Count > 1) throw Denied("Protected laboratory evidence found multiple loaded " + name + " modules.");
                if (nativeMatches.Count == 1 && !string.Equals(nativeMatches[0], deployedPath, StringComparison.OrdinalIgnoreCase))
                    throw Denied("Protected laboratory evidence loaded " + name + " outside the deployed add-in dependency closure.");
                return nativeMatches.Count == 1 ? nativeMatches[0] : deployedPath;
            }

            var simpleName = Path.GetFileNameWithoutExtension(name);
            var managedAssemblies = AppDomain.CurrentDomain.GetAssemblies()
                .Where(value => string.Equals(value.GetName().Name, simpleName, StringComparison.Ordinal))
                .Select(value => new KeyValuePair<string, string>(value.GetName().FullName ?? "", AssemblyLocationOrEmpty(value)))
                .ToList();
            return SelectManagedRuntimeDependencyPath(deployedPath, name, managedAssemblies);
        }

        private static string AssemblyLocationOrEmpty(System.Reflection.Assembly assembly)
        {
            try { return assembly.Location ?? ""; }
            catch (NotSupportedException) { return ""; }
        }

        private static string SelectManagedRuntimeDependencyPath(
            string deployedPath,
            string name,
            IReadOnlyCollection<KeyValuePair<string, string>> managedAssemblies)
        {
            ApprovedHostRuntimeDependencies.TryGetValue(name, out var approved);
            return SelectManagedRuntimeDependencyPathWithApprovedHost(
                deployedPath, name, managedAssemblies, approved?.Path, approved?.Sha256, approved?.AssemblyFullName);
        }

        private static string SelectManagedRuntimeDependencyPathWithApprovedHost(
            string deployedPath,
            string name,
            IReadOnlyCollection<KeyValuePair<string, string>> managedAssemblies,
            string? approvedHostPath,
            string? approvedHostSha256,
            string? approvedHostAssemblyFullName)
        {
            if (managedAssemblies.Any(value => string.IsNullOrWhiteSpace(value.Value))
                || managedAssemblies.Any(value => !File.Exists(value.Value)))
                throw Denied("Protected laboratory evidence cannot resolve every loaded " + name + " assembly location.");
            var deployedIdentity = AssemblyName.GetAssemblyName(deployedPath).FullName ?? "";
            var reviewedIdentities = new HashSet<string>(StringComparer.Ordinal) { deployedIdentity };
            if (!string.IsNullOrWhiteSpace(approvedHostAssemblyFullName)) reviewedIdentities.Add(approvedHostAssemblyFullName!);
            var identityMatches = managedAssemblies
                .Where(value => reviewedIdentities.Contains(value.Key))
                .ToList();
            if (identityMatches.Count == 0)
            {
                if (managedAssemblies.Count > 0)
                    throw Denied("Protected laboratory evidence loaded only unreviewed identities for " + name + ".");
                return deployedPath;
            }
            var managedMatches = identityMatches
                .Select(value => Path.GetFullPath(value.Value))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            if (managedMatches.Count > 1) throw Denied("Protected laboratory evidence found multiple loaded reviewed-identity copies of " + name + ".");

            var selected = managedMatches[0];
            if (string.Equals(selected, deployedPath, StringComparison.OrdinalIgnoreCase))
            {
                if (identityMatches.Any(value => !string.Equals(value.Key, deployedIdentity, StringComparison.Ordinal)))
                    throw Denied("Protected laboratory evidence loaded a different identity from the deployed " + name + ".");
                return selected;
            }
            if (string.IsNullOrWhiteSpace(approvedHostPath) || string.IsNullOrWhiteSpace(approvedHostSha256)
                || string.IsNullOrWhiteSpace(approvedHostAssemblyFullName)
                || !string.Equals(selected, Path.GetFullPath(approvedHostPath), StringComparison.OrdinalIgnoreCase)
                || identityMatches.Any(value => !string.Equals(value.Key, approvedHostAssemblyFullName, StringComparison.Ordinal))
                || !FileHashMatches(selected, approvedHostSha256!))
                throw Denied("Protected laboratory evidence loaded " + name + " outside the reviewed add-in/host dependency closure.");
            return selected;
        }

        private static bool IsApprovedHostRuntimeDependency(string name, string candidatePath, IEnumerable<string>? loadedIdentities = null)
        {
            if (!ApprovedHostRuntimeDependencies.TryGetValue(name, out var approved)
                || !string.Equals(Path.GetFullPath(candidatePath), Path.GetFullPath(approved.Path), StringComparison.OrdinalIgnoreCase)
                || !File.Exists(candidatePath)) return false;
            if (loadedIdentities != null && loadedIdentities.Any(value => !string.Equals(value, approved.AssemblyFullName, StringComparison.Ordinal))) return false;
            return FileHashMatches(candidatePath, approved.Sha256);
        }

        private static bool FileHashMatches(string candidatePath, string expectedSha256)
        {
            using var stream = File.Open(candidatePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var algorithm = SHA256.Create();
            var hash = "sha256:" + BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            return string.Equals(hash, expectedSha256, StringComparison.Ordinal);
        }

        public static bool VerifyAttachedReceipt(object attachedResult)
        {
            try
            {
                using var document = JsonDocument.Parse(JsonSerializer.Serialize(attachedResult));
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object
                    || !root.TryGetProperty(ResultField, out var receipt)
                    || receipt.ValueKind != JsonValueKind.Object
                    || !VerifyReceipt(receipt,
                        OperatorNativeExecutionAttestationAuthority.KeyId,
                        OperatorNativeExecutionAttestationAuthority.ModulusBase64Url,
                        OperatorNativeExecutionAttestationAuthority.ExponentBase64Url))
                    return false;

                var nativeResult = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var property in root.EnumerateObject())
                    if (property.Name != ResultField) nativeResult.Add(property.Name, property.Value.Clone());
                using var nativeResultDocument = JsonDocument.Parse(JsonSerializer.Serialize(nativeResult));
                return String(receipt, "result_hash", out var resultHash)
                    && resultHash == OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                        OperatorCourierCertificationEnvelopeVerifier.Canonicalize(nativeResultDocument.RootElement));
            }
            catch { return false; }
        }

        /// <summary>
        /// Strict receipt-only verification against an independently trusted
        /// native key binding. The receipt's self-presented RSA material is
        /// never treated as the trust root.
        /// </summary>
        public static bool VerifyReceipt(
            JsonElement receipt,
            string expectedKeyId,
            string expectedModulusBase64Url,
            string expectedExponentBase64Url)
        {
            try
            {
                if (!HasExactReceiptKeys(receipt)
                    || !String(receipt, "native_attestation_signature", out var signature)
                    || !String(receipt, "schema", out var schema) || schema != Schema
                    || !String(receipt, "native_attestation_algorithm", out var algorithm)
                    || algorithm != OperatorNativeExecutionAttestationAuthority.Algorithm
                    || !String(receipt, "native_attestation_key_id", out var keyId) || keyId != expectedKeyId
                    || !String(receipt, "native_attestation_modulus_base64url", out var modulus) || modulus != expectedModulusBase64Url
                    || !String(receipt, "native_attestation_exponent_base64url", out var exponent) || exponent != expectedExponentBase64Url
                    || !receipt.TryGetProperty("laboratory_evidence", out var laboratoryEvidence)
                    || !String(receipt, "laboratory_evidence_hash", out var laboratoryEvidenceHash)
                    || laboratoryEvidenceHash != OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                        OperatorCourierCertificationEnvelopeVerifier.Canonicalize(laboratoryEvidence))
                    || !receipt.TryGetProperty("laboratory_move_evidence", out var moveEvidence)
                    || (moveEvidence.ValueKind != JsonValueKind.Null && !OperatorLaboratoryMoveEvidenceAuthority.IsExactProjection(moveEvidence))
                    || !Boolean(receipt, "outcome_unknown", out var unknown) || unknown)
                    return false;
                var dispatch = OperatorLaboratoryEvidenceDispatch.Parse(laboratoryEvidence);
                if (!String(receipt, "channel", out var receiptChannel) || receiptChannel != dispatch.Channel
                    || !String(receipt, "alias", out var receiptAlias) || receiptAlias != dispatch.Alias
                    || !String(receipt, "request_id", out var requestId)
                    || !String(receipt, "dispatch_id", out var dispatchId)) return false;
                if (dispatch.TransportKind == "direct")
                {
                    if (dispatch.JobId != null || dispatch.CorrelationId != null || requestId != dispatchId) return false;
                }
                else if (requestId != dispatch.CorrelationId || dispatchId != dispatch.JobId) return false;
                if (!String(receipt, "path", out var path)
                    || !String(receipt, "phase", out var phase)
                    || !String(receipt, "effect_id", out var effectId)
                    || !String(receipt, "effect_hash", out var effectHash)
                    || effectHash != dispatch.EffectHash
                    || !String(receipt, "document_fingerprint", out var documentFingerprint)
                    || !String(receipt, "document_session_id", out var documentSessionId)
                    || !receipt.TryGetProperty("revit_process_id", out var processId) || processId.ValueKind != JsonValueKind.Number || !processId.TryGetInt32(out var parsedProcessId) || parsedProcessId <= 0
                    || !String(receipt, "revit_process_start_utc", out _)
                    || !String(receipt, "revit_process_image_path", out _)
                    || !String(receipt, "native_common_assembly_path", out _)
                    || !String(receipt, "native_common_assembly_sha256", out _)
                    || !String(receipt, "native_logic_assembly_path", out _)
                    || !String(receipt, "native_logic_assembly_sha256", out _)
                    || !String(receipt, "native_bridge_assembly_path", out _)
                    || !String(receipt, "native_bridge_assembly_sha256", out _)
                    || !VerifyRuntimeDependencies(receipt)) return false;
                if (moveEvidence.ValueKind == JsonValueKind.Null)
                {
                    if (path == "/revit/move-elements") return false;
                }
                else if (path != "/revit/move-elements"
                    || !Matches(moveEvidence, "phase", phase)
                    || !Matches(moveEvidence, "effect_id", effectId)
                    || !Matches(moveEvidence, "effect_hash", effectHash)
                    || !Matches(moveEvidence, "policy_hash", dispatch.PolicyHash)
                    || !Matches(moveEvidence, "policy_record_hash", dispatch.PolicyRecordHash)
                    || !Matches(moveEvidence, "evidence_record_hash", dispatch.EvidenceRecordHash)
                    || !Matches(moveEvidence, "channel", receiptChannel)
                    || !Matches(moveEvidence, "alias", receiptAlias)
                    || !Matches(moveEvidence, "document_fingerprint", documentFingerprint)
                    || !Matches(moveEvidence, "document_session_id", documentSessionId)
                    || !Matches(moveEvidence, "native_attestation_key_id", expectedKeyId)
                    || !Matches(moveEvidence, "native_attestation_modulus_base64url", expectedModulusBase64Url)
                    || !Matches(moveEvidence, "native_attestation_exponent_base64url", expectedExponentBase64Url)) return false;
                var signedPayload = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var property in receipt.EnumerateObject())
                    if (property.Name != "native_attestation_signature") signedPayload.Add(property.Name, property.Value.Clone());
                return OperatorNativeExecutionAttestationAuthority.VerifyCanonicalPayloadWithPublicBinding(
                    signedPayload, signature, expectedKeyId, expectedModulusBase64Url, expectedExponentBase64Url);
            }
            catch { return false; }
        }

        private static string DerivePhase(string method, string path, bool bodyPresent, string bodyJson)
        {
            if (string.Equals(path, "/revit/move-elements", StringComparison.Ordinal))
            {
                if (!string.Equals(method, "POST", StringComparison.Ordinal) || !bodyPresent)
                    throw Denied("Laboratory move evidence requires exact POST body semantics.");
                using var document = JsonDocument.Parse(bodyJson);
                if (document.RootElement.ValueKind != JsonValueKind.Object
                    || !document.RootElement.TryGetProperty("dryRun", out var dryRun)
                    || (dryRun.ValueKind != JsonValueKind.True && dryRun.ValueKind != JsonValueKind.False))
                    throw Denied("Laboratory move evidence requires an explicit boolean dryRun phase selector.");
                return dryRun.GetBoolean() ? "preview" : "apply";
            }
            if (string.Equals(method, "GET", StringComparison.Ordinal)
                || string.Equals(path, "/revit/context", StringComparison.Ordinal)
                || string.Equals(path, "/revit/export-visible-elements", StringComparison.Ordinal))
                return "read";
            return "apply";
        }

        private static string RequireSuccessfulOutcome(string phase, JsonElement result)
        {
            if (result.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.False)
                throw Denied("Failed native results cannot receive successful laboratory execution evidence.");
            if (phase == "preview")
            {
                if (!result.TryGetProperty("rolledBack", out var rolledBack)
                    || rolledBack.ValueKind != JsonValueKind.True)
                    throw Denied("Preview evidence requires a native result proving rollback.");
                return "rolled_back";
            }
            if (phase == "apply")
            {
                if (result.TryGetProperty("rolledBack", out var rolledBack)
                    && rolledBack.ValueKind != JsonValueKind.False)
                    throw Denied("Apply evidence cannot claim a rolled-back or ambiguous mutation result.");
                return "committed";
            }
            return "read_completed";
        }

        private static string DeriveEffectId(string method, string path, string phase)
        {
            if (phase == "read") return "revit-operator.spatial-observation-readback.effect.v1";
            if (string.Equals(path, "/revit/move-elements", StringComparison.Ordinal))
                return phase == "preview"
                    ? "revit-operator.certified-move-one.preview.effect.v1"
                    : "revit-operator.certified-move-one.apply.effect.v1";
            return method + " " + path + "#" + phase;
        }

        private static string DeriveEffectHash(string path, string phase, JsonElement genericEffect)
        {
            // These are the independently reviewed candidate effect identities.
            // Native code selects one only after deriving the route/body phase.
            if (phase == "read")
                return "sha256:0f19ae675c51b10854e3977070ad34e4898a004c4a724058f933c17233f37bf8";
            if (string.Equals(path, "/revit/move-elements", StringComparison.Ordinal))
                return phase == "preview"
                    ? "sha256:4b9d9a0b4beb537b1db23b84aa3a2319497c0250fcc55ede2d87107d06ae428b"
                    : "sha256:4da2bf877ae0747d17dec5123defd1912193bd2b9c59b57f7dd8d4aa7b7e1e7b";
            return OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                OperatorCourierCertificationEnvelopeVerifier.Canonicalize(genericEffect));
        }

        private static string CanonicalBody(bool bodyPresent, string bodyJson)
        {
            if (!bodyPresent) return "";
            using var document = JsonDocument.Parse(bodyJson);
            return OperatorCourierCertificationEnvelopeVerifier.Canonicalize(document.RootElement);
        }

        private static void RequireExactLaboratoryLane()
        {
            if (!string.Equals(Environment.GetEnvironmentVariable("REVIT_OPERATOR_MODE"), "development", StringComparison.Ordinal)
                || !string.Equals(Environment.GetEnvironmentVariable("OPERATOR_TOOL_EXPOSURE_PROFILE"), "laboratory", StringComparison.Ordinal)
                || !string.Equals(Environment.GetEnvironmentVariable("OPERATOR_CERTIFICATION_PROTECTED_LABORATORY"), "1", StringComparison.Ordinal))
                throw Denied("Courier laboratory execution is forbidden outside the exact protected development/laboratory lane.");
        }

        private static string RandomBase64Url(int byteCount)
        {
            var bytes = new byte[byteCount];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        private static bool HasExactReceiptKeys(JsonElement receipt)
        {
            var expected = new HashSet<string>(new[]
            {
                "schema", "request_id", "dispatch_id", "transport_request_nonce", "transport_server_epoch",
                "transport_issued_at_utc", "laboratory_evidence", "laboratory_evidence_hash",
                "laboratory_move_evidence", "method", "path", "body_present",
                "raw_body_sha256", "canonical_body_sha256", "phase", "effect_id", "effect_hash",
                "channel", "alias", "document_fingerprint", "document_session_id",
                "revit_process_id", "revit_process_start_utc", "revit_process_image_path",
                "native_common_assembly_path", "native_common_assembly_sha256",
                "native_logic_assembly_path", "native_logic_assembly_sha256",
                "native_bridge_assembly_path", "native_bridge_assembly_sha256",
                "native_runtime_dependencies", "native_runtime_dependencies_hash",
                "native_attestation_algorithm", "native_attestation_key_id",
                "native_attestation_modulus_base64url", "native_attestation_exponent_base64url",
                "result_hash", "outcome", "outcome_unknown", "issued_at_utc", "native_attestation_signature"
            }, StringComparer.Ordinal);
            foreach (var property in receipt.EnumerateObject())
                if (!expected.Remove(property.Name)) return false;
            return expected.Count == 0;
        }

        private static bool String(JsonElement value, string name, out string result)
        {
            result = "";
            return value.TryGetProperty(name, out var property)
                && property.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(result = property.GetString() ?? "");
        }

        private static bool VerifyRuntimeDependencies(JsonElement receipt)
        {
            if (!receipt.TryGetProperty("native_runtime_dependencies", out var dependencies)
                || dependencies.ValueKind != JsonValueKind.Array || dependencies.GetArrayLength() != RuntimeDependencyNames.Length
                || !String(receipt, "native_runtime_dependencies_hash", out var expectedHash)
                || expectedHash != OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                    OperatorCourierCertificationEnvelopeVerifier.Canonicalize(dependencies))
                || !String(receipt, "native_bridge_assembly_path", out var bridgePath)) return false;
            var expectedDirectory = Path.GetDirectoryName(Path.GetFullPath(bridgePath));
            if (string.IsNullOrWhiteSpace(expectedDirectory)) return false;
            var index = 0;
            foreach (var dependency in dependencies.EnumerateArray())
            {
                if (dependency.ValueKind != JsonValueKind.Object || dependency.EnumerateObject().Count() != 4
                    || !String(dependency, "name", out var name) || name != RuntimeDependencyNames[index++]
                    || !String(dependency, "origin", out var origin) || (origin != "deployed_addin" && origin != "revit_host")
                    || !String(dependency, "path", out var dependencyPath) || !Path.IsPathRooted(dependencyPath)
                    || !string.Equals(Path.GetFileName(dependencyPath), name, StringComparison.Ordinal)
                    || !String(dependency, "sha256", out var dependencyHash) || !IsSha256(dependencyHash)) return false;
                if (origin == "deployed_addin")
                {
                    if (!string.Equals(Path.GetDirectoryName(Path.GetFullPath(dependencyPath)), expectedDirectory, StringComparison.OrdinalIgnoreCase)) return false;
                }
                else if (!ApprovedHostRuntimeDependencies.TryGetValue(name, out var approved)
                    || !string.Equals(Path.GetFullPath(dependencyPath), Path.GetFullPath(approved.Path), StringComparison.OrdinalIgnoreCase)
                    || dependencyHash != approved.Sha256) return false;
            }
            return true;
        }

        private static bool IsSha256(string value)
        {
            if (value.Length != 71 || !value.StartsWith("sha256:", StringComparison.Ordinal)) return false;
            for (var index = 7; index < value.Length; index++)
            {
                var character = value[index];
                if ((character < '0' || character > '9') && (character < 'a' || character > 'f')) return false;
            }
            return true;
        }

        private static bool Boolean(JsonElement value, string name, out bool result)
        {
            result = false;
            if (!value.TryGetProperty(name, out var property)
                || (property.ValueKind != JsonValueKind.True && property.ValueKind != JsonValueKind.False)) return false;
            result = property.GetBoolean();
            return true;
        }

        private static bool Matches(JsonElement value, string name, string expected)
            => String(value, name, out var actual) && actual == expected;

        private static OperatorNativeHttpAdmissionException Denied(string message)
            => new OperatorNativeHttpAdmissionException(
                "CERTIFICATION_LABORATORY_EXECUTION_EVIDENCE_DENIED",
                message,
                403,
                false,
                "healthy");
    }

    public sealed class OperatorLaboratoryCourierReceiptContext
    {
        internal OperatorLaboratoryCourierReceiptContext(OperatorNativeTransportRequestContext nativeTransportContext)
            => NativeTransportContext = nativeTransportContext ?? throw new ArgumentNullException(nameof(nativeTransportContext));
        internal OperatorNativeTransportRequestContext NativeTransportContext { get; }
        public OperatorLaboratoryEvidenceDispatch LaboratoryEvidence => NativeTransportContext.LaboratoryEvidence!;
        public OperatorLaboratoryMoveEvidenceAdmission? LaboratoryMoveEvidenceAdmission => NativeTransportContext.LaboratoryMoveEvidenceAdmission;
        public string NativeActionNonce => NativeTransportContext.RequestNonce;
        public string NativeProcessEpoch => NativeTransportContext.ServerEpoch;
        public DateTimeOffset IssuedAtUtc => NativeTransportContext.IssuedAtUtc;
    }
}
