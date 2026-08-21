using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    internal sealed class DynamicAnnotationResultPreviewSealV1
    {
        internal string PreviewId = ""; internal string RuntimeId = ""; internal string SnapshotId = "";
        internal string SourceHash = ""; internal string ProgramHash = ""; internal string SdkHash = "";
        internal DynamicResultReferenceGraphV1 Graph = new DynamicResultReferenceGraphV1();
        internal DynamicEffectBudgetV1 Budget = new DynamicEffectBudgetV1();
        internal IReadOnlyDictionary<string, DynamicTrustedElementFactV1> AdmissionTargets = new Dictionary<string, DynamicTrustedElementFactV1>();
        internal DynamicAnnotationActivatedPreviewV1 ActivatedPreview = new DynamicAnnotationActivatedPreviewV1();
        internal DateTime ExpiresUtc;
    }

    internal sealed class DynamicAnnotationResultAuthorizationSealV1
    {
        internal string AuthorizationId = ""; internal string AuthorizationHash = "";
        internal DynamicAnnotationResultPreviewSealV1 Preview = new DynamicAnnotationResultPreviewSealV1(); internal DateTime ExpiresUtc;
    }

    internal static class DynamicAnnotationResultLaboratoryStateV1
    {
        private static readonly ConcurrentDictionary<string, DynamicAnnotationResultPreviewSealV1> Previews = new ConcurrentDictionary<string, DynamicAnnotationResultPreviewSealV1>(StringComparer.Ordinal);
        private static readonly ConcurrentDictionary<string, DynamicAnnotationResultAuthorizationSealV1> Authorizations = new ConcurrentDictionary<string, DynamicAnnotationResultAuthorizationSealV1>(StringComparer.Ordinal);
        private static readonly object Gate = new object();

        internal static void Register(DynamicAnnotationResultPreviewSealV1 value) { Prune(); if (!Previews.TryAdd(value.PreviewId, value)) throw new InvalidOperationException("Annotation result preview identity collided."); }
        internal static DynamicAnnotationResultPreviewSealV1 Require(string runtimeId, string previewId, string previewHash)
        {
            Prune();
            if (!Previews.TryGetValue(previewId ?? "", out var value) || value.ExpiresUtc <= DateTime.UtcNow || value.RuntimeId != runtimeId || value.ActivatedPreview.Preview.PreviewHash != previewHash)
                throw new InvalidOperationException("Annotation result preview is unknown, expired, or substituted.");
            return value;
        }
        internal static DynamicAnnotationResultAuthorizationSealV1 Authorize(DynamicAnnotationResultPreviewSealV1 preview)
        {
            Prune(); var expires = DateTime.UtcNow.AddSeconds(90); var authorizationId = "annotationresultauth_" + Guid.NewGuid().ToString("N");
            var value = new DynamicAnnotationResultAuthorizationSealV1
            {
                AuthorizationId = authorizationId, Preview = preview, ExpiresUtc = expires,
                AuthorizationHash = DynamicWire.Sha256("dynamic-annotation-result-authorization/v1\n" + authorizationId + "\n" + preview.RuntimeId + "\n" + preview.PreviewId + "\n" + preview.ActivatedPreview.Preview.PreviewHash + "\n" + preview.Graph.GraphHash + "\n" + new DateTimeOffset(expires).ToUnixTimeSeconds())
            };
            lock (Gate)
            {
                if (Authorizations.Values.Any(item => item.ExpiresUtc > DateTime.UtcNow && item.Preview.PreviewId == preview.PreviewId))
                    throw new InvalidOperationException("Annotation result preview already has a live apply authorization.");
                if (!Authorizations.TryAdd(value.AuthorizationId, value)) throw new InvalidOperationException("Annotation result authorization identity collided.");
            }
            return value;
        }
        internal static DynamicAnnotationResultAuthorizationSealV1 Take(string runtimeId, string previewId, string authorizationId)
        {
            Prune();
            if (!Authorizations.TryRemove(authorizationId ?? "", out var value) || value.ExpiresUtc <= DateTime.UtcNow || value.Preview.RuntimeId != runtimeId || value.Preview.PreviewId != previewId)
                throw new InvalidOperationException("Annotation result authorization is unknown, expired, consumed, or substituted.");
            Previews.TryRemove(previewId ?? "", out _); return value;
        }
        private static void Prune()
        {
            foreach (var key in Previews.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray()) Previews.TryRemove(key, out _);
            foreach (var key in Authorizations.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray()) Authorizations.TryRemove(key, out _);
        }
    }

    public sealed class DynamicAnnotationResultPreviewV1Handler : IRequestHandler
    {
        private sealed class Request
        {
            public string? Schema { get; set; } public string? RuntimeInstanceId { get; set; } public string? SnapshotId { get; set; }
            public DynamicBuildingSystemsSelectorV1[] Selectors { get; set; } = Array.Empty<DynamicBuildingSystemsSelectorV1>(); public string[] ObservationEnvelopeHashes { get; set; } = Array.Empty<string>();
            public string? SourceHash { get; set; } public string? ProgramHash { get; set; } public string? SdkHash { get; set; }
            public DynamicResultReferenceGraphV1? Graph { get; set; } public DynamicEffectBudgetV1? EffectBudget { get; set; }
            public string? CorrelationId { get; set; } public long AuthExpiresUnixSeconds { get; set; } public string? RequestMac { get; set; }
        }
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            DynamicRuntimeV1LaboratoryBoundary.Require();
            var request = DynamicRuntimeV1Wire.ParseExact<Request>(jsonData, "schema", "runtimeInstanceId", "snapshotId", "selectors", "observationEnvelopeHashes", "sourceHash", "programHash", "sdkHash", "graph", "effectBudget", "correlationId", "authExpiresUnixSeconds", "requestMac");
            if (request.Schema != "dynamic-revit-annotation-result-preview-request/v1" || request.Selectors.Length is < 1 or > DynamicResultReferenceObservationSetV1.MaximumScopes || request.Graph == null || request.EffectBudget == null ||
                request.Graph.Nodes.Any(node => DynamicAnnotationOperationManifestV1.Find(node.Kind) == null)) throw new ArgumentException("Annotation result preview request v1 is invalid or mixed-family.");
            if (!DynamicRuntimePreviewHandler.IsHash(request.SourceHash) || !DynamicRuntimePreviewHandler.IsHash(request.ProgramHash) || !DynamicRuntimePreviewHandler.IsHash(request.SdkHash))
                throw new ArgumentException("Annotation result preview source, program, or SDK identity is invalid.");
            var core = new { schema = request.Schema, runtimeInstanceId = request.RuntimeInstanceId, snapshotId = request.SnapshotId, selectors = request.Selectors,
                observationEnvelopeHashes = request.ObservationEnvelopeHashes, sourceHash = request.SourceHash, programHash = request.ProgramHash, sdkHash = request.SdkHash, graph = request.Graph, effectBudget = request.EffectBudget };
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.RuntimeInstanceId ?? "", "annotation-result-preview-v1", request.CorrelationId ?? "", request.AuthExpiresUnixSeconds, DynamicRuntimeV1Wire.CoreHash(core), request.RequestMac ?? "");
            DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.RuntimeInstanceId ?? "");
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            var snapshot = DynamicRetainedBuildingSystemsSnapshotAuthorityV1.RequireScopeSet(request.RuntimeInstanceId ?? "", request.SnapshotId ?? "", DynamicRuntimeSnapshotHandler.Fingerprint(document), DynamicRuntimeSnapshotHandler.Session(document), request.Selectors);
            DynamicRetainedBuildingSystemsSnapshotAuthorityV1.RequireUnchanged(snapshot.SnapshotId, document);
            DynamicRetainedBuildingSystemsSnapshotAuthorityV1.RequireCompleteEnvelopeSet(snapshot.SnapshotId, request.Selectors.Select(DynamicBuildingSystemsObservationPolicyV1.ScopeHash), request.ObservationEnvelopeHashes);
            if (request.Graph.DocumentRevision != snapshot.DocumentRevision || request.Graph.DocumentFingerprint != snapshot.DocumentFingerprint || request.Graph.DocumentSessionId != snapshot.DocumentSessionId)
                throw new InvalidOperationException("Annotation result graph is not bound to the exact sealed observation revision.");
            var ids = request.Graph.Nodes.SelectMany(node => node.ExternalTargets).Select(value => value.TargetUniqueId).Distinct(StringComparer.Ordinal).ToArray();
            DynamicRetainedBuildingSystemsSnapshotAuthorityV1.RequireAuthorizedTargets(snapshot.SnapshotId, ids);
            var targets = DynamicResultReferenceFactAuthorityV1.Capture(app, ids, snapshot, request.Selectors);
            var activated = DynamicAnnotationResultReferenceMutationHostV1.Preview(app, request.Graph, request.EffectBudget, targets, snapshot.DocumentRevision);
            var seal = new DynamicAnnotationResultPreviewSealV1 { PreviewId = "annotationresultpreview_" + Guid.NewGuid().ToString("N"), RuntimeId = request.RuntimeInstanceId ?? "", SnapshotId = snapshot.SnapshotId,
                SourceHash = request.SourceHash ?? "", ProgramHash = request.ProgramHash ?? "", SdkHash = request.SdkHash ?? "", Graph = Clone(request.Graph), Budget = Clone(request.EffectBudget),
                AdmissionTargets = Clone(targets), ActivatedPreview = activated, ExpiresUtc = DateTime.UtcNow.AddSeconds(110) };
            DynamicAnnotationResultLaboratoryStateV1.Register(seal);
            var receipt = new { schema = "dynamic-revit-annotation-result-preview-receipt/v1", preview_id = seal.PreviewId, preview_hash = activated.Preview.PreviewHash,
                graph_hash = request.Graph.GraphHash, effect_budget_hash = request.EffectBudget.CanonicalHash(), snapshot_id = snapshot.SnapshotId, snapshot_hash = snapshot.SnapshotHash,
                observation_envelope_hashes = request.ObservationEnvelopeHashes, facts_hash = DynamicResultReferenceFactAuthorityV1.FactsHash(targets.Values), source_hash = seal.SourceHash,
                program_hash = seal.ProgramHash, sdk_hash = seal.SdkHash, semantic_set_hash = activated.SemanticSetHash, outcome = "preview_rolled_back_verified", authorization_granted = false,
                preview = DynamicRuntimeV1Wire.CamelElement(activated.Preview) };
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(seal.RuntimeId, "annotation-result-preview-v1-receipt", receipt));
        }
        private static T Clone<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value, DynamicRuntimeV1Wire.Camel), DynamicRuntimeV1Wire.Camel) ?? throw new InvalidOperationException("Annotation result state could not be sealed.");
        private static IReadOnlyDictionary<string, DynamicTrustedElementFactV1> Clone(IReadOnlyDictionary<string, DynamicTrustedElementFactV1> value) => JsonSerializer.Deserialize<Dictionary<string, DynamicTrustedElementFactV1>>(JsonSerializer.Serialize(value, DynamicRuntimeV1Wire.Camel), DynamicRuntimeV1Wire.Camel) ?? throw new InvalidOperationException("Annotation result targets could not be sealed.");
    }

    public sealed class DynamicAnnotationResultAuthorizeV1Handler : IRequestHandler
    {
        private sealed class Request { public string? Schema { get; set; } public string? RuntimeInstanceId { get; set; } public string? PreviewId { get; set; } public string? PreviewHash { get; set; } public string? CorrelationId { get; set; } public long AuthExpiresUnixSeconds { get; set; } public string? RequestMac { get; set; } }
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            DynamicRuntimeV1LaboratoryBoundary.Require();
            var request = DynamicRuntimeV1Wire.ParseExact<Request>(jsonData, "schema", "runtimeInstanceId", "previewId", "previewHash", "correlationId", "authExpiresUnixSeconds", "requestMac");
            if (request.Schema != "dynamic-revit-annotation-result-authorize-request/v1") throw new ArgumentException("Annotation result authorization request v1 is invalid.");
            var core = new { schema = request.Schema, runtimeInstanceId = request.RuntimeInstanceId, previewId = request.PreviewId, previewHash = request.PreviewHash };
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.RuntimeInstanceId ?? "", "annotation-result-authorize-v1", request.CorrelationId ?? "", request.AuthExpiresUnixSeconds, DynamicRuntimeV1Wire.CoreHash(core), request.RequestMac ?? "");
            DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.RuntimeInstanceId ?? "");
            var preview = DynamicAnnotationResultLaboratoryStateV1.Require(request.RuntimeInstanceId ?? "", request.PreviewId ?? "", request.PreviewHash ?? "");
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document."); DynamicRetainedBuildingSystemsSnapshotAuthorityV1.RequireUnchanged(preview.SnapshotId, document);
            var authorization = DynamicAnnotationResultLaboratoryStateV1.Authorize(preview);
            var receipt = new { schema = "dynamic-revit-annotation-result-authorize-receipt/v1", preview_id = preview.PreviewId, preview_hash = preview.ActivatedPreview.Preview.PreviewHash,
                authorization_id = authorization.AuthorizationId, authorization_hash = authorization.AuthorizationHash, expires_unix_seconds = new DateTimeOffset(authorization.ExpiresUtc).ToUnixTimeSeconds(), authorization_granted = true };
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(preview.RuntimeId, "annotation-result-authorize-v1-receipt", receipt));
        }
    }

    public sealed class DynamicAnnotationResultApplyV1Handler : IRequestHandler
    {
        private sealed class Request { public string? Schema { get; set; } public string? Phase { get; set; } public string? RuntimeInstanceId { get; set; } public string? PreviewId { get; set; } public string? AuthorizationId { get; set; } public string? CorrelationId { get; set; } public long AuthExpiresUnixSeconds { get; set; } public string? RequestMac { get; set; } }
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            DynamicRuntimeV1LaboratoryBoundary.Require();
            var request = DynamicRuntimeV1Wire.ParseExact<Request>(jsonData, "schema", "phase", "runtimeInstanceId", "previewId", "authorizationId", "correlationId", "authExpiresUnixSeconds", "requestMac");
            if (request.Schema != "dynamic-revit-annotation-result-apply-request/v1" || request.Phase != "apply") throw new ArgumentException("Annotation result apply request v1 is invalid.");
            var core = new { schema = request.Schema, phase = request.Phase, runtimeInstanceId = request.RuntimeInstanceId, previewId = request.PreviewId, authorizationId = request.AuthorizationId };
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.RuntimeInstanceId ?? "", "annotation-result-apply-v1", request.CorrelationId ?? "", request.AuthExpiresUnixSeconds, DynamicRuntimeV1Wire.CoreHash(core), request.RequestMac ?? "");
            DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.RuntimeInstanceId ?? "");
            var seal = DynamicAnnotationResultLaboratoryStateV1.Take(request.RuntimeInstanceId ?? "", request.PreviewId ?? "", request.AuthorizationId ?? "");
            try
            {
                var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document."); DynamicRetainedBuildingSystemsSnapshotAuthorityV1.RequireUnchanged(seal.Preview.SnapshotId, document);
                var ledgerRoot = Environment.GetEnvironmentVariable("REVIT_OPERATOR_DYNAMIC_RESULT_APPLY_REPLAY_DIRECTORY");
                if (string.IsNullOrWhiteSpace(ledgerRoot)) ledgerRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitOperator", "DynamicRuntime", "result-apply-replay-v1");
                var ledger = new DurableCoreOperationApplyAuthorizationLedgerV1(ledgerRoot, new DateTimeOffset(seal.ExpiresUtc).ToUnixTimeSeconds());
                if (!ledger.TryConsume(seal.AuthorizationHash)) throw new InvalidOperationException("Annotation result apply authorization was replayed.");
                var value = DynamicAnnotationResultReferenceMutationHostV1.Apply(app, seal.Preview.Graph, seal.Preview.Budget, seal.Preview.AdmissionTargets,
                    seal.Preview.ActivatedPreview, seal.AuthorizationHash, seal.Preview.Graph.DocumentRevision);
                var receipt = new { schema = "dynamic-revit-annotation-result-apply-receipt-envelope/v1", outcome = value.Outcome, preview_id = seal.Preview.PreviewId,
                    authorization_id = seal.AuthorizationId, graph_hash = seal.Preview.Graph.GraphHash, source_hash = seal.Preview.SourceHash, program_hash = seal.Preview.ProgramHash,
                    sdk_hash = seal.Preview.SdkHash, receipt_hash = value.ReceiptHash, retry_permitted = false, apply_receipt = DynamicRuntimeV1Wire.CamelElement(value) };
                return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(seal.Preview.RuntimeId, "annotation-result-apply-v1-receipt", receipt));
            }
            catch (Exception error)
            {
                var receipt = new { schema = "dynamic-revit-annotation-result-apply-receipt-envelope/v1", outcome = "failed_closed", preview_id = seal.Preview.PreviewId,
                    authorization_id = seal.AuthorizationId, graph_hash = seal.Preview.Graph.GraphHash, source_hash = seal.Preview.SourceHash, program_hash = seal.Preview.ProgramHash,
                    sdk_hash = seal.Preview.SdkHash, failure = error.Message, retry_permitted = false };
                return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(seal.Preview.RuntimeId, "annotation-result-apply-v1-receipt", receipt));
            }
        }
    }
}
