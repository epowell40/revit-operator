using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    /// <summary>
    /// Shared, unregistered laboratory preview/apply seam for result-reference mutations.
    /// Preview IDs remain transaction-local. Apply consumes durable authority before mutation,
    /// produces fresh IDs, and assimilates only after exact semantic/effect/readback verification.
    /// </summary>
    internal static class DynamicMepResultReferenceMutationHostV1
    {
        private const int BaselineLimit = 50000;
        private static readonly string[] Kinds = { "create_mep_curve", "connect_mep", "create_transition_fitting" };

        internal static DynamicMepMutationPreviewV1 Preview(UIApplication application, DynamicResultReferenceGraphV1 graph,
            DynamicEffectBudgetV1 budget, IReadOnlyDictionary<string, DynamicTrustedElementFactV1> admissionTargets, long trustedDocumentRevision)
        {
            var run = Execute(application, graph, budget, admissionTargets, trustedDocumentRevision, commit: false, expected: null);
            var preview = new DynamicMepMutationPreviewV1
            {
                GraphHash = graph.GraphHash, EffectBudgetHash = budget.CanonicalHash(), DocumentFingerprint = graph.DocumentFingerprint,
                DocumentSessionId = graph.DocumentSessionId, DocumentRevision = graph.DocumentRevision, Effects = run.SemanticEffects,
                Outputs = run.SemanticOutputs, Readbacks = run.Readbacks, SemanticEffectSetHash = DynamicMepMutationPolicyV1.SemanticEffectSetHash(run.SemanticEffects),
                SemanticOutputSetHash = DynamicMepMutationPolicyV1.SemanticOutputSetHash(run.SemanticOutputs),
                ReadbackSetHash = DynamicMepMutationPolicyV1.ReadbackSetHash(run.Readbacks), TopologyHash = run.TopologyHash, RollbackVerified = run.RollbackVerified
            };
            preview.PreviewHash = DynamicMepMutationPolicyV1.PreviewHash(preview); return preview;
        }

        internal static DynamicMepMutationApplyReceiptV1 Apply(UIApplication application, DynamicResultReferenceGraphV1 graph,
            DynamicEffectBudgetV1 budget, IReadOnlyDictionary<string, DynamicTrustedElementFactV1> admissionTargets,
            DynamicMepMutationPreviewV1 preview, DynamicMepMutationApplyAuthorizationV1 authorization,
            IDynamicCoreOperationApplyAuthorizationLedgerV1 authorizationLedger, byte[] trustedKey, long nowUnixSeconds, long trustedDocumentRevision)
        {
            if (preview.GraphHash != graph.GraphHash || preview.DocumentFingerprint != graph.DocumentFingerprint || preview.DocumentSessionId != graph.DocumentSessionId || preview.DocumentRevision != graph.DocumentRevision)
                throw new InvalidOperationException("MEP result-reference preview was substituted or is stale.");
            var authorizationHash = DynamicMepMutationPolicyV1.ValidateAndConsumeAuthorization(authorization, preview, budget, nowUnixSeconds, trustedKey, authorizationLedger);
            var run = Execute(application, graph, budget, admissionTargets, trustedDocumentRevision, commit: true, expected: preview);
            var receipt = new DynamicMepMutationApplyReceiptV1
            {
                GraphHash = graph.GraphHash, PreviewHash = preview.PreviewHash, AuthorizationHash = authorizationHash,
                EffectBudgetHash = budget.CanonicalHash(), DocumentFingerprint = graph.DocumentFingerprint, DocumentSessionId = graph.DocumentSessionId,
                DocumentRevisionBefore = graph.DocumentRevision, DocumentRevisionAfter = graph.DocumentRevision + 1,
                Effects = run.ObservedEffects, Outputs = run.CreatedOutputs, Readbacks = run.Readbacks,
                SemanticEffectSetHash = DynamicMepMutationPolicyV1.SemanticEffectSetHash(run.SemanticEffects),
                SemanticOutputSetHash = DynamicMepMutationPolicyV1.SemanticOutputSetHash(run.SemanticOutputs),
                ReadbackSetHash = DynamicMepMutationPolicyV1.ReadbackSetHash(run.Readbacks), TopologyHash = run.TopologyHash
            };
            receipt.ReceiptHash = DynamicMepMutationPolicyV1.ApplyReceiptHash(receipt); return receipt;
        }

        private sealed class Baseline { internal string UniqueId = ""; internal string StateHash = ""; }
        private sealed class ChangeSet { internal readonly HashSet<long> Added = new(); internal readonly HashSet<long> Modified = new(); internal readonly HashSet<long> Deleted = new(); }
        private sealed class Run
        {
            internal IReadOnlyList<DynamicMepSemanticEffectV1> SemanticEffects = Array.Empty<DynamicMepSemanticEffectV1>();
            internal IReadOnlyList<DynamicMepObservedEffectV1> ObservedEffects = Array.Empty<DynamicMepObservedEffectV1>();
            internal IReadOnlyList<DynamicMepSemanticOutputV1> SemanticOutputs = Array.Empty<DynamicMepSemanticOutputV1>();
            internal IReadOnlyList<DynamicCreatedResultFactV1> CreatedOutputs = Array.Empty<DynamicCreatedResultFactV1>();
            internal IReadOnlyList<DynamicResultReferenceMutationReadbackV1> Readbacks = Array.Empty<DynamicResultReferenceMutationReadbackV1>();
            internal string TopologyHash = ""; internal bool RollbackVerified;
        }

        private static Run Execute(UIApplication application, DynamicResultReferenceGraphV1 graph, DynamicEffectBudgetV1 budget,
            IReadOnlyDictionary<string, DynamicTrustedElementFactV1> admissionTargets, long trustedDocumentRevision, bool commit, DynamicMepMutationPreviewV1? expected)
        {
            if (application == null) throw new ArgumentNullException(nameof(application));
            var document = application.ActiveUIDocument?.Document ?? throw new InvalidOperationException("A live active Revit document is required.");
            DynamicMepMutationPolicyV1.ValidateGraphShape(graph);
            DynamicResultReferencePolicyV1.Validate(graph, budget, Kinds, admissionTargets);
            if (trustedDocumentRevision < 0 || graph.DocumentRevision != trustedDocumentRevision || graph.ContractManifestHash != DynamicResultReferenceManifestV1.ManifestHash || graph.DocumentFingerprint != DynamicRuntimeSnapshotHandler.Fingerprint(document) || graph.DocumentSessionId != DynamicRuntimeSnapshotHandler.Session(document))
                throw new InvalidOperationException("MEP graph is not bound to the exact active document/session.");
            var baseline = CaptureBaseline(document); var resolver = new DynamicResultReferenceHostResolverV1(graph); var executor = new DynamicMepResultReferenceExecutorV1(application);
            var semanticEffects = new List<DynamicMepSemanticEffectV1>(); var observedEffects = new List<DynamicMepObservedEffectV1>();
            var semanticOutputs = new List<DynamicMepSemanticOutputV1>(); var readbacks = new List<DynamicResultReferenceMutationReadbackV1>();
            var symbolicByElementId = new Dictionary<long, string>();
            var createdDuringGraph = new HashSet<long>();
            var addedCategoriesDuringGraph = new Dictionary<string, int>(StringComparer.Ordinal);
            var allChanged = new HashSet<long>(); ChangeSet? current = null; Exception? trackingFailure = null;
            EventHandler<DocumentChangedEventArgs> changed = (sender, args) =>
            {
                try
                {
                    if (current == null || args.GetDocument() != document) return;
                    foreach (var id in args.GetAddedElementIds()) current.Added.Add(ElementIdCompat.GetValue(id));
                    foreach (var id in args.GetModifiedElementIds()) current.Modified.Add(ElementIdCompat.GetValue(id));
                    foreach (var id in args.GetDeletedElementIds()) current.Deleted.Add(ElementIdCompat.GetValue(id));
                }
                catch (Exception ex) { trackingFailure = ex; }
            };
            TransactionGroup? group = null; var complete = false;
            try
            {
                group = new TransactionGroup(document, commit ? "Dynamic MEP Result Graph Apply" : "Dynamic MEP Result Graph Preview");
                if (group.Start() != TransactionStatus.Started) throw new InvalidOperationException("Unable to start MEP result-reference transaction group.");
                application.Application.DocumentChanged += changed;
                foreach (var node in graph.Nodes)
                {
                    var resolved = resolver.Resolve(node, uniqueId => LiveExternal(document, application, uniqueId)); current = new ChangeSet(); DynamicMepLabExecutionV1 executed;
                    using (var transaction = new Transaction(document, "Dynamic MEP " + node.Kind))
                    {
                        if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Unable to start MEP node transaction.");
                        try { executed = executor.ExecuteWithEvidence(document, node, resolved); if (transaction.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("MEP node transaction did not commit inside its group."); }
                        catch { if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack(); throw; }
                    }
                    if (trackingFailure != null) throw new InvalidOperationException("MEP DocumentChanged capture failed.", trackingFailure);
                    if (current.Deleted.Count != 0) throw new InvalidOperationException("Bounded MEP primitives may not delete collateral elements.");
                    foreach (var id in current.Modified.Where(id => !baseline.ContainsKey(id) && !createdDuringGraph.Contains(id)).ToArray())
                    {
                        current.Modified.Remove(id);
                        current.Added.Add(id);
                    }
                    var scannedElementCount = 0;
                    foreach (var element in AllElements(document))
                    {
                        scannedElementCount++;
                        if (scannedElementCount > BaselineLimit + 256)
                            throw new InvalidOperationException("Live MEP element reconciliation exceeded its bounded 50256-element scan.");
                        var id = ElementIdCompat.GetValue(element.Id);
                        if (!baseline.ContainsKey(id) && !createdDuringGraph.Contains(id)) current.Added.Add(id);
                    }
                    if (current.Added.Any(id => baseline.ContainsKey(id) || createdDuringGraph.Contains(id)))
                        throw new InvalidOperationException("MEP DocumentChanged creation classification contradicts the exact pre-graph baseline.");
                    foreach (var addedId in current.Added)
                    {
                        var addedElement = document.GetElement(ElementIdCompat.Create(addedId)) ??
                            throw new InvalidOperationException("An added MEP collateral element disappeared before per-node classification.");
                        var addedCategory = CategoryId(addedElement.Category);
                        addedCategoriesDuringGraph[addedCategory] = addedCategoriesDuringGraph.TryGetValue(addedCategory, out var categoryCount) ? categoryCount + 1 : 1;
                    }
                    var facts = CreateFacts(document, application, node, executed);
                    var outputIds = new HashSet<long>(facts.Select(value => value.CreatedElementId));
                    if (!outputIds.IsSubsetOf(current.Added)) throw new InvalidOperationException("MEP executor outputs are not proven members of the exact event-and-baseline addition set.");
                    foreach (var fact in facts) symbolicByElementId.Add(fact.CreatedElementId, "result:" + fact.ResultId + ":" + fact.OutputSlot);
                    createdDuringGraph.UnionWith(current.Added);
                    resolver.RegisterSuccessfulOutputs(node, facts);
                    var nodeSemanticOutputs = node.Outputs.Select(declaration => SemanticOutput(node, declaration, executed.SemanticOutputStateHashes[declaration.OutputSlot])).ToArray(); semanticOutputs.AddRange(nodeSemanticOutputs);
                    var effect = SemanticEffect(document, node, resolved, current, executed.TopologyHash, baseline, symbolicByElementId); semanticEffects.Add(effect);
                    var observed = new DynamicMepObservedEffectV1 { NodeId = node.NodeId, Kind = node.Kind, AddedElementIds = current.Added.OrderBy(value => value).ToArray(),
                        ModifiedElementIds = current.Modified.OrderBy(value => value).ToArray(), DeletedElementIds = Array.Empty<long>(), SemanticEffectHash = effect.EffectHash };
                    observed.EffectHash = DynamicMepMutationPolicyV1.ObservedEffectHash(observed); observedEffects.Add(observed); readbacks.AddRange(executed.Readbacks);
                    resolver.RefreshSuccessfulOutputs(RefreshCreatedFacts(document, application, resolver.SnapshotSuccessfulOutputs()));
                    allChanged.UnionWith(current.Added); allChanged.UnionWith(current.Modified); current = null;
                }
                var created = RefreshCreatedFacts(document, application, resolver.CloseAndSnapshot());
                foreach (var output in semanticOutputs)
                {
                    var fact = created.Single(value => value.ResultId == output.ResultId && value.OutputSlot == output.OutputSlot);
                    output.MepStateHash = DynamicMepResultReferenceExecutorV1.SemanticState(document.GetElement(fact.CreatedUniqueId) ?? throw new InvalidOperationException("MEP semantic output disappeared."));
                    output.OutputHash = DynamicMepMutationPolicyV1.SemanticOutputHash(output);
                }
                budget.Validate();
                var addedIds = observedEffects.SelectMany(value => value.AddedElementIds).Distinct().ToArray();
                var addedCategories = addedCategoriesDuringGraph.OrderBy(pair => pair.Key, StringComparer.Ordinal).ToArray();
                var allowedCategories = new HashSet<string>(budget.AllowedCategories ?? Array.Empty<string>(), StringComparer.Ordinal);
                if (addedCategories.Any(pair => !allowedCategories.Contains(pair.Key)))
                    throw new InvalidOperationException("Observed MEP collateral exceeded the exact category budget: added_categories=" +
                        string.Join(",", addedCategories.Select(pair => pair.Key + "=" + pair.Value.ToString(CultureInfo.InvariantCulture))) + ".");
                if (allChanged.Count > budget.MaximumAffectedElements || addedIds.Length > budget.MaximumCreates || observedEffects.Sum(value => value.ModifiedElementIds.Count) > budget.MaximumModifications)
                    throw new InvalidOperationException("Observed MEP collateral exceeded the exact effect budget: affected=" + allChanged.Count.ToString(CultureInfo.InvariantCulture) +
                        ", creates=" + addedIds.Length.ToString(CultureInfo.InvariantCulture) +
                        ", modifications=" + observedEffects.Sum(value => value.ModifiedElementIds.Count).ToString(CultureInfo.InvariantCulture) +
                        ", added_categories=" + string.Join(",", addedCategories.Select(pair => pair.Key + "=" + pair.Value.ToString(CultureInfo.InvariantCulture))) + ".");
                var topologyHash = DynamicWire.Sha256("mep-graph-topology/v1\n" + string.Join("\n", semanticEffects.Select(value => value.TopologyHash).OrderBy(value => value, StringComparer.Ordinal)));
                if (expected != null && (DynamicMepMutationPolicyV1.SemanticEffectSetHash(semanticEffects) != expected.SemanticEffectSetHash || DynamicMepMutationPolicyV1.SemanticOutputSetHash(semanticOutputs) != expected.SemanticOutputSetHash || DynamicMepMutationPolicyV1.ReadbackSetHash(readbacks) != expected.ReadbackSetHash || topologyHash != expected.TopologyHash))
                    throw new InvalidOperationException("MEP apply semantics, topology, effects, or readbacks diverged from preview.");
                application.Application.DocumentChanged -= changed;
                if (commit)
                {
                    VerifyLiveOutputs(document, created); if (group.Assimilate() != TransactionStatus.Committed) throw new InvalidOperationException("MEP apply group did not assimilate."); complete = true;
                    return new Run { SemanticEffects = semanticEffects, ObservedEffects = observedEffects, SemanticOutputs = semanticOutputs, CreatedOutputs = created, Readbacks = readbacks, TopologyHash = topologyHash };
                }
                if (group.RollBack() != TransactionStatus.RolledBack || !VerifyRollback(document, baseline, allChanged)) throw new InvalidOperationException("MEP preview rollback truth failed.");
                complete = true; return new Run { SemanticEffects = semanticEffects, ObservedEffects = observedEffects, SemanticOutputs = semanticOutputs, Readbacks = readbacks, TopologyHash = topologyHash, RollbackVerified = true };
            }
            finally
            {
                try { application.Application.DocumentChanged -= changed; } catch { }
                if (!complete && group != null) { try { group.RollBack(); } catch { } }
                group?.Dispose();
            }
        }

        private static DynamicMepSemanticEffectV1 SemanticEffect(Document document, DynamicResultReferenceNodeV1 node, IReadOnlyList<DynamicResolvedElementTargetV1> resolved, ChangeSet changes, string topology,
            IReadOnlyDictionary<long, Baseline> baseline, IReadOnlyDictionary<long, string> symbolicByElementId)
        {
            var modifiedSources = changes.Modified.Select(id =>
            {
                if (symbolicByElementId.TryGetValue(id, out var symbolic)) return symbolic;
                var resolvedTarget = resolved.SingleOrDefault(value => value.ElementId == id);
                if (resolvedTarget != null) return resolvedTarget.SourceKind + ":" + resolvedTarget.SourceIdentity;
                if (baseline.TryGetValue(id, out var prior)) return "collateral:" + prior.UniqueId;
                throw new InvalidOperationException("Modified MEP collateral has no stable semantic identity.");
            });
            var addedCategoryTypes = changes.Added.Select(id => document.GetElement(ElementIdCompat.Create(id)) ??
                throw new InvalidOperationException("DocumentChanged reported an added MEP element that is unavailable for exact collateral classification."))
                .Select(element => CategoryId(element.Category) + "\n" + TypeUniqueId(document, element));
            var result = new DynamicMepSemanticEffectV1 { NodeId = node.NodeId, Kind = node.Kind, AddedCount = changes.Added.Count, ModifiedCount = changes.Modified.Count, DeletedCount = changes.Deleted.Count,
                AddedCategoryTypeSetHash = DynamicWire.Sha256("mep-added-types/v1\n" + string.Join("\n", addedCategoryTypes.OrderBy(value => value, StringComparer.Ordinal))),
                ModifiedSourceSetHash = DynamicWire.Sha256("mep-modified-sources/v1\n" + string.Join("\n", modifiedSources.OrderBy(value => value, StringComparer.Ordinal))), TopologyHash = topology };
            result.EffectHash = DynamicMepMutationPolicyV1.SemanticEffectHash(result); return result;
        }

        private static DynamicMepSemanticOutputV1 SemanticOutput(DynamicResultReferenceNodeV1 node, DynamicResultOutputDeclarationV1 declaration, string state)
        {
            var result = new DynamicMepSemanticOutputV1 { ProducerNodeId = node.NodeId, ResultId = declaration.ResultId, OutputSlot = declaration.OutputSlot,
                CategoryStableId = declaration.ExpectedCategoryStableId, TypeUniqueId = declaration.ExpectedTypeUniqueId, MepStateHash = state };
            result.OutputHash = DynamicMepMutationPolicyV1.SemanticOutputHash(result); return result;
        }

        private static IReadOnlyList<DynamicCreatedResultFactV1> CreateFacts(Document document, UIApplication application, DynamicResultReferenceNodeV1 node, DynamicMepLabExecutionV1 executed)
        {
            if (executed.Outputs.Count != node.Outputs.Count || executed.Outputs.Select(value => value.OutputSlot).Distinct(StringComparer.Ordinal).Count() != executed.Outputs.Count) throw new InvalidOperationException("MEP executor output slots diverged.");
            return node.Outputs.Select(declaration =>
            {
                var raw = executed.Outputs.Single(value => value.OutputSlot == declaration.OutputSlot); var element = raw.Element ?? throw new InvalidOperationException("MEP output is missing.");
                var category = CategoryId(element.Category); var type = TypeUniqueId(document, element); var visible = raw.VisibilityVerified && IsVisible(application, element);
                if (category != declaration.ExpectedCategoryStableId || type != declaration.ExpectedTypeUniqueId || !visible) throw new InvalidOperationException("MEP output category, type, or visibility diverged.");
                var fact = new DynamicCreatedResultFactV1 { ProducerNodeId = node.NodeId, ResultId = declaration.ResultId, OutputSlot = declaration.OutputSlot,
                    CreatedUniqueId = element.UniqueId, CreatedElementId = ElementIdCompat.GetValue(element.Id), DocumentFingerprint = declaration.ExpectedDocumentFingerprint,
                    CategoryStableId = category, TypeUniqueId = type, StateHash = DynamicRuntimePreviewHandler.TrustedElementStateHash(element), Status = "created_verified", Verified = true, Visible = true };
                fact.OutputHash = DynamicResultReferencePolicyV1.OutputHash(fact); return fact;
            }).ToArray();
        }

        private static DynamicTrustedElementFactV1? LiveExternal(Document document, UIApplication application, string uniqueId)
        {
            var element = document.GetElement(uniqueId); if (element == null || !element.IsValidObject) return null;
            return new DynamicTrustedElementFactV1 { UniqueId = element.UniqueId, ElementId = ElementIdCompat.GetValue(element.Id), DocumentFingerprint = DynamicRuntimeSnapshotHandler.Fingerprint(document),
                CategoryStableId = CategoryId(element.Category), TypeUniqueId = TypeUniqueId(document, element), StateHash = DynamicRuntimePreviewHandler.TrustedElementStateHash(element), Exists = true, Verified = true, Visible = IsVisible(application, element) };
        }

        private static Dictionary<long, Baseline> CaptureBaseline(Document document)
        {
            var result = new Dictionary<long, Baseline>(); foreach (var element in AllElements(document))
            { if (result.Count >= BaselineLimit) throw new InvalidOperationException("MEP exact rollback baseline exceeds 50000 elements."); result[ElementIdCompat.GetValue(element.Id)] = new Baseline { UniqueId = element.UniqueId ?? "", StateHash = StateHash(element) }; }
            return result;
        }
        private static IEnumerable<Element> AllElements(Document document)
        {
            foreach (var element in new FilteredElementCollector(document).WhereElementIsNotElementType()) yield return element;
            foreach (var element in new FilteredElementCollector(document).WhereElementIsElementType()) yield return element;
        }
        private static bool VerifyRollback(Document document, IReadOnlyDictionary<long, Baseline> baseline, IEnumerable<long> ids) => ids.All(id =>
        { var current = document.GetElement(ElementIdCompat.Create(id)); return baseline.TryGetValue(id, out var prior) ? current != null && current.UniqueId == prior.UniqueId && StateHash(current) == prior.StateHash : current == null; });
        private static void VerifyLiveOutputs(Document document, IEnumerable<DynamicCreatedResultFactV1> outputs) { foreach (var value in outputs) { var element = document.GetElement(value.CreatedUniqueId); if (element == null || ElementIdCompat.GetValue(element.Id) != value.CreatedElementId || DynamicRuntimePreviewHandler.TrustedElementStateHash(element) != value.StateHash) throw new InvalidOperationException("Fresh MEP apply output failed independent readback."); } }
        private static IReadOnlyList<DynamicCreatedResultFactV1> RefreshCreatedFacts(Document document, UIApplication application, IEnumerable<DynamicCreatedResultFactV1> values)
        {
            return values.Select(value =>
            {
                var element = document.GetElement(value.CreatedUniqueId) ?? throw new InvalidOperationException("Created MEP result disappeared before final verification.");
                if (ElementIdCompat.GetValue(element.Id) != value.CreatedElementId || !IsVisible(application, element)) throw new InvalidOperationException("Created MEP result identity or visibility changed.");
                var copy = new DynamicCreatedResultFactV1 { ProducerNodeId = value.ProducerNodeId, ResultId = value.ResultId, OutputSlot = value.OutputSlot,
                    CreatedUniqueId = value.CreatedUniqueId, CreatedElementId = value.CreatedElementId, DocumentFingerprint = value.DocumentFingerprint,
                    CategoryStableId = value.CategoryStableId, TypeUniqueId = value.TypeUniqueId, StateHash = DynamicRuntimePreviewHandler.TrustedElementStateHash(element),
                    Status = value.Status, Verified = value.Verified, Visible = value.Visible };
                copy.OutputHash = DynamicResultReferencePolicyV1.OutputHash(copy); return copy;
            }).ToArray();
        }
        private static string StateHash(Element element) => DynamicWire.Sha256("mep-rollback-state/v1\n" + DynamicRuntimePreviewHandler.TrustedElementStateHash(element) + "\n" + ConnectorTopology(element));
        private static string ConnectorTopology(Element element)
        {
            ConnectorSet? set = element is MEPCurve curve ? curve.ConnectorManager?.Connectors : element is FamilyInstance family ? family.MEPModel?.ConnectorManager?.Connectors : null;
            if (set == null) return "none"; var values = new List<string>(); foreach (Connector connector in set) values.Add(connector.Domain + ":" + connector.Shape + ":" + string.Join(",", connector.AllRefs.Cast<Connector>().Select(value => value.Owner.UniqueId).OrderBy(value => value, StringComparer.Ordinal)));
            return string.Join("\n", values.OrderBy(value => value, StringComparer.Ordinal));
        }
        private static bool IsVisible(UIApplication app, Element element) { try { return !element.IsHidden(app.ActiveUIDocument.ActiveView); } catch { return false; } }
        private static string TypeUniqueId(Document document, Element element) { var id = element.GetTypeId(); return id == ElementId.InvalidElementId ? "type:none" : document.GetElement(id)?.UniqueId ?? "type:missing"; }
        private static string CategoryId(Category? category) { if (category == null) return "category:none"; var id = ElementIdCompat.GetValue(category.Id); var name = id < 0 ? Enum.GetName(typeof(BuiltInCategory), (int)id) : null; return name == null ? "category:element:" + id.ToString(CultureInfo.InvariantCulture) : "category:builtin:" + name; }
    }
}
