using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    internal sealed class DynamicRuntimePreviewSeal
    {
        public string PreviewId = ""; public string PreviewReceiptHash = ""; public string RuntimeId = ""; public string SourceHash = "";
        public string ProgramHash = ""; public DynamicOperationGraph Graph = new DynamicOperationGraph(); public string DocumentFingerprint = "";
        public string DocumentSessionId = ""; public long DocumentRevision; public DateTime ExpiresUtc;
        public Dictionary<string, string> TargetStateHashes = new Dictionary<string, string>(StringComparer.Ordinal);
        public HashSet<long> ProjectedChangedElementIds = new HashSet<long>();
    }

    internal sealed class DynamicRuntimeApplyAuthorization
    {
        public string AuthorizationId = ""; public DynamicRuntimePreviewSeal Preview = new DynamicRuntimePreviewSeal();
        public DynamicEffectBudgetV1 Budget = new DynamicEffectBudgetV1(); public DynamicProgramAdmissionExpectationsV1 Expectations = new DynamicProgramAdmissionExpectationsV1();
        public DateTime ExpiresUtc; public bool Consumed;
    }

    internal static class DynamicRuntimeApplyState
    {
        private static readonly ConcurrentDictionary<string, DynamicRuntimePreviewSeal> Previews = new ConcurrentDictionary<string, DynamicRuntimePreviewSeal>(StringComparer.Ordinal);
        private static readonly ConcurrentDictionary<string, DynamicRuntimeApplyAuthorization> Authorizations = new ConcurrentDictionary<string, DynamicRuntimeApplyAuthorization>(StringComparer.Ordinal);
        private static readonly object Gate = new object();

        public static void RegisterPreview(string previewId, string receiptHash, string runtimeId, string sourceHash, string programHash, DynamicOperationGraph graph, Document document, IEnumerable<long> projectedChangedElementIds)
        {
            if (!DynamicRuntimePreviewHandler.IsHash(receiptHash) || graph == null || document == null || projectedChangedElementIds == null) throw new ArgumentException("Dynamic preview seal is invalid.");
            var clone = JsonSerializer.Deserialize<DynamicOperationGraph>(JsonSerializer.Serialize(graph)) ?? throw new InvalidOperationException("Dynamic preview graph could not be sealed.");
            var projected = new HashSet<long>(projectedChangedElementIds);
            var targetHashes = clone.Operations.Select(operation => operation.TargetUniqueId).Distinct(StringComparer.Ordinal).ToDictionary(id => id,
                id => DynamicRuntimePreviewHandler.TrustedElementStateHash(document.GetElement(id) ?? throw new InvalidOperationException("Preview target disappeared before sealing.")), StringComparer.Ordinal);
            Previews[previewId] = new DynamicRuntimePreviewSeal
            {
                PreviewId = previewId, PreviewReceiptHash = receiptHash, RuntimeId = runtimeId, SourceHash = sourceHash, ProgramHash = programHash,
                Graph = clone, DocumentFingerprint = DynamicRuntimeSnapshotHandler.Fingerprint(document), DocumentSessionId = DynamicRuntimeSnapshotHandler.Session(document),
                DocumentRevision = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), TargetStateHashes = targetHashes,
                ProjectedChangedElementIds = projected, ExpiresUtc = DateTime.UtcNow.AddMinutes(2)
            };
            Prune();
        }

        public static DynamicRuntimeApplyAuthorization Authorize(UIApplication app, string runtimeId, string previewId, string previewReceiptHash, int maximumExecutionMilliseconds)
        {
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            if (!Previews.TryGetValue(previewId ?? "", out var preview) || preview.ExpiresUtc <= DateTime.UtcNow || preview.RuntimeId != runtimeId ||
                preview.PreviewReceiptHash != previewReceiptHash) throw new InvalidOperationException("Dynamic preview seal is unknown, expired, or substituted.");
            RequireCurrentState(document, preview);
            if (maximumExecutionMilliseconds < 100 || maximumExecutionMilliseconds > 5000) throw new ArgumentException("Dynamic apply deadline must be 100 through 5000 ms.");
            var runtime = DynamicRuntimeAdmissionRegistry.RequireV1Identity(runtimeId);
            var operations = preview.Graph.Operations;
            var targets = operations.Select(operation => operation.TargetUniqueId).Distinct(StringComparer.Ordinal).ToArray();
            var elements = targets.Select(id => document.GetElement(id) ?? throw new InvalidOperationException("Dynamic target disappeared before authorization.")).ToArray();
            var emptyFiles = new DynamicFileCapabilitySetV1().CanonicalHash();
            var budget = new DynamicEffectBudgetV1
            {
                BudgetId = "budget_" + Guid.NewGuid().ToString("N"), TargetDocumentFingerprints = new[] { preview.DocumentFingerprint },
                AllowedCategories = elements.Select(element => element.Category?.Name ?? "(uncategorized)").Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray(),
                ExplicitTargetUniqueIds = targets.OrderBy(value => value, StringComparer.Ordinal).ToArray(),
                AllowedSdkDomains = operations.Select(operation => operation.Kind == "set_parameter" ? "parameters" : "elements").Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray(),
                AllowedExternalEffectClasses = Array.Empty<string>(), ViewScopeHash = ViewScopeHash(app), LevelScopeHash = ElementScopeHash("level", elements, element => ElementIdCompat.GetValue(element.LevelId)),
                WorksetScopeHash = ElementScopeHash("workset", elements, element => element.WorksetId.IntegerValue), PhaseScopeHash = PhaseScopeHash(elements),
                MaximumOperationCount = operations.Count, MaximumAffectedElements = Math.Max(targets.Length, preview.ProjectedChangedElementIds.Count), MaximumCreates = 0, MaximumModifications = operations.Count, MaximumDeletes = 0,
                MaximumExecutionMilliseconds = maximumExecutionMilliseconds, MaximumRegenerations = operations.Count, MaximumOutputCount = 0, MaximumOutputBytes = 0,
                FileCapabilitySetHash = emptyFiles
            };
            var budgetHash = budget.CanonicalHash();
            var finalAuthorizationHash = DynamicWire.Sha256(Convert.ToBase64String(RandomBytes(32)));
            var targetYear = app.Application.VersionNumber;
            var expectations = new DynamicProgramAdmissionExpectationsV1
            {
                NormalizedSourceHash = preview.SourceHash, CompiledArtifactHash = preview.ProgramHash, CompilerRuntimeHash = runtime.CompilerRuntimeHash,
                SdkVersion = DynamicRevitSdkProductionVersion.Value, SdkManifestHash = DynamicRevitSdkProductionVersion.ManifestHash, SdkArtifactHash = runtime.SdkArtifactHash,
                WorkerExecutableHash = runtime.WorkerExecutableHash, WorkerRuntimePackageHash = runtime.WorkerRuntimePackageHash, SandboxProfileVersion = runtime.SandboxProfile,
                SandboxProfileHash = DynamicWire.Sha256(runtime.SandboxProfile), AuthenticatedWorkerIdentityHash = runtime.AuthenticatedWorkerIdentityHash,
                TargetRevitVersion = targetYear, HostAdapterManifestHash = HostAdapterManifestHash(targetYear), DocumentFingerprint = preview.DocumentFingerprint,
                DocumentSessionId = preview.DocumentSessionId, DocumentRevision = preview.DocumentRevision, ProjectContextIdentityHash = DynamicWire.Sha256("local-lab\n" + preview.DocumentFingerprint),
                CapabilityEnvelopeHash = DynamicWire.Sha256("move_element\nset_parameter"), OperationFamilyEnvelopeHash = DynamicWire.Sha256("dynamic-local-lab/v1\nmove_element\nset_parameter"),
                EffectBudgetHash = budgetHash, FileCapabilitySetHash = emptyFiles, OperationGraphHash = preview.Graph.GraphHash, PreviewReceiptHash = preview.PreviewReceiptHash,
                PolicyIdentityHash = DynamicWire.Sha256("dynamic-local-lab-policy/v1"), RuntimeIdentityHash = DynamicWire.Sha256(runtime.LauncherHash + "\n" + runtime.WorkerRuntimePackageHash + "\n" + runtime.WorkerExecutableHash + "\n" + runtime.CompilerRuntimeHash + "\n" + runtime.SdkArtifactHash + "\n" + runtime.SandboxProfile),
                RequestFamilySealHash = DynamicWire.Sha256("dynamic-local-lab-apply-family/v1"), FinalAuthorizationHash = finalAuthorizationHash,
                PrincipalIdHash = DynamicWire.Sha256("local-laboratory-operator"), PrincipalSessionHash = DynamicWire.Sha256("local-laboratory-operator\n" + preview.DocumentSessionId)
            };
            var authorization = new DynamicRuntimeApplyAuthorization
            {
                AuthorizationId = "applyauth_" + Guid.NewGuid().ToString("N"), Preview = preview, Budget = budget, Expectations = expectations,
                ExpiresUtc = DateTime.UtcNow.AddSeconds(90)
            };
            lock (Gate)
            {
                if (Authorizations.Values.Any(value => !value.Consumed && value.ExpiresUtc > DateTime.UtcNow && value.Preview.PreviewId == previewId))
                    throw new InvalidOperationException("Dynamic preview already has a live apply authorization.");
                Authorizations[authorization.AuthorizationId] = authorization;
            }
            Prune(); return authorization;
        }

        public static DynamicRuntimeApplyAuthorization RequireAuthorization(string authorizationId, string runtimeId, string previewId)
        {
            if (!Authorizations.TryGetValue(authorizationId ?? "", out var authorization) || authorization.ExpiresUtc <= DateTime.UtcNow || authorization.Consumed ||
                authorization.Preview.RuntimeId != runtimeId || authorization.Preview.PreviewId != previewId)
                throw new InvalidOperationException("Dynamic apply authorization is unknown, expired, consumed, or substituted.");
            return authorization;
        }

        public static void ConsumeAuthorization(DynamicRuntimeApplyAuthorization authorization)
        {
            lock (Gate)
            {
                if (authorization.Consumed || authorization.ExpiresUtc <= DateTime.UtcNow) throw new InvalidOperationException("Dynamic apply authorization was replayed or expired.");
                authorization.Consumed = true;
                Previews.TryRemove(authorization.Preview.PreviewId, out _);
            }
        }

        public static void RequireCurrentState(Document document, DynamicRuntimePreviewSeal preview)
        {
            if (DynamicRuntimeSnapshotHandler.Fingerprint(document) != preview.DocumentFingerprint || DynamicRuntimeSnapshotHandler.Session(document) != preview.DocumentSessionId)
                throw new InvalidOperationException("Dynamic apply document identity changed after preview.");
            foreach (var pair in preview.TargetStateHashes)
            {
                var element = document.GetElement(pair.Key) ?? throw new InvalidOperationException("Dynamic apply target disappeared after preview: " + pair.Key);
                if (DynamicRuntimePreviewHandler.TrustedElementStateHash(element) != pair.Value) throw new InvalidOperationException("Dynamic apply target state changed after preview: " + pair.Key);
            }
        }

        internal static string ViewScopeHash(UIApplication app) => DynamicWire.Sha256("view\n" + ElementIdCompat.GetValue(app.ActiveUIDocument.ActiveView.Id).ToString(CultureInfo.InvariantCulture));
        internal static string ElementScopeHash(string label, IEnumerable<Element> elements, Func<Element, long> selector) =>
            DynamicWire.Sha256(label + "\n" + string.Join("\n", elements.Select(selector).Distinct().OrderBy(value => value).Select(value => value.ToString(CultureInfo.InvariantCulture))));
        internal static string PhaseScopeHash(IEnumerable<Element> elements) => DynamicWire.Sha256("phase\n" + string.Join("\n", elements.SelectMany(element => new[]
        {
            SafePhase(element, BuiltInParameter.PHASE_CREATED), SafePhase(element, BuiltInParameter.PHASE_DEMOLISHED)
        }).Distinct().OrderBy(value => value).Select(value => value.ToString(CultureInfo.InvariantCulture))));
        internal static string HostAdapterManifestHash(string year) => DynamicWire.Sha256("dynamic-revit-host-adapter/v1\n" + year + "\nmove_element\nset_parameter");
        private static long SafePhase(Element element, BuiltInParameter parameter) { try { return ElementIdCompat.GetValue(element.get_Parameter(parameter)?.AsElementId() ?? ElementId.InvalidElementId); } catch { return -1; } }
        private static byte[] RandomBytes(int count) { var bytes = new byte[count]; using var random = RandomNumberGenerator.Create(); random.GetBytes(bytes); return bytes; }
        private static void Prune()
        {
            foreach (var key in Previews.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray()) Previews.TryRemove(key, out _);
            foreach (var key in Authorizations.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray()) Authorizations.TryRemove(key, out _);
        }
    }

    public sealed class DynamicRuntimeApplyAuthorizationHandler : IRequestHandler
    {
        private sealed class Request
        {
            public string? schema { get; set; } public string? runtimeInstanceId { get; set; } public string? previewId { get; set; }
            public string? previewReceiptHash { get; set; } public int maximumExecutionMilliseconds { get; set; }
            public string? correlationId { get; set; } public long authExpiresUnixSeconds { get; set; } public string? requestMac { get; set; }
        }
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            ExactShape(jsonData, "schema", "runtimeInstanceId", "previewId", "previewReceiptHash", "maximumExecutionMilliseconds", "correlationId", "authExpiresUnixSeconds", "requestMac");
            var request = JsonSerializer.Deserialize<Request>(jsonData) ?? throw new ArgumentException("Dynamic apply authorization request is invalid.");
            if (request.schema != "dynamic-revit-apply-authorization-request/v1") throw new ArgumentException("Dynamic apply authorization schema is unsupported.");
            var core = JsonSerializer.Serialize(new { schema = request.schema, runtimeInstanceId = request.runtimeInstanceId, previewId = request.previewId, previewReceiptHash = request.previewReceiptHash, maximumExecutionMilliseconds = request.maximumExecutionMilliseconds });
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.runtimeInstanceId ?? "", "authorize-apply", request.correlationId ?? "", request.authExpiresUnixSeconds, DynamicWire.Sha256(core), request.requestMac ?? "");
            var authorization = DynamicRuntimeApplyState.Authorize(app, request.runtimeInstanceId ?? "", request.previewId ?? "", request.previewReceiptHash ?? "", request.maximumExecutionMilliseconds);
            var receipt = new
            {
                schema = "dynamic-revit-apply-authorization-receipt/v1", authorization_id = authorization.AuthorizationId,
                preview_id = authorization.Preview.PreviewId, preview_receipt_hash = authorization.Preview.PreviewReceiptHash,
                expires_unix_seconds = new DateTimeOffset(authorization.ExpiresUtc).ToUnixTimeSeconds(), effect_budget = authorization.Budget,
                admission_expectations = authorization.Expectations, authorization_granted = true
            };
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(request.runtimeInstanceId ?? "", "authorize-apply-receipt", receipt));
        }
        internal static void ExactShape(string json, params string[] fields)
        {
            using var document = JsonDocument.Parse(json); var names = document.RootElement.ValueKind == JsonValueKind.Object ? document.RootElement.EnumerateObject().Select(property => property.Name).ToArray() : Array.Empty<string>();
            if (names.Length != fields.Length || names.Distinct(StringComparer.Ordinal).Count() != names.Length || names.Any(name => !fields.Contains(name, StringComparer.Ordinal))) throw new ArgumentException("Dynamic runtime request has an invalid field set.");
        }
    }

    internal static class DynamicAdmissionReplayLedger
    {
        public static bool TryConsume(string replayKey, long expiresUnixSeconds)
        {
            if (!DynamicRuntimePreviewHandler.IsHash(replayKey)) throw new ArgumentException("Dynamic admission replay key is invalid.");
            var root = Environment.GetEnvironmentVariable("REVIT_OPERATOR_DYNAMIC_REPLAY_DIRECTORY");
            if (string.IsNullOrWhiteSpace(root)) root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitOperator", "DynamicRuntime", "admission-replay-v1");
            return DurableAdmissionReplayLedgerV1.TryConsume(root, replayKey, expiresUnixSeconds);
        }
    }

    public sealed class DynamicRuntimeApplyHandler : IRequestHandler
    {
        private sealed class Request
        {
            public string? schema { get; set; } public string? phase { get; set; } public string? runtime_instance_id { get; set; }
            public string? preview_id { get; set; } public string? authorization_id { get; set; } public DynamicOperationGraph? graph { get; set; }
            public DynamicEffectBudgetV1? effect_budget { get; set; } public DynamicProgramAdmissionV1? admission { get; set; }
        }
        private sealed class Before { public XYZ? Point; public string? Value; }
        private static readonly JsonSerializerOptions SnakeJson = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower, PropertyNameCaseInsensitive = false };

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var stopwatch = Stopwatch.StartNew();
            DynamicRuntimeApplyAuthorizationHandler.ExactShape(jsonData, "schema", "phase", "runtime_instance_id", "preview_id", "authorization_id", "graph", "effect_budget", "admission");
            var request = JsonSerializer.Deserialize<Request>(jsonData, SnakeJson) ?? throw new ArgumentException("Dynamic apply request is invalid.");
            if (request.schema != "dynamic-revit-apply-request/v1" || request.phase != "apply" || request.graph == null || request.effect_budget == null || request.admission == null)
                throw new ArgumentException("Dynamic apply request v1 is invalid.");
            ValidateAdmissionShape(jsonData);
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            var authorization = DynamicRuntimeApplyState.RequireAuthorization(request.authorization_id ?? "", request.runtime_instance_id ?? "", request.preview_id ?? "");
            DynamicRuntimeApplyState.RequireCurrentState(document, authorization.Preview);
            // GraphHash is the canonical, signed semantic identity and is revalidated
            // against every operation below. Serializer bytes differ across the camel
            // preview and snake_case apply envelopes even when the graph is identical.
            if (request.graph.GraphHash != authorization.Preview.Graph.GraphHash)
                throw new InvalidOperationException("Dynamic apply graph changed after preview.");
            if (request.effect_budget.CanonicalHash() != authorization.Expectations.EffectBudgetHash) throw new InvalidOperationException("Dynamic apply effect budget changed after authorization.");
            ValidateBudgetedGraph(app, document, request.graph, request.effect_budget, authorization.Preview.DocumentRevision);
            var runtime = DynamicRuntimeAdmissionRegistry.RequireV1Identity(request.runtime_instance_id ?? "");
            DynamicProgramAdmissionV1Policy.ValidateAndConsume(request.admission, authorization.Expectations, runtime.Key, DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                replayKey => DynamicAdmissionReplayLedger.TryConsume(replayKey, request.admission.ExpiresUnixSeconds));
            DynamicRuntimeApplyState.ConsumeAuthorization(authorization);

            var changed = new HashSet<long>(); EventHandler<DocumentChangedEventArgs>? changedHandler = (sender, args) =>
            {
                if (DynamicRuntimeSnapshotHandler.Fingerprint(args.GetDocument()) != authorization.Preview.DocumentFingerprint) return;
                foreach (var id in args.GetAddedElementIds().Concat(args.GetModifiedElementIds()).Concat(args.GetDeletedElementIds())) changed.Add(ElementIdCompat.GetValue(id));
            };
            var results = new List<object>(); var beforeStates = new Dictionary<string, Before>(StringComparer.Ordinal); TransactionGroup? group = null; var committed = false;
            try
            {
                group = new TransactionGroup(document, "Authorized Dynamic Revit Apply");
                if (group.Start() != TransactionStatus.Started) throw new InvalidOperationException("Unable to start dynamic apply transaction group.");
                app.Application.DocumentChanged += changedHandler;
                foreach (var operation in request.graph.Operations)
                {
                    RequireDeadline(stopwatch, request.effect_budget.MaximumExecutionMilliseconds);
                    var element = document.GetElement(operation.TargetUniqueId) ?? throw new InvalidOperationException("Dynamic apply target disappeared: " + operation.TargetUniqueId);
                    if (element.Pinned || element.GroupId != ElementId.InvalidElementId) throw new InvalidOperationException("Pinned or grouped target is not eligible for dynamic apply.");
                    var before = CaptureBefore(element, operation);
                    beforeStates[operation.OperationId] = before;
                    using (var transaction = new Transaction(document, "Dynamic apply " + operation.Kind))
                    {
                        if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Unable to start dynamic apply operation.");
                        try { Apply(document, element, operation); if (transaction.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Dynamic apply operation did not commit."); }
                        finally { if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack(); }
                    }
                    VerifyReadback(element, operation, before);
                    results.Add(Readback(element, operation, before));
                }
                app.Application.DocumentChanged -= changedHandler; changedHandler = null;
                if (changed.Count > request.effect_budget.MaximumAffectedElements) throw new InvalidOperationException("Dynamic apply changed-element budget was exceeded.");
                if (!changed.SetEquals(authorization.Preview.ProjectedChangedElementIds)) throw new InvalidOperationException("Dynamic apply blast radius differed from the authorized preview.");
                RequireDeadline(stopwatch, request.effect_budget.MaximumExecutionMilliseconds);
                if (group.Assimilate() != TransactionStatus.Committed) throw new InvalidOperationException("Dynamic apply transaction group did not commit.");
                committed = true;
                foreach (var operation in request.graph.Operations.GroupBy(operation => operation.TargetUniqueId + "\n" + operation.Kind + "\n" + (operation.Parameter ?? ""), StringComparer.Ordinal).Select(grouping => grouping.Last()))
                    VerifyReadback(document.GetElement(operation.TargetUniqueId) ?? throw new InvalidOperationException("Applied target disappeared."), operation, beforeStates[operation.OperationId]);
                var receipt = new
                {
                    schema = "dynamic-revit-apply-receipt/v1", outcome = "committed_verified", admission_id = request.admission.AdmissionId,
                    preview_id = authorization.Preview.PreviewId, preview_receipt_hash = authorization.Preview.PreviewReceiptHash,
                    final_authorization_hash = authorization.Expectations.FinalAuthorizationHash, graph_hash = request.graph.GraphHash,
                    effect_budget_hash = authorization.Expectations.EffectBudgetHash, document_fingerprint = authorization.Preview.DocumentFingerprint,
                    document_session_id = authorization.Preview.DocumentSessionId, changed_element_ids = changed.OrderBy(value => value).ToArray(),
                    operation_results = results, elapsed_milliseconds = stopwatch.ElapsedMilliseconds, retry_permitted = false
                };
                PersistReceipt(request.admission.AdmissionId, receipt);
                return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(request.runtime_instance_id ?? "", "apply-receipt", receipt));
            }
            catch (Exception error)
            {
                var rolledBack = group == null || group.GetStatus() == TransactionStatus.Uninitialized;
                if (!committed && group != null)
                {
                    try { rolledBack = group.GetStatus() == TransactionStatus.RolledBack || (group.GetStatus() == TransactionStatus.Started && group.RollBack() == TransactionStatus.RolledBack); } catch { rolledBack = false; }
                }
                var outcome = committed || !rolledBack ? "outcome_uncertain" : "rolled_back";
                var receipt = new { schema = "dynamic-revit-apply-receipt/v1", outcome, admission_id = request.admission.AdmissionId, failure = error.Message, retry_permitted = false, elapsed_milliseconds = stopwatch.ElapsedMilliseconds };
                try { PersistReceipt(request.admission.AdmissionId, receipt); } catch { }
                return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(request.runtime_instance_id ?? "", "apply-receipt", receipt));
            }
            finally { if (changedHandler != null) app.Application.DocumentChanged -= changedHandler; group?.Dispose(); }
        }

        private static void ValidateBudgetedGraph(UIApplication app, Document document, DynamicOperationGraph graph, DynamicEffectBudgetV1 budget, long revision)
        {
            DynamicOperationGraphAdmission.Validate(graph, budget.MaximumOperationCount, budget.MaximumModifications);
            var nodes = new List<DynamicOperationNodeV1>(); string? prior = null;
            foreach (var operation in graph.Operations)
            {
                var attributes = new Dictionary<string, string>(StringComparer.Ordinal);
                if (operation.Kind == "move_element") attributes["vector_feet"] = string.Join(",", operation.VectorFeet!.Select(value => value.ToString("R", CultureInfo.InvariantCulture)));
                else { attributes["parameter_identity"] = operation.Parameter!; attributes["value"] = operation.Value!; attributes["value_kind"] = "string"; }
                var node = new DynamicOperationNodeV1 { Kind = operation.Kind, TargetUniqueIds = new[] { operation.TargetUniqueId }, DependsOn = prior == null ? Array.Empty<string>() : new[] { prior }, Attributes = attributes };
                node.NodeId = DynamicOperationGraphV1Admission.NodeId(node); prior = node.NodeId; nodes.Add(node);
            }
            var translated = new DynamicOperationGraphV1 { InputHash = graph.InputHash, DocumentFingerprint = DynamicRuntimeSnapshotHandler.Fingerprint(document), DocumentRevision = revision, Nodes = nodes };
            translated.GraphHash = DynamicOperationGraphV1Admission.GraphHash(translated);
            var elements = graph.Operations.Select(operation => document.GetElement(operation.TargetUniqueId) ?? throw new InvalidOperationException("Dynamic target disappeared.")).ToArray();
            var context = new DynamicOperationGraphV1Admission.TrustedValidationContext
            {
                TargetCategories = elements.ToDictionary(element => element.UniqueId, element => element.Category?.Name ?? "(uncategorized)", StringComparer.Ordinal),
                ViewScopeHash = DynamicRuntimeApplyState.ViewScopeHash(app), LevelScopeHash = DynamicRuntimeApplyState.ElementScopeHash("level", elements, element => ElementIdCompat.GetValue(element.LevelId)),
                WorksetScopeHash = DynamicRuntimeApplyState.ElementScopeHash("workset", elements, element => element.WorksetId.IntegerValue), PhaseScopeHash = DynamicRuntimeApplyState.PhaseScopeHash(elements),
                FileCapabilitySetHash = new DynamicFileCapabilitySetV1().CanonicalHash(), AuthorizedFileCapabilityIds = Array.Empty<string>(),
                PlannedExecutionMilliseconds = 0, PlannedRegenerations = graph.Operations.Count, PlannedOutputCount = 0, PlannedOutputBytes = 0
            };
            DynamicOperationGraphV1Admission.Validate(translated, budget, new[] { "move_element", "set_parameter" }, context);
        }

        private static void Apply(Document document, Element element, DynamicOperation operation)
        {
            if (operation.Kind == "move_element") { var v = operation.VectorFeet!; ElementTransformUtils.MoveElement(document, element.Id, new XYZ(v[0], v[1], v[2])); return; }
            if (operation.Kind == "set_parameter")
            {
                var parameter = element.LookupParameter(operation.Parameter!) ?? throw new InvalidOperationException("Parameter unavailable: " + operation.Parameter);
                if (parameter.IsReadOnly || parameter.StorageType != StorageType.String || !parameter.Set(operation.Value!)) throw new InvalidOperationException("Parameter is not writable text: " + operation.Parameter);
                return;
            }
            throw new InvalidOperationException("Unsupported dynamic apply operation: " + operation.Kind);
        }
        private static Before CaptureBefore(Element element, DynamicOperation operation) => new Before
        {
            Point = operation.Kind == "move_element" && element.Location is LocationPoint point ? point.Point : null,
            Value = operation.Kind == "set_parameter" ? element.LookupParameter(operation.Parameter!)?.AsString() : null
        };
        private static object Readback(Element element, DynamicOperation operation, Before before) => operation.Kind == "move_element"
            ? new { operation_id = operation.OperationId, kind = operation.Kind, target = operation.TargetUniqueId, before = Point(before.Point!), after = Point(((LocationPoint)element.Location).Point) }
            : new { operation_id = operation.OperationId, kind = operation.Kind, target = operation.TargetUniqueId, parameter = operation.Parameter, before = before.Value, after = element.LookupParameter(operation.Parameter!)?.AsString() };
        private static object Point(XYZ point) => new { x = point.X, y = point.Y, z = point.Z };
        private static void VerifyReadback(Element element, DynamicOperation operation, Before before)
        {
            if (operation.Kind == "set_parameter" && element.LookupParameter(operation.Parameter!)?.AsString() != operation.Value) throw new InvalidOperationException("Dynamic apply parameter readback did not match.");
            if (operation.Kind == "move_element")
            {
                if (!(element.Location is LocationPoint point) || before.Point == null) throw new InvalidOperationException("Dynamic apply location readback is unavailable.");
                var vector = operation.VectorFeet!; var expected = before.Point + new XYZ(vector[0], vector[1], vector[2]);
                if (!point.Point.IsAlmostEqualTo(expected)) throw new InvalidOperationException("Dynamic apply location readback did not match the authorized vector.");
            }
        }
        private static void RequireDeadline(Stopwatch stopwatch, int maximum) { if (stopwatch.ElapsedMilliseconds > maximum) throw new TimeoutException("Dynamic apply exceeded its authorized deadline."); }
        private static void PersistReceipt(string admissionId, object receipt)
        {
            var root = Environment.GetEnvironmentVariable("REVIT_OPERATOR_DYNAMIC_RECEIPT_DIRECTORY");
            if (string.IsNullOrWhiteSpace(root)) root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitOperator", "DynamicRuntime", "apply-receipts-v1");
            Directory.CreateDirectory(root); if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Dynamic receipt directory cannot be a reparse point.");
            var file = Path.Combine(root, DynamicWire.Sha256(admissionId).Substring("sha256:".Length) + ".json");
            using var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(receipt)); stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
        }
        private static void ValidateAdmissionShape(string json)
        {
            using var document = JsonDocument.Parse(json); var admission = document.RootElement.GetProperty("admission");
            var expected = new HashSet<string>(new[] { "schema", "admission_id", "normalized_source_hash", "compiled_artifact_hash", "compiler_runtime_hash", "sdk_version", "sdk_manifest_hash", "sdk_artifact_hash", "worker_executable_hash", "worker_runtime_package_hash", "sandbox_profile_version", "sandbox_profile_hash", "authenticated_worker_identity_hash", "target_revit_version", "host_adapter_manifest_hash", "document_fingerprint", "document_session_id", "document_revision", "project_context_identity_hash", "capability_envelope_hash", "operation_family_envelope_hash", "effect_budget_hash", "file_capability_set_hash", "operation_graph_hash", "preview_receipt_hash", "policy_identity_hash", "runtime_identity_hash", "request_family_seal_hash", "final_authorization_hash", "principal_id_hash", "principal_session_hash", "correlation_id", "replay_nonce_hash", "issued_unix_seconds", "expires_unix_seconds", "admission_signature" }, StringComparer.Ordinal);
            var names = admission.ValueKind == JsonValueKind.Object ? admission.EnumerateObject().Select(property => property.Name).ToArray() : Array.Empty<string>();
            if (names.Length != expected.Count || names.Distinct(StringComparer.Ordinal).Count() != names.Length || names.Any(name => !expected.Contains(name))) throw new ArgumentException("Dynamic admission has an invalid exact wire shape.");
        }
    }
}
