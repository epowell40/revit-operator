using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    /// <summary>
    /// Narrow activation boundary for the reviewed observation and core-operation v1 adapters.
    /// Every handler also performs its own exact development/laboratory check so an alternate
    /// in-process dispatcher cannot accidentally bypass the HTTP exposure gate.
    /// </summary>
    internal static class DynamicRuntimeV1LaboratoryBoundary
    {
        internal static void Require()
        {
            if (!string.Equals(Environment.GetEnvironmentVariable("REVIT_OPERATOR_MODE"), "development", StringComparison.Ordinal) ||
                !string.Equals(Environment.GetEnvironmentVariable("OPERATOR_TOOL_EXPOSURE_PROFILE"), "laboratory", StringComparison.Ordinal))
                throw new InvalidOperationException("Dynamic runtime v1 adapters are available only in the exact development/laboratory profile.");
        }
    }

    internal static class DynamicRuntimeV1Wire
    {
        internal static readonly JsonSerializerOptions Camel = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = false,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            NumberHandling = JsonNumberHandling.Strict,
            MaxDepth = 32
        };

        internal static T ParseExact<T>(string json, params string[] fields)
        {
            if (json == null || Encoding.UTF8.GetByteCount(json) > 256 * 1024)
                throw new ArgumentException("Dynamic runtime v1 request exceeds the bounded wire size.");
            using (var document = JsonDocument.Parse(json, new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 32 }))
                RejectDuplicateFields(document.RootElement);
            DynamicRuntimeApplyAuthorizationHandler.ExactShape(json, fields);
            return JsonSerializer.Deserialize<T>(json, Camel) ?? throw new ArgumentException("Dynamic runtime v1 request is invalid.");
        }

        internal static string CoreHash(object value) => DynamicWire.Sha256(JsonSerializer.Serialize(value, Camel));

        internal static JsonElement CamelElement<T>(T value)
        {
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(value, Camel));
            return document.RootElement.Clone();
        }

        private static void RejectDuplicateFields(JsonElement value)
        {
            if (value.ValueKind == JsonValueKind.Object)
            {
                var names = new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject())
                {
                    if (!names.Add(property.Name)) throw new ArgumentException("Dynamic runtime v1 request contains duplicate fields.");
                    RejectDuplicateFields(property.Value);
                }
            }
            else if (value.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in value.EnumerateArray()) RejectDuplicateFields(item);
            }
        }
    }

    public sealed class DynamicRuntimeObservationV1Handler : IRequestHandler
    {
        private sealed class Request
        {
            public string? Schema { get; set; }
            public string? RuntimeInstanceId { get; set; }
            public DynamicObservationSelectorV1? Selector { get; set; }
            public string? CorrelationId { get; set; }
            public long AuthExpiresUnixSeconds { get; set; }
            public string? RequestMac { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            DynamicRuntimeV1LaboratoryBoundary.Require();
            var request = DynamicRuntimeV1Wire.ParseExact<Request>(jsonData, "schema", "runtimeInstanceId", "selector", "correlationId", "authExpiresUnixSeconds", "requestMac");
            if (request.Schema != "dynamic-revit-observation-request/v1" || request.Selector == null)
                throw new ArgumentException("Dynamic observation request v1 is invalid.");
            DynamicObservationPolicyV1.ValidateSelector(request.Selector);
            var core = new { schema = request.Schema, runtimeInstanceId = request.RuntimeInstanceId, selector = request.Selector };
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.RuntimeInstanceId ?? "", "observe-v1", request.CorrelationId ?? "",
                request.AuthExpiresUnixSeconds, DynamicRuntimeV1Wire.CoreHash(core), request.RequestMac ?? "");
            DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.RuntimeInstanceId ?? "");
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            var envelope = DynamicObservationRevitAdapterV1.Observe(document, request.Selector);
            var receipt = new
            {
                schema = "dynamic-revit-observation-receipt/v1",
                contract_manifest_hash = DynamicObservationContractV1.ManifestHash,
                envelope_hash = envelope.EnvelopeHash,
                document_fingerprint = envelope.DocumentFingerprint,
                document_session_id = envelope.DocumentSessionId,
                authorization_granted = false,
                envelope = DynamicRuntimeV1Wire.CamelElement(envelope)
            };
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(request.RuntimeInstanceId ?? "", "observe-v1-receipt", receipt));
        }
    }

    internal sealed class DynamicBuildingSystemsSnapshotSealV1
    {
        internal string SnapshotId = "";
        internal string RuntimeId = "";
        internal string DocumentFingerprint = "";
        internal string DocumentSessionId = "";
        internal string ScopeHash = "";
        internal string SnapshotHash = "";
        internal long DocumentRevision;
        internal string DocumentStateHash = "";
        internal DateTime ExpiresUtc;
        internal readonly object EnvelopeGate = new object();
        internal readonly Dictionary<int, string> EnvelopeHashesByOffset = new Dictionary<int, string>();
        internal int? ObservedTotalCount;
        internal int? ObservedPageSize;
    }

    internal static class DynamicBuildingSystemsSnapshotAuthorityV1
    {
        private static readonly ConcurrentDictionary<string, DynamicBuildingSystemsSnapshotSealV1> Snapshots = new ConcurrentDictionary<string, DynamicBuildingSystemsSnapshotSealV1>(StringComparer.Ordinal);

        internal static DynamicBuildingSystemsSnapshotSealV1 Issue(string runtimeId, Document document, string documentFingerprint, string documentSessionId,
            DynamicBuildingSystemsSelectorV1 selector)
        {
            Prune();
            var revision = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var scopeHash = DynamicBuildingSystemsObservationPolicyV1.ScopeHash(selector);
            var nonce = new byte[32]; using (var random = RandomNumberGenerator.Create()) random.GetBytes(nonce);
            var seal = new DynamicBuildingSystemsSnapshotSealV1
            {
                SnapshotId = "buildingsnapshot_" + Guid.NewGuid().ToString("N"), RuntimeId = runtimeId,
                DocumentFingerprint = documentFingerprint, DocumentSessionId = documentSessionId,
                ScopeHash = scopeHash, DocumentRevision = revision,
                DocumentStateHash = DocumentStateHash(document),
                SnapshotHash = DynamicWire.Sha256(Convert.ToBase64String(nonce) + "\n" + documentFingerprint + "\n" + documentSessionId + "\n" + scopeHash + "\n" + revision),
                ExpiresUtc = DateTime.UtcNow.AddMinutes(2)
            };
            if (!Snapshots.TryAdd(seal.SnapshotId, seal)) throw new InvalidOperationException("Building-systems snapshot identity collided.");
            return seal;
        }

        internal static DynamicBuildingSystemsSnapshotSealV1 Require(string runtimeId, string snapshotId, string documentFingerprint,
            string documentSessionId, DynamicBuildingSystemsSelectorV1 selector)
        {
            Prune();
            if (!Snapshots.TryGetValue(snapshotId ?? "", out var seal) || seal.ExpiresUtc <= DateTime.UtcNow || seal.RuntimeId != runtimeId ||
                seal.DocumentFingerprint != documentFingerprint || seal.DocumentSessionId != documentSessionId ||
                seal.ScopeHash != DynamicBuildingSystemsObservationPolicyV1.ScopeHash(selector))
                throw new InvalidOperationException("Building-systems snapshot is unknown, expired, stale, or scope-substituted.");
            return seal;
        }

        internal static void RequireUnchanged(string snapshotId, Document document)
        {
            if (!Snapshots.TryGetValue(snapshotId ?? "", out var seal) || seal.ExpiresUtc <= DateTime.UtcNow ||
                seal.DocumentFingerprint != DynamicRuntimeSnapshotHandler.Fingerprint(document) || seal.DocumentSessionId != DynamicRuntimeSnapshotHandler.Session(document) ||
                seal.DocumentStateHash != DocumentStateHash(document))
                throw new InvalidOperationException("Building-systems snapshot document state changed after observation.");
        }

        internal static void RecordEnvelope(string snapshotId, DynamicBuildingSystemsEnvelopeV1 envelope)
        {
            if (!Snapshots.TryGetValue(snapshotId ?? "", out var seal) || seal.ExpiresUtc <= DateTime.UtcNow)
                throw new InvalidOperationException("Building-systems snapshot expired before its observation envelope was recorded.");
            DynamicBuildingSystemsObservationPolicyV1.ValidateEnvelope(envelope);
            if (envelope.SnapshotHash != seal.SnapshotHash || envelope.ScopeHash != seal.ScopeHash || envelope.DocumentRevision != seal.DocumentRevision ||
                envelope.DocumentFingerprint != seal.DocumentFingerprint || envelope.DocumentSessionId != seal.DocumentSessionId)
                throw new InvalidOperationException("Building-systems envelope does not bind the sealed snapshot.");
            lock (seal.EnvelopeGate)
            {
                if (seal.ObservedTotalCount.HasValue && (seal.ObservedTotalCount.Value != envelope.TotalCount || seal.ObservedPageSize != envelope.PageSize))
                    throw new InvalidOperationException("Building-systems snapshot page totals or page size changed.");
                if (seal.EnvelopeHashesByOffset.TryGetValue(envelope.PageOffset, out var prior) && prior != envelope.EnvelopeHash)
                    throw new InvalidOperationException("Building-systems snapshot page was equivocally replaced.");
                seal.ObservedTotalCount = envelope.TotalCount;
                seal.ObservedPageSize = envelope.PageSize;
                seal.EnvelopeHashesByOffset[envelope.PageOffset] = envelope.EnvelopeHash;
            }
        }

        internal static void RequireCompleteEnvelopeSet(string snapshotId, IEnumerable<string> envelopeHashes)
        {
            if (!Snapshots.TryGetValue(snapshotId ?? "", out var seal) || seal.ExpiresUtc <= DateTime.UtcNow)
                throw new InvalidOperationException("Building-systems snapshot is unavailable for result-reference admission.");
            var supplied = (envelopeHashes ?? throw new ArgumentNullException(nameof(envelopeHashes))).ToArray();
            if (supplied.Length < 1 || supplied.Length > 64 || supplied.Any(value => !DynamicRuntimePreviewHandler.IsHash(value)) || supplied.Distinct(StringComparer.Ordinal).Count() != supplied.Length)
                throw new ArgumentException("Building-systems envelope identity set is invalid or unbounded.");
            lock (seal.EnvelopeGate)
            {
                if (!seal.ObservedTotalCount.HasValue || !seal.ObservedPageSize.HasValue)
                    throw new InvalidOperationException("Building-systems snapshot has no authenticated observation pages.");
                var expectedPageCount = Math.Max(1, (seal.ObservedTotalCount.Value + seal.ObservedPageSize.Value - 1) / seal.ObservedPageSize.Value);
                var expectedOffsets = Enumerable.Range(0, expectedPageCount).Select(index => index * seal.ObservedPageSize.Value).ToArray();
                if (seal.EnvelopeHashesByOffset.Count != expectedPageCount || expectedOffsets.Any(offset => !seal.EnvelopeHashesByOffset.ContainsKey(offset)) ||
                    !new HashSet<string>(supplied, StringComparer.Ordinal).SetEquals(seal.EnvelopeHashesByOffset.Values))
                    throw new InvalidOperationException("Building-systems observation page set is incomplete, duplicated, or substituted.");
            }
        }

        private static void Prune()
        {
            foreach (var key in Snapshots.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray()) Snapshots.TryRemove(key, out _);
        }

        private static string DocumentStateHash(Document document)
        {
            const int maximum = 50000;
            var values = new List<string>();
            foreach (var element in new FilteredElementCollector(document).WhereElementIsNotElementType())
            {
                if (values.Count >= maximum) throw new InvalidOperationException("Building-systems snapshot document exceeds the 50000-element exact revision bound.");
                values.Add(ElementIdCompat.GetValue(element.Id).ToString(System.Globalization.CultureInfo.InvariantCulture) + "\n" +
                    (element.UniqueId ?? "") + "\n" + DynamicAnnotationRevitStateV1.StateHash(element));
            }
            values.Sort(StringComparer.Ordinal);
            return DynamicWire.Sha256("dynamic-revit-building-systems-document-state/v1\n" + string.Join("\n", values));
        }
    }

    public sealed class DynamicBuildingSystemsObservationV1Handler : IRequestHandler
    {
        private sealed class Request
        {
            public string? Schema { get; set; }
            public string? RuntimeInstanceId { get; set; }
            public DynamicBuildingSystemsSelectorV1? Selector { get; set; }
            public string? SnapshotId { get; set; }
            public string? CorrelationId { get; set; }
            public long AuthExpiresUnixSeconds { get; set; }
            public string? RequestMac { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            DynamicRuntimeV1LaboratoryBoundary.Require();
            if (jsonData == null || Encoding.UTF8.GetByteCount(jsonData) > DynamicBuildingSystemsObservationContractV1.MaximumRequestBytes)
                throw new ArgumentException("Building-systems observation request exceeds 64 KiB.");
            var request = DynamicRuntimeV1Wire.ParseExact<Request>(jsonData, "schema", "runtimeInstanceId", "selector", "snapshotId", "correlationId", "authExpiresUnixSeconds", "requestMac");
            if (request.Schema != "dynamic-revit-building-systems-request/v1" || request.Selector == null)
                throw new ArgumentException("Building-systems observation request v1 is invalid.");
            DynamicBuildingSystemsObservationPolicyV1.ValidateSelector(request.Selector);
            var core = new { schema = request.Schema, runtimeInstanceId = request.RuntimeInstanceId, selector = request.Selector, snapshotId = request.SnapshotId };
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.RuntimeInstanceId ?? "", "observe-building-systems-v1", request.CorrelationId ?? "",
                request.AuthExpiresUnixSeconds, DynamicRuntimeV1Wire.CoreHash(core), request.RequestMac ?? "");
            var runtime = DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.RuntimeInstanceId ?? "");
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            var fingerprint = DynamicRuntimeSnapshotHandler.Fingerprint(document);
            var session = DynamicRuntimeSnapshotHandler.Session(document);
            var snapshot = string.IsNullOrWhiteSpace(request.SnapshotId)
                ? DynamicBuildingSystemsSnapshotAuthorityV1.Issue(request.RuntimeInstanceId ?? "", document, fingerprint, session, request.Selector)
                : DynamicBuildingSystemsSnapshotAuthorityV1.Require(request.RuntimeInstanceId ?? "", request.SnapshotId ?? "", fingerprint, session, request.Selector);
            DynamicBuildingSystemsSnapshotAuthorityV1.RequireUnchanged(snapshot.SnapshotId, document);
            var envelope = DynamicBuildingSystemsObservationAdapterV1.Observe(document, request.Selector, snapshot.DocumentRevision, snapshot.SnapshotHash);
            DynamicBuildingSystemsSnapshotAuthorityV1.RecordEnvelope(snapshot.SnapshotId, envelope);
            var receipt = new
            {
                schema = "dynamic-revit-building-systems-receipt/v1",
                snapshot_id = snapshot.SnapshotId,
                snapshot_hash = snapshot.SnapshotHash,
                document_revision = snapshot.DocumentRevision,
                contract_manifest_hash = DynamicBuildingSystemsObservationContractV1.ManifestHash,
                sdk_manifest_hash = DynamicRevitSdkProductionVersion.ManifestHash,
                worker_runtime_package_hash = runtime.WorkerRuntimePackageHash,
                envelope_hash = envelope.EnvelopeHash,
                document_fingerprint = envelope.DocumentFingerprint,
                document_session_id = envelope.DocumentSessionId,
                authorization_granted = false,
                envelope = DynamicRuntimeV1Wire.CamelElement(envelope)
            };
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(request.RuntimeInstanceId ?? "", "observe-building-systems-v1-receipt", receipt));
        }
    }

    internal sealed class DynamicCoreOperationPreviewSealV1
    {
        internal string PreviewId = "";
        internal string RuntimeId = "";
        internal DynamicOperationGraphV1 Graph = new DynamicOperationGraphV1();
        internal DynamicEffectBudgetV1 Budget = new DynamicEffectBudgetV1();
        internal DynamicCoreOperationManifestBindingV1 Binding = new DynamicCoreOperationManifestBindingV1();
        internal DynamicCoreOperationPreviewV1 Preview = new DynamicCoreOperationPreviewV1();
        internal string DocumentSessionId = "";
        internal int PlannedExecutionMilliseconds;
        internal DateTime ExpiresUtc;
    }

    internal sealed class DynamicCoreOperationAuthorizationSealV1
    {
        internal string AuthorizationId = "";
        internal DynamicCoreOperationPreviewSealV1 Preview = new DynamicCoreOperationPreviewSealV1();
        internal DynamicCoreOperationApplyAuthorizationV1 Authorization = new DynamicCoreOperationApplyAuthorizationV1();
        internal DateTime ExpiresUtc;
    }

    internal static class DynamicCoreOperationLaboratoryStateV1
    {
        private static readonly ConcurrentDictionary<string, DynamicCoreOperationPreviewSealV1> Previews = new ConcurrentDictionary<string, DynamicCoreOperationPreviewSealV1>(StringComparer.Ordinal);
        private static readonly ConcurrentDictionary<string, DynamicCoreOperationAuthorizationSealV1> Authorizations = new ConcurrentDictionary<string, DynamicCoreOperationAuthorizationSealV1>(StringComparer.Ordinal);
        private static readonly object AuthorizationGate = new object();

        internal static void RegisterPreview(DynamicCoreOperationPreviewSealV1 preview)
        {
            Prune();
            if (!Previews.TryAdd(preview.PreviewId, preview)) throw new InvalidOperationException("Core-operation preview identity collided.");
        }

        internal static DynamicCoreOperationPreviewSealV1 RequirePreview(string runtimeId, string previewId, string previewHash)
        {
            Prune();
            if (!Previews.TryGetValue(previewId ?? "", out var preview) || preview.ExpiresUtc <= DateTime.UtcNow ||
                preview.RuntimeId != runtimeId || preview.Preview.PreviewHash != previewHash)
                throw new InvalidOperationException("Core-operation preview is unknown, expired, or substituted.");
            return preview;
        }

        internal static DynamicCoreOperationAuthorizationSealV1 Authorize(DynamicCoreOperationPreviewSealV1 preview,
            DynamicCoreOperationApplyAuthorizationV1 authorization)
        {
            Prune();
            var seal = new DynamicCoreOperationAuthorizationSealV1
            {
                AuthorizationId = authorization.AuthorizationId,
                Preview = preview,
                Authorization = authorization,
                ExpiresUtc = DateTimeOffset.FromUnixTimeSeconds(authorization.ExpiresUnixSeconds).UtcDateTime
            };
            lock (AuthorizationGate)
            {
                if (Authorizations.Values.Any(value => value.ExpiresUtc > DateTime.UtcNow && value.Preview.PreviewId == preview.PreviewId))
                    throw new InvalidOperationException("Core-operation preview already has a live apply authorization.");
                if (!Authorizations.TryAdd(seal.AuthorizationId, seal)) throw new InvalidOperationException("Core-operation authorization identity collided.");
            }
            return seal;
        }

        internal static DynamicCoreOperationAuthorizationSealV1 TakeAuthorization(string runtimeId, string previewId, string authorizationId)
        {
            Prune();
            if (!Authorizations.TryRemove(authorizationId ?? "", out var authorization) || authorization.ExpiresUtc <= DateTime.UtcNow ||
                authorization.Preview.RuntimeId != runtimeId || authorization.Preview.PreviewId != previewId)
                throw new InvalidOperationException("Core-operation authorization is unknown, expired, consumed, or substituted.");
            Previews.TryRemove(previewId ?? "", out _);
            return authorization;
        }

        private static void Prune()
        {
            foreach (var key in Previews.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray()) Previews.TryRemove(key, out _);
            foreach (var key in Authorizations.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray()) Authorizations.TryRemove(key, out _);
        }
    }

    public sealed class DynamicCoreOperationPreviewV1Handler : IRequestHandler
    {
        private sealed class Request
        {
            public string? Schema { get; set; }
            public string? RuntimeInstanceId { get; set; }
            public DynamicOperationGraphV1? Graph { get; set; }
            public DynamicEffectBudgetV1? EffectBudget { get; set; }
            public int PlannedExecutionMilliseconds { get; set; }
            public string? NonceHash { get; set; }
            public string? CorrelationId { get; set; }
            public long AuthExpiresUnixSeconds { get; set; }
            public string? RequestMac { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            DynamicRuntimeV1LaboratoryBoundary.Require();
            var request = DynamicRuntimeV1Wire.ParseExact<Request>(jsonData, "schema", "runtimeInstanceId", "graph", "effectBudget", "plannedExecutionMilliseconds", "nonceHash", "correlationId", "authExpiresUnixSeconds", "requestMac");
            if (request.Schema != "dynamic-revit-core-preview-request/v1" || request.Graph == null || request.EffectBudget == null ||
                request.PlannedExecutionMilliseconds < 1 || request.PlannedExecutionMilliseconds > 5000 || !DynamicRuntimePreviewHandler.IsHash(request.NonceHash))
                throw new ArgumentException("Dynamic core-operation preview request v1 is invalid.");
            var core = new { schema = request.Schema, runtimeInstanceId = request.RuntimeInstanceId, graph = request.Graph, effectBudget = request.EffectBudget,
                plannedExecutionMilliseconds = request.PlannedExecutionMilliseconds, nonceHash = request.NonceHash };
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.RuntimeInstanceId ?? "", "core-preview-v1", request.CorrelationId ?? "",
                request.AuthExpiresUnixSeconds, DynamicRuntimeV1Wire.CoreHash(core), request.RequestMac ?? "");
            var runtime = DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.RuntimeInstanceId ?? "");
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            if (request.Graph.DocumentFingerprint != DynamicRuntimeSnapshotHandler.Fingerprint(document))
                throw new InvalidOperationException("Core-operation graph is not bound to the active document.");
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var binding = DynamicCoreOperationManifestBindingPolicyV1.Issue(request.Graph,
                DynamicCoreOperationHostV1.HostAdapterManifestHash(app.Application.VersionNumber), now, now + 120, runtime.Key,
                "corebind_" + Guid.NewGuid().ToString("N"), request.NonceHash ?? "");
            var preview = DynamicCoreOperationHostV1.Preview(app, request.Graph, request.EffectBudget, binding, runtime.Key, now, request.PlannedExecutionMilliseconds);
            var previewId = "corepreview_" + Guid.NewGuid().ToString("N");
            var seal = new DynamicCoreOperationPreviewSealV1
            {
                PreviewId = previewId,
                RuntimeId = request.RuntimeInstanceId ?? "",
                Graph = Clone(request.Graph),
                Budget = Clone(request.EffectBudget),
                Binding = binding,
                Preview = preview,
                DocumentSessionId = DynamicRuntimeSnapshotHandler.Session(document),
                PlannedExecutionMilliseconds = request.PlannedExecutionMilliseconds,
                ExpiresUtc = DateTime.UtcNow.AddSeconds(110)
            };
            DynamicCoreOperationLaboratoryStateV1.RegisterPreview(seal);
            var receipt = new
            {
                schema = "dynamic-revit-core-preview-receipt/v1",
                preview_id = previewId,
                preview_hash = preview.PreviewHash,
                graph_hash = request.Graph.GraphHash,
                effect_budget_hash = request.EffectBudget.CanonicalHash(),
                document_fingerprint = request.Graph.DocumentFingerprint,
                document_session_id = seal.DocumentSessionId,
                host_adapter_manifest_hash = binding.HostAdapterManifestHash,
                binding = DynamicRuntimeV1Wire.CamelElement(binding),
                preview = DynamicRuntimeV1Wire.CamelElement(preview),
                outcome = "preview_rolled_back_verified",
                authorization_granted = false
            };
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(seal.RuntimeId, "core-preview-v1-receipt", receipt));
        }

        private static T Clone<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value, DynamicRuntimeV1Wire.Camel), DynamicRuntimeV1Wire.Camel)
            ?? throw new InvalidOperationException("Core-operation preview state could not be sealed.");
    }

    public sealed class DynamicCoreOperationAuthorizeV1Handler : IRequestHandler
    {
        private sealed class Request
        {
            public string? Schema { get; set; }
            public string? RuntimeInstanceId { get; set; }
            public string? PreviewId { get; set; }
            public string? PreviewHash { get; set; }
            public string? CorrelationId { get; set; }
            public long AuthExpiresUnixSeconds { get; set; }
            public string? RequestMac { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            DynamicRuntimeV1LaboratoryBoundary.Require();
            var request = DynamicRuntimeV1Wire.ParseExact<Request>(jsonData, "schema", "runtimeInstanceId", "previewId", "previewHash", "correlationId", "authExpiresUnixSeconds", "requestMac");
            if (request.Schema != "dynamic-revit-core-authorize-request/v1") throw new ArgumentException("Dynamic core-operation authorization request v1 is invalid.");
            var core = new { schema = request.Schema, runtimeInstanceId = request.RuntimeInstanceId, previewId = request.PreviewId, previewHash = request.PreviewHash };
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.RuntimeInstanceId ?? "", "core-authorize-v1", request.CorrelationId ?? "",
                request.AuthExpiresUnixSeconds, DynamicRuntimeV1Wire.CoreHash(core), request.RequestMac ?? "");
            var runtime = DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.RuntimeInstanceId ?? "");
            var preview = DynamicCoreOperationLaboratoryStateV1.RequirePreview(request.RuntimeInstanceId ?? "", request.PreviewId ?? "", request.PreviewHash ?? "");
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            if (DynamicRuntimeSnapshotHandler.Fingerprint(document) != preview.Graph.DocumentFingerprint || DynamicRuntimeSnapshotHandler.Session(document) != preview.DocumentSessionId)
                throw new InvalidOperationException("Core-operation document identity changed after preview.");
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var context = DynamicCoreOperationHostV1.BuildAdmissionContext(app, preview.Graph, preview.Budget, preview.PlannedExecutionMilliseconds);
            DynamicCoreOperationAdmissionV1.Validate(preview.Graph, preview.Budget, context, preview.Binding, runtime.Key, now, "apply");
            var expires = Math.Min(now + 90, preview.Binding.ExpiresUnixSeconds);
            var authorization = DynamicCoreOperationApplyAuthorizationPolicyV1.Issue(preview.Graph, preview.Binding, preview.Preview.EffectSetHash,
                expires, runtime.Key, "coreauth_" + Guid.NewGuid().ToString("N"));
            DynamicCoreOperationLaboratoryStateV1.Authorize(preview, authorization);
            var receipt = new
            {
                schema = "dynamic-revit-core-authorize-receipt/v1",
                authorization_id = authorization.AuthorizationId,
                preview_id = preview.PreviewId,
                preview_hash = preview.Preview.PreviewHash,
                graph_hash = preview.Graph.GraphHash,
                effect_set_hash = preview.Preview.EffectSetHash,
                expires_unix_seconds = authorization.ExpiresUnixSeconds,
                authorization = DynamicRuntimeV1Wire.CamelElement(authorization),
                authorization_granted = true
            };
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(preview.RuntimeId, "core-authorize-v1-receipt", receipt));
        }
    }

    public sealed class DynamicCoreOperationApplyV1Handler : IRequestHandler
    {
        private sealed class Request
        {
            public string? Schema { get; set; }
            public string? Phase { get; set; }
            public string? RuntimeInstanceId { get; set; }
            public string? PreviewId { get; set; }
            public string? AuthorizationId { get; set; }
            public string? CorrelationId { get; set; }
            public long AuthExpiresUnixSeconds { get; set; }
            public string? RequestMac { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            DynamicRuntimeV1LaboratoryBoundary.Require();
            var request = DynamicRuntimeV1Wire.ParseExact<Request>(jsonData, "schema", "phase", "runtimeInstanceId", "previewId", "authorizationId", "correlationId", "authExpiresUnixSeconds", "requestMac");
            if (request.Schema != "dynamic-revit-core-apply-request/v1" || request.Phase != "apply") throw new ArgumentException("Dynamic core-operation apply request v1 is invalid.");
            var core = new { schema = request.Schema, phase = request.Phase, runtimeInstanceId = request.RuntimeInstanceId, previewId = request.PreviewId, authorizationId = request.AuthorizationId };
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.RuntimeInstanceId ?? "", "core-apply-v1", request.CorrelationId ?? "",
                request.AuthExpiresUnixSeconds, DynamicRuntimeV1Wire.CoreHash(core), request.RequestMac ?? "");
            var runtime = DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.RuntimeInstanceId ?? "");
            var seal = DynamicCoreOperationLaboratoryStateV1.TakeAuthorization(request.RuntimeInstanceId ?? "", request.PreviewId ?? "", request.AuthorizationId ?? "");
            var ledgerRoot = Environment.GetEnvironmentVariable("REVIT_OPERATOR_DYNAMIC_CORE_APPLY_REPLAY_DIRECTORY");
            if (string.IsNullOrWhiteSpace(ledgerRoot))
                ledgerRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitOperator", "DynamicRuntime", "core-apply-replay-v1");
            try
            {
                var ledger = new DurableCoreOperationApplyAuthorizationLedgerV1(ledgerRoot, seal.Authorization.ExpiresUnixSeconds);
                var receiptValue = DynamicCoreOperationHostV1.Apply(app, seal.Preview.Graph, seal.Preview.Budget, seal.Preview.Binding,
                    seal.Preview.Preview, seal.Authorization, ledger, runtime.Key, DateTimeOffset.UtcNow.ToUnixTimeSeconds(), seal.Preview.PlannedExecutionMilliseconds);
                var receipt = new
                {
                    schema = "dynamic-revit-core-apply-receipt-envelope/v1",
                    outcome = receiptValue.Outcome,
                    preview_id = seal.Preview.PreviewId,
                    authorization_id = seal.AuthorizationId,
                    graph_hash = seal.Preview.Graph.GraphHash,
                    effect_set_hash = receiptValue.EffectSetHash,
                    receipt_hash = receiptValue.ReceiptHash,
                    retry_permitted = false,
                    apply_receipt = DynamicRuntimeV1Wire.CamelElement(receiptValue)
                };
                return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(seal.Preview.RuntimeId, "core-apply-v1-receipt", receipt));
            }
            catch (Exception error)
            {
                var receipt = new
                {
                    schema = "dynamic-revit-core-apply-receipt-envelope/v1",
                    outcome = "failed_closed",
                    preview_id = seal.Preview.PreviewId,
                    authorization_id = seal.AuthorizationId,
                    graph_hash = seal.Preview.Graph.GraphHash,
                    failure = error.Message,
                    retry_permitted = false
                };
                return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(seal.Preview.RuntimeId, "core-apply-v1-receipt", receipt));
            }
        }
    }
}
