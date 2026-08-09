using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    internal static class DynamicResultReferenceFactAuthorityV1
    {
        internal static IReadOnlyDictionary<string, DynamicTrustedElementFactV1> Capture(
            UIApplication application, IEnumerable<string> uniqueIds, DynamicBuildingSystemsSnapshotSealV1 snapshot,
            DynamicBuildingSystemsSelectorV1 selector)
        {
            var document = application.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            var ids = (uniqueIds ?? throw new ArgumentNullException(nameof(uniqueIds))).ToArray();
            if (ids.Length > DynamicResultReferenceContractV1.MaximumReferencesPerNode || ids.Any(value => !BoundedId(value, 256)) ||
                ids.Distinct(StringComparer.Ordinal).Count() != ids.Length || ids.Any(value => !selector.ElementUniqueIds.Contains(value, StringComparer.Ordinal)))
                throw new ArgumentException("Result-reference fact request is invalid, duplicated, unbounded, or outside the sealed selector.");
            if (snapshot.DocumentFingerprint != DynamicRuntimeSnapshotHandler.Fingerprint(document) || snapshot.DocumentSessionId != DynamicRuntimeSnapshotHandler.Session(document))
                throw new InvalidOperationException("Result-reference fact request no longer binds the active document/session.");
            var result = new Dictionary<string, DynamicTrustedElementFactV1>(StringComparer.Ordinal);
            foreach (var uniqueId in ids.OrderBy(value => value, StringComparer.Ordinal))
            {
                var element = document.GetElement(uniqueId) ?? throw new InvalidOperationException("A result-reference target disappeared before fact capture.");
                if (!element.IsValidObject || IsHidden(application, element)) throw new InvalidOperationException("A result-reference target is invalid or hidden.");
                result.Add(uniqueId, new DynamicTrustedElementFactV1
                {
                    UniqueId = element.UniqueId,
                    ElementId = ElementIdCompat.GetValue(element.Id),
                    DocumentFingerprint = snapshot.DocumentFingerprint,
                    CategoryStableId = CategoryStableId(element.Category),
                    TypeUniqueId = TypeUniqueId(document, element),
                    StateHash = DynamicAnnotationRevitStateV1.StateHash(element),
                    Exists = true,
                    Verified = true,
                    Visible = true
                });
            }
            return result;
        }

        internal static string FactsHash(IEnumerable<DynamicTrustedElementFactV1> facts) => DynamicWire.Sha256(
            "dynamic-result-reference-trusted-facts/v1\n" + string.Join("\n", facts.OrderBy(value => value.UniqueId, StringComparer.Ordinal).Select(value =>
                CanonicalJoin(value.UniqueId, value.ElementId.ToString(CultureInfo.InvariantCulture), value.DocumentFingerprint,
                    value.CategoryStableId, value.TypeUniqueId, value.StateHash, value.Exists ? "1" : "0", value.Verified ? "1" : "0", value.Visible ? "1" : "0"))));

        private static bool BoundedId(string value, int maximum) => !string.IsNullOrWhiteSpace(value) && value.Length <= maximum && value.All(character => !char.IsControl(character));
        private static string CanonicalJoin(params string?[] values)
        {
            var builder = new StringBuilder();
            foreach (var value in values)
                if (value == null) builder.Append("-\n"); else builder.Append('+').Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(value))).Append('\n');
            return builder.ToString();
        }

        private static bool IsHidden(UIApplication application, Element element)
        {
            try { return element.IsHidden(application.ActiveUIDocument.ActiveView); }
            catch { return true; }
        }

        private static string TypeUniqueId(Document document, Element element)
        {
            var id = element.GetTypeId();
            return id == ElementId.InvalidElementId ? "type:none" : (document.GetElement(id)?.UniqueId ?? "type:missing");
        }

        private static string CategoryStableId(Category? category)
        {
            if (category == null) return "category:none";
            var id = ElementIdCompat.GetValue(category.Id);
            var builtIn = id < 0 && id >= int.MinValue ? Enum.GetName(typeof(BuiltInCategory), (int)id) : null;
            return builtIn == null ? "category:element:" + id.ToString(CultureInfo.InvariantCulture) : "category:builtin:" + builtIn;
        }
    }

    public sealed class DynamicResultReferenceFactsV1Handler : IRequestHandler
    {
        private sealed class Request
        {
            public string? Schema { get; set; }
            public string? RuntimeInstanceId { get; set; }
            public string? SnapshotId { get; set; }
            public DynamicBuildingSystemsSelectorV1? Selector { get; set; }
            public string[] TargetUniqueIds { get; set; } = Array.Empty<string>();
            public string? CorrelationId { get; set; }
            public long AuthExpiresUnixSeconds { get; set; }
            public string? RequestMac { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            DynamicRuntimeV1LaboratoryBoundary.Require();
            var request = DynamicRuntimeV1Wire.ParseExact<Request>(jsonData, "schema", "runtimeInstanceId", "snapshotId", "selector", "targetUniqueIds", "correlationId", "authExpiresUnixSeconds", "requestMac");
            if (request.Schema != "dynamic-revit-result-reference-facts-request/v1" || request.Selector == null)
                throw new ArgumentException("Result-reference fact request v1 is invalid.");
            DynamicBuildingSystemsObservationPolicyV1.ValidateSelector(request.Selector);
            var core = new { schema = request.Schema, runtimeInstanceId = request.RuntimeInstanceId, snapshotId = request.SnapshotId, selector = request.Selector, targetUniqueIds = request.TargetUniqueIds };
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.RuntimeInstanceId ?? "", "result-reference-facts-v1", request.CorrelationId ?? "",
                request.AuthExpiresUnixSeconds, DynamicRuntimeV1Wire.CoreHash(core), request.RequestMac ?? "");
            DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.RuntimeInstanceId ?? "");
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            var snapshot = DynamicBuildingSystemsSnapshotAuthorityV1.Require(request.RuntimeInstanceId ?? "", request.SnapshotId ?? "",
                DynamicRuntimeSnapshotHandler.Fingerprint(document), DynamicRuntimeSnapshotHandler.Session(document), request.Selector);
            DynamicBuildingSystemsSnapshotAuthorityV1.RequireUnchanged(snapshot.SnapshotId, document);
            var facts = DynamicResultReferenceFactAuthorityV1.Capture(app, request.TargetUniqueIds, snapshot, request.Selector).Values.ToArray();
            var receipt = new
            {
                schema = "dynamic-revit-result-reference-facts-receipt/v1",
                snapshot_id = snapshot.SnapshotId,
                snapshot_hash = snapshot.SnapshotHash,
                scope_hash = snapshot.ScopeHash,
                document_revision = snapshot.DocumentRevision,
                document_fingerprint = snapshot.DocumentFingerprint,
                document_session_id = snapshot.DocumentSessionId,
                result_reference_manifest_hash = DynamicResultReferenceManifestV1.ManifestHash,
                facts_hash = DynamicResultReferenceFactAuthorityV1.FactsHash(facts),
                authorization_granted = false,
                facts = DynamicRuntimeV1Wire.CamelElement(facts)
            };
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(request.RuntimeInstanceId ?? "", "result-reference-facts-v1-receipt", receipt));
        }
    }

    internal sealed class DynamicMepResultPreviewSealV1
    {
        internal string PreviewId = "";
        internal string RuntimeId = "";
        internal string SnapshotId = "";
        internal string SourceHash = "";
        internal string ProgramHash = "";
        internal string SdkHash = "";
        internal DynamicResultReferenceGraphV1 Graph = new DynamicResultReferenceGraphV1();
        internal DynamicEffectBudgetV1 Budget = new DynamicEffectBudgetV1();
        internal IReadOnlyDictionary<string, DynamicTrustedElementFactV1> AdmissionTargets = new Dictionary<string, DynamicTrustedElementFactV1>();
        internal DynamicMepMutationPreviewV1 Preview = new DynamicMepMutationPreviewV1();
        internal DateTime ExpiresUtc;
    }

    internal sealed class DynamicMepResultAuthorizationSealV1
    {
        internal string AuthorizationId = "";
        internal DynamicMepResultPreviewSealV1 Preview = new DynamicMepResultPreviewSealV1();
        internal DynamicMepMutationApplyAuthorizationV1 Authorization = new DynamicMepMutationApplyAuthorizationV1();
        internal DateTime ExpiresUtc;
    }

    internal static class DynamicMepResultLaboratoryStateV1
    {
        private static readonly ConcurrentDictionary<string, DynamicMepResultPreviewSealV1> Previews = new ConcurrentDictionary<string, DynamicMepResultPreviewSealV1>(StringComparer.Ordinal);
        private static readonly ConcurrentDictionary<string, DynamicMepResultAuthorizationSealV1> Authorizations = new ConcurrentDictionary<string, DynamicMepResultAuthorizationSealV1>(StringComparer.Ordinal);
        private static readonly object Gate = new object();

        internal static void Register(DynamicMepResultPreviewSealV1 value)
        {
            Prune();
            if (!Previews.TryAdd(value.PreviewId, value)) throw new InvalidOperationException("MEP result preview identity collided.");
        }

        internal static DynamicMepResultPreviewSealV1 Require(string runtimeId, string previewId, string previewHash)
        {
            Prune();
            if (!Previews.TryGetValue(previewId ?? "", out var value) || value.ExpiresUtc <= DateTime.UtcNow || value.RuntimeId != runtimeId || value.Preview.PreviewHash != previewHash)
                throw new InvalidOperationException("MEP result preview is unknown, expired, or substituted.");
            return value;
        }

        internal static DynamicMepResultAuthorizationSealV1 Authorize(DynamicMepResultPreviewSealV1 preview, DynamicMepMutationApplyAuthorizationV1 authorization)
        {
            Prune();
            var value = new DynamicMepResultAuthorizationSealV1 { AuthorizationId = authorization.AuthorizationId, Preview = preview, Authorization = authorization,
                ExpiresUtc = DateTimeOffset.FromUnixTimeSeconds(authorization.ExpiresUnixSeconds).UtcDateTime };
            lock (Gate)
            {
                if (Authorizations.Values.Any(item => item.ExpiresUtc > DateTime.UtcNow && item.Preview.PreviewId == preview.PreviewId))
                    throw new InvalidOperationException("MEP result preview already has a live apply authorization.");
                if (!Authorizations.TryAdd(value.AuthorizationId, value)) throw new InvalidOperationException("MEP result authorization identity collided.");
            }
            return value;
        }

        internal static DynamicMepResultAuthorizationSealV1 Take(string runtimeId, string previewId, string authorizationId)
        {
            Prune();
            if (!Authorizations.TryRemove(authorizationId ?? "", out var value) || value.ExpiresUtc <= DateTime.UtcNow || value.Preview.RuntimeId != runtimeId || value.Preview.PreviewId != previewId)
                throw new InvalidOperationException("MEP result authorization is unknown, expired, consumed, or substituted.");
            Previews.TryRemove(previewId ?? "", out _);
            return value;
        }

        private static void Prune()
        {
            foreach (var key in Previews.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray()) Previews.TryRemove(key, out _);
            foreach (var key in Authorizations.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray()) Authorizations.TryRemove(key, out _);
        }
    }

    public sealed class DynamicMepResultPreviewV1Handler : IRequestHandler
    {
        private sealed class Request
        {
            public string? Schema { get; set; }
            public string? RuntimeInstanceId { get; set; }
            public string? SnapshotId { get; set; }
            public DynamicBuildingSystemsSelectorV1? Selector { get; set; }
            public string[] ObservationEnvelopeHashes { get; set; } = Array.Empty<string>();
            public string? SourceHash { get; set; }
            public string? ProgramHash { get; set; }
            public string? SdkHash { get; set; }
            public DynamicResultReferenceGraphV1? Graph { get; set; }
            public DynamicEffectBudgetV1? EffectBudget { get; set; }
            public string? CorrelationId { get; set; }
            public long AuthExpiresUnixSeconds { get; set; }
            public string? RequestMac { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            DynamicRuntimeV1LaboratoryBoundary.Require();
            var request = DynamicRuntimeV1Wire.ParseExact<Request>(jsonData, "schema", "runtimeInstanceId", "snapshotId", "selector", "observationEnvelopeHashes", "sourceHash", "programHash", "sdkHash", "graph", "effectBudget", "correlationId", "authExpiresUnixSeconds", "requestMac");
            if (request.Schema != "dynamic-revit-mep-result-preview-request/v1" || request.Selector == null || request.Graph == null || request.EffectBudget == null)
                throw new ArgumentException("MEP result preview request v1 is invalid.");
            if (!DynamicRuntimePreviewHandler.IsHash(request.SourceHash) || !DynamicRuntimePreviewHandler.IsHash(request.ProgramHash) || !DynamicRuntimePreviewHandler.IsHash(request.SdkHash))
                throw new ArgumentException("MEP result preview source, program, or SDK identity is invalid.");
            var core = new { schema = request.Schema, runtimeInstanceId = request.RuntimeInstanceId, snapshotId = request.SnapshotId, selector = request.Selector,
                observationEnvelopeHashes = request.ObservationEnvelopeHashes, sourceHash = request.SourceHash, programHash = request.ProgramHash, sdkHash = request.SdkHash,
                graph = request.Graph, effectBudget = request.EffectBudget };
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.RuntimeInstanceId ?? "", "mep-result-preview-v1", request.CorrelationId ?? "",
                request.AuthExpiresUnixSeconds, DynamicRuntimeV1Wire.CoreHash(core), request.RequestMac ?? "");
            DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.RuntimeInstanceId ?? "");
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            var snapshot = DynamicBuildingSystemsSnapshotAuthorityV1.Require(request.RuntimeInstanceId ?? "", request.SnapshotId ?? "",
                DynamicRuntimeSnapshotHandler.Fingerprint(document), DynamicRuntimeSnapshotHandler.Session(document), request.Selector);
            DynamicBuildingSystemsSnapshotAuthorityV1.RequireUnchanged(snapshot.SnapshotId, document);
            DynamicBuildingSystemsSnapshotAuthorityV1.RequireCompleteEnvelopeSet(snapshot.SnapshotId, request.ObservationEnvelopeHashes);
            if (request.Graph.DocumentRevision != snapshot.DocumentRevision || request.Graph.DocumentFingerprint != snapshot.DocumentFingerprint || request.Graph.DocumentSessionId != snapshot.DocumentSessionId)
                throw new InvalidOperationException("MEP result graph is not bound to the exact sealed observation revision.");
            var targetIds = request.Graph.Nodes.SelectMany(node => node.ExternalTargets).Select(value => value.TargetUniqueId).Distinct(StringComparer.Ordinal).ToArray();
            var targets = DynamicResultReferenceFactAuthorityV1.Capture(app, targetIds, snapshot, request.Selector);
            var preview = DynamicMepResultReferenceMutationHostV1.Preview(app, request.Graph, request.EffectBudget, targets, snapshot.DocumentRevision);
            var seal = new DynamicMepResultPreviewSealV1 { PreviewId = "mepresultpreview_" + Guid.NewGuid().ToString("N"), RuntimeId = request.RuntimeInstanceId ?? "",
                SnapshotId = snapshot.SnapshotId, SourceHash = request.SourceHash ?? "", ProgramHash = request.ProgramHash ?? "", SdkHash = request.SdkHash ?? "",
                Graph = Clone(request.Graph), Budget = Clone(request.EffectBudget), AdmissionTargets = Clone(targets), Preview = preview, ExpiresUtc = DateTime.UtcNow.AddSeconds(110) };
            DynamicMepResultLaboratoryStateV1.Register(seal);
            var receipt = new { schema = "dynamic-revit-mep-result-preview-receipt/v1", preview_id = seal.PreviewId, preview_hash = preview.PreviewHash,
                graph_hash = request.Graph.GraphHash, effect_budget_hash = request.EffectBudget.CanonicalHash(), snapshot_id = snapshot.SnapshotId, snapshot_hash = snapshot.SnapshotHash,
                observation_envelope_hashes = request.ObservationEnvelopeHashes, facts_hash = DynamicResultReferenceFactAuthorityV1.FactsHash(targets.Values), source_hash = seal.SourceHash,
                program_hash = seal.ProgramHash, sdk_hash = seal.SdkHash, outcome = "preview_rolled_back_verified",
                authorization_granted = false, preview = DynamicRuntimeV1Wire.CamelElement(preview) };
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(seal.RuntimeId, "mep-result-preview-v1-receipt", receipt));
        }

        private static T Clone<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value, DynamicRuntimeV1Wire.Camel), DynamicRuntimeV1Wire.Camel)
            ?? throw new InvalidOperationException("MEP result preview state could not be sealed.");
        private static IReadOnlyDictionary<string, DynamicTrustedElementFactV1> Clone(IReadOnlyDictionary<string, DynamicTrustedElementFactV1> value) =>
            JsonSerializer.Deserialize<Dictionary<string, DynamicTrustedElementFactV1>>(JsonSerializer.Serialize(value, DynamicRuntimeV1Wire.Camel), DynamicRuntimeV1Wire.Camel)
            ?? throw new InvalidOperationException("MEP result target state could not be sealed.");
    }

    public sealed class DynamicMepResultAuthorizeV1Handler : IRequestHandler
    {
        private sealed class Request { public string? Schema { get; set; } public string? RuntimeInstanceId { get; set; } public string? PreviewId { get; set; } public string? PreviewHash { get; set; }
            public string? CorrelationId { get; set; } public long AuthExpiresUnixSeconds { get; set; } public string? RequestMac { get; set; } }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            DynamicRuntimeV1LaboratoryBoundary.Require();
            var request = DynamicRuntimeV1Wire.ParseExact<Request>(jsonData, "schema", "runtimeInstanceId", "previewId", "previewHash", "correlationId", "authExpiresUnixSeconds", "requestMac");
            if (request.Schema != "dynamic-revit-mep-result-authorize-request/v1") throw new ArgumentException("MEP result authorization request v1 is invalid.");
            var core = new { schema = request.Schema, runtimeInstanceId = request.RuntimeInstanceId, previewId = request.PreviewId, previewHash = request.PreviewHash };
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.RuntimeInstanceId ?? "", "mep-result-authorize-v1", request.CorrelationId ?? "", request.AuthExpiresUnixSeconds,
                DynamicRuntimeV1Wire.CoreHash(core), request.RequestMac ?? "");
            var runtime = DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.RuntimeInstanceId ?? "");
            var preview = DynamicMepResultLaboratoryStateV1.Require(request.RuntimeInstanceId ?? "", request.PreviewId ?? "", request.PreviewHash ?? "");
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            DynamicBuildingSystemsSnapshotAuthorityV1.RequireUnchanged(preview.SnapshotId, document);
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var authorization = DynamicMepMutationPolicyV1.IssueAuthorization(preview.Preview, preview.Budget, now, now + 90, runtime.Key, "mepresultauth_" + Guid.NewGuid().ToString("N"));
            DynamicMepResultLaboratoryStateV1.Authorize(preview, authorization);
            var receipt = new { schema = "dynamic-revit-mep-result-authorize-receipt/v1", preview_id = preview.PreviewId, preview_hash = preview.Preview.PreviewHash,
                authorization_id = authorization.AuthorizationId, authorization_hash = DynamicMepMutationPolicyV1.AuthorizationHash(authorization), expires_unix_seconds = authorization.ExpiresUnixSeconds,
                authorization_granted = true, authorization = DynamicRuntimeV1Wire.CamelElement(authorization) };
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(preview.RuntimeId, "mep-result-authorize-v1-receipt", receipt));
        }
    }

    public sealed class DynamicMepResultApplyV1Handler : IRequestHandler
    {
        private sealed class Request { public string? Schema { get; set; } public string? Phase { get; set; } public string? RuntimeInstanceId { get; set; }
            public string? PreviewId { get; set; } public string? AuthorizationId { get; set; } public string? CorrelationId { get; set; }
            public long AuthExpiresUnixSeconds { get; set; } public string? RequestMac { get; set; } }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            DynamicRuntimeV1LaboratoryBoundary.Require();
            var request = DynamicRuntimeV1Wire.ParseExact<Request>(jsonData, "schema", "phase", "runtimeInstanceId", "previewId", "authorizationId", "correlationId", "authExpiresUnixSeconds", "requestMac");
            if (request.Schema != "dynamic-revit-mep-result-apply-request/v1" || request.Phase != "apply") throw new ArgumentException("MEP result apply request v1 is invalid.");
            var core = new { schema = request.Schema, phase = request.Phase, runtimeInstanceId = request.RuntimeInstanceId, previewId = request.PreviewId, authorizationId = request.AuthorizationId };
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.RuntimeInstanceId ?? "", "mep-result-apply-v1", request.CorrelationId ?? "", request.AuthExpiresUnixSeconds,
                DynamicRuntimeV1Wire.CoreHash(core), request.RequestMac ?? "");
            var runtime = DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.RuntimeInstanceId ?? "");
            var seal = DynamicMepResultLaboratoryStateV1.Take(request.RuntimeInstanceId ?? "", request.PreviewId ?? "", request.AuthorizationId ?? "");
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            DynamicBuildingSystemsSnapshotAuthorityV1.RequireUnchanged(seal.Preview.SnapshotId, document);
            try
            {
                var ledgerRoot = Environment.GetEnvironmentVariable("REVIT_OPERATOR_DYNAMIC_RESULT_APPLY_REPLAY_DIRECTORY");
                if (string.IsNullOrWhiteSpace(ledgerRoot)) ledgerRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitOperator", "DynamicRuntime", "result-apply-replay-v1");
                var ledger = new DurableCoreOperationApplyAuthorizationLedgerV1(ledgerRoot, seal.Authorization.ExpiresUnixSeconds);
                var value = DynamicMepResultReferenceMutationHostV1.Apply(app, seal.Preview.Graph, seal.Preview.Budget, seal.Preview.AdmissionTargets,
                    seal.Preview.Preview, seal.Authorization, ledger, runtime.Key, DateTimeOffset.UtcNow.ToUnixTimeSeconds(), seal.Preview.Graph.DocumentRevision);
                var receipt = new { schema = "dynamic-revit-mep-result-apply-receipt-envelope/v1", outcome = value.Outcome, preview_id = seal.Preview.PreviewId,
                    authorization_id = seal.AuthorizationId, graph_hash = seal.Preview.Graph.GraphHash, source_hash = seal.Preview.SourceHash,
                    program_hash = seal.Preview.ProgramHash, sdk_hash = seal.Preview.SdkHash, receipt_hash = value.ReceiptHash, retry_permitted = false,
                    apply_receipt = DynamicRuntimeV1Wire.CamelElement(value) };
                return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(seal.Preview.RuntimeId, "mep-result-apply-v1-receipt", receipt));
            }
            catch (Exception error)
            {
                var receipt = new { schema = "dynamic-revit-mep-result-apply-receipt-envelope/v1", outcome = "failed_closed", preview_id = seal.Preview.PreviewId,
                    authorization_id = seal.AuthorizationId, graph_hash = seal.Preview.Graph.GraphHash, source_hash = seal.Preview.SourceHash,
                    program_hash = seal.Preview.ProgramHash, sdk_hash = seal.Preview.SdkHash, failure = error.Message, retry_permitted = false };
                return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(seal.Preview.RuntimeId, "mep-result-apply-v1-receipt", receipt));
            }
        }
    }
}
