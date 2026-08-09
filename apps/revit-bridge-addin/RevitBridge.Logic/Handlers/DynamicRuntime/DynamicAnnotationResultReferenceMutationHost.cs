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
    internal sealed class DynamicAnnotationActivatedPreviewV1
    {
        internal DynamicAnnotationOperationPreviewV1 Preview = new DynamicAnnotationOperationPreviewV1();
        internal string SemanticSetHash = "";
    }

    internal sealed class DynamicAnnotationApplyReceiptV1
    {
        public string Schema { get; set; } = "dynamic-revit-annotation-operation-apply-receipt/v1";
        public string ContractManifestHash { get; set; } = DynamicAnnotationOperationManifestV1.ManifestHash;
        public string GraphHash { get; set; } = "";
        public string PreviewHash { get; set; } = "";
        public string AuthorizationHash { get; set; } = "";
        public string EffectBudgetHash { get; set; } = "";
        public string DocumentFingerprint { get; set; } = "";
        public string DocumentSessionId { get; set; } = "";
        public long DocumentRevisionBefore { get; set; }
        public long DocumentRevisionAfter { get; set; }
        public IReadOnlyList<long> AddedElementIds { get; set; } = Array.Empty<long>();
        public IReadOnlyList<long> ModifiedElementIds { get; set; } = Array.Empty<long>();
        public IReadOnlyList<DynamicCreatedResultFactV1> Outputs { get; set; } = Array.Empty<DynamicCreatedResultFactV1>();
        public IReadOnlyList<DynamicAnnotationOperationReadbackV1> Readbacks { get; set; } = Array.Empty<DynamicAnnotationOperationReadbackV1>();
        public string OutputSetHash { get; set; } = "";
        public string ReadbackSetHash { get; set; } = "";
        public string SemanticSetHash { get; set; } = "";
        public string Outcome { get; set; } = "committed_verified";
        public string ReceiptHash { get; set; } = "";
    }

    /// <summary>
    /// Activated annotation result-graph host. It remains behind the exact development/laboratory
    /// handler boundary and uses the shared result-reference resolver and transaction host.
    /// Preview rolls back and proves every changed ID; apply assimilates only after fresh semantic,
    /// output, collateral, and annotation readback verification matches the sealed preview.
    /// </summary>
    internal static class DynamicAnnotationResultReferenceMutationHostV1
    {
        private const int BaselineLimit = 50000;
        private static readonly string[] Kinds = { "edit_text_note", "create_tag" };

        private sealed class Baseline { internal string UniqueId = ""; internal string StateHash = ""; }
        private sealed class Changes
        {
            internal readonly HashSet<long> Added = new HashSet<long>();
            internal readonly HashSet<long> Modified = new HashSet<long>();
            internal readonly HashSet<long> Deleted = new HashSet<long>();
        }
        private sealed class Run
        {
            internal IReadOnlyList<DynamicCreatedResultFactV1> Outputs = Array.Empty<DynamicCreatedResultFactV1>();
            internal IReadOnlyList<DynamicAnnotationOperationReadbackV1> Readbacks = Array.Empty<DynamicAnnotationOperationReadbackV1>();
            internal IReadOnlyList<long> Added = Array.Empty<long>();
            internal IReadOnlyList<long> Modified = Array.Empty<long>();
            internal string SemanticSetHash = "";
            internal bool RollbackVerified;
        }

        internal static DynamicAnnotationActivatedPreviewV1 Preview(UIApplication application, DynamicResultReferenceGraphV1 graph,
            DynamicEffectBudgetV1 budget, IReadOnlyDictionary<string, DynamicTrustedElementFactV1> admissionTargets, long trustedDocumentRevision)
        {
            var run = Execute(application, graph, budget, admissionTargets, trustedDocumentRevision, false, null);
            var rolledBackOutputs = run.Outputs.Select(CloneRolledBack).ToArray();
            var resultReceipt = new DynamicResultReferenceReceiptV1
            {
                GraphHash = graph.GraphHash,
                DocumentFingerprint = graph.DocumentFingerprint,
                DocumentSessionId = graph.DocumentSessionId,
                DocumentRevision = graph.DocumentRevision,
                Outcome = "preview_rolled_back_verified",
                RollbackVerified = run.RollbackVerified,
                PartialFailureRolledBack = false,
                FailureNodeId = "",
                Outputs = rolledBackOutputs
            };
            resultReceipt.ReceiptHash = DynamicResultReferencePolicyV1.ReceiptHash(resultReceipt);
            var preview = new DynamicAnnotationOperationPreviewV1
            {
                ResultReceipt = resultReceipt,
                Readbacks = run.Readbacks,
                ReadbackSetHash = DynamicAnnotationOperationPolicyV1.ReadbackSetHash(run.Readbacks)
            };
            preview.PreviewHash = DynamicAnnotationOperationPolicyV1.PreviewHash(preview);
            DynamicAnnotationOperationPolicyV1.ValidatePreviewAgainstGraph(preview, graph);
            return new DynamicAnnotationActivatedPreviewV1 { Preview = preview, SemanticSetHash = run.SemanticSetHash };
        }

        internal static DynamicAnnotationApplyReceiptV1 Apply(UIApplication application, DynamicResultReferenceGraphV1 graph,
            DynamicEffectBudgetV1 budget, IReadOnlyDictionary<string, DynamicTrustedElementFactV1> admissionTargets,
            DynamicAnnotationActivatedPreviewV1 preview, string authorizationHash, long trustedDocumentRevision)
        {
            DynamicAnnotationOperationPolicyV1.ValidatePreviewAgainstGraph(preview.Preview, graph);
            var run = Execute(application, graph, budget, admissionTargets, trustedDocumentRevision, true, preview.SemanticSetHash);
            var receipt = new DynamicAnnotationApplyReceiptV1
            {
                GraphHash = graph.GraphHash,
                PreviewHash = preview.Preview.PreviewHash,
                AuthorizationHash = authorizationHash,
                EffectBudgetHash = budget.CanonicalHash(),
                DocumentFingerprint = graph.DocumentFingerprint,
                DocumentSessionId = graph.DocumentSessionId,
                DocumentRevisionBefore = graph.DocumentRevision,
                DocumentRevisionAfter = graph.DocumentRevision + 1,
                AddedElementIds = run.Added,
                ModifiedElementIds = run.Modified,
                Outputs = run.Outputs,
                Readbacks = run.Readbacks,
                OutputSetHash = OutputSetHash(run.Outputs),
                ReadbackSetHash = DynamicAnnotationOperationPolicyV1.ReadbackSetHash(run.Readbacks),
                SemanticSetHash = run.SemanticSetHash
            };
            receipt.ReceiptHash = ReceiptHash(receipt);
            return receipt;
        }

        private static Run Execute(UIApplication application, DynamicResultReferenceGraphV1 graph, DynamicEffectBudgetV1 budget,
            IReadOnlyDictionary<string, DynamicTrustedElementFactV1> admissionTargets, long trustedDocumentRevision, bool commit, string? expectedSemanticSetHash)
        {
            if (application == null) throw new ArgumentNullException(nameof(application));
            var document = application.ActiveUIDocument?.Document ?? throw new InvalidOperationException("A live active Revit document is required.");
            DynamicAnnotationOperationPolicyV1.ValidateGraph(graph);
            DynamicResultReferencePolicyV1.Validate(graph, budget, Kinds, admissionTargets);
            if (trustedDocumentRevision < 0 || graph.DocumentRevision != trustedDocumentRevision || graph.DocumentFingerprint != DynamicRuntimeSnapshotHandler.Fingerprint(document) ||
                graph.DocumentSessionId != DynamicRuntimeSnapshotHandler.Session(document))
                throw new InvalidOperationException("Annotation graph is not bound to the exact active document/session/revision.");

            var baseline = CaptureBaseline(document);
            var resolver = new DynamicResultReferenceHostResolverV1(graph);
            var executor = new DynamicAnnotationResultGraphExecutorV1();
            var host = new DynamicResultReferenceRevitTransactionalHostV1(application, executor);
            var allAdded = new HashSet<long>(); var allModified = new HashSet<long>(); var allDeleted = new HashSet<long>();
            var semantic = new List<string>(); Changes? current = null; Exception? trackingFailure = null; var finished = false;
            EventHandler<DocumentChangedEventArgs> changed = (sender, args) =>
            {
                try
                {
                    if (current == null || args.GetDocument() != document) return;
                    foreach (var id in args.GetAddedElementIds()) current.Added.Add(ElementIdCompat.GetValue(id));
                    foreach (var id in args.GetModifiedElementIds()) current.Modified.Add(ElementIdCompat.GetValue(id));
                    foreach (var id in args.GetDeletedElementIds()) current.Deleted.Add(ElementIdCompat.GetValue(id));
                }
                catch (Exception error) { trackingFailure = error; }
            };
            try
            {
                host.Begin(graph); application.Application.DocumentChanged += changed;
                foreach (var node in graph.Nodes)
                {
                    current = new Changes();
                    var resolved = resolver.Resolve(node, host.LiveExternalTarget);
                    var facts = host.ExecuteNode(node, resolved);
                    if (trackingFailure != null) throw new InvalidOperationException("Annotation DocumentChanged capture failed.", trackingFailure);
                    var readback = executor.Readbacks.Single(value => value.NodeId == node.NodeId);
                    ValidateObservedNode(document, node, resolved, facts, readback, current);
                    resolver.RegisterSuccessfulOutputs(node, facts);
                    allAdded.UnionWith(current.Added); allModified.UnionWith(current.Modified); allDeleted.UnionWith(current.Deleted);
                    semantic.Add(Semantic(node, resolved, facts, readback, current)); current = null;
                }
                var outputs = resolver.CloseAndSnapshot();
                var readbacks = executor.Readbacks;
                var semanticSetHash = DynamicWire.Sha256("dynamic-annotation-semantic-set/v1\n" + string.Join("\n", semantic.OrderBy(value => value, StringComparer.Ordinal)));
                if (allDeleted.Count != 0 || allAdded.Count > budget.MaximumCreates || allModified.Count > budget.MaximumModifications ||
                    allAdded.Concat(allModified).Distinct().Count() > budget.MaximumAffectedElements)
                    throw new InvalidOperationException("Observed annotation collateral exceeded the exact effect budget.");
                if (expectedSemanticSetHash != null && semanticSetHash != expectedSemanticSetHash)
                    throw new InvalidOperationException("Annotation apply semantics, effects, outputs, or readbacks diverged from preview.");

                application.Application.DocumentChanged -= changed;
                if (commit)
                {
                    VerifyLive(document, application, outputs, readbacks);
                    if (!host.Commit()) throw new InvalidOperationException("Annotation result-reference apply group did not assimilate.");
                    finished = true;
                    return new Run { Outputs = outputs, Readbacks = readbacks, Added = allAdded.OrderBy(value => value).ToArray(), Modified = allModified.OrderBy(value => value).ToArray(), SemanticSetHash = semanticSetHash };
                }
                if (!host.Rollback() || !VerifyRollback(document, baseline, allAdded.Concat(allModified).Concat(allDeleted)))
                    throw new InvalidOperationException("Annotation result-reference preview rollback truth failed.");
                finished = true;
                return new Run { Outputs = outputs, Readbacks = readbacks, Added = allAdded.OrderBy(value => value).ToArray(), Modified = allModified.OrderBy(value => value).ToArray(), SemanticSetHash = semanticSetHash, RollbackVerified = true };
            }
            finally
            {
                try { application.Application.DocumentChanged -= changed; } catch { }
                if (!finished) { try { host.Rollback(); } catch { } }
            }
        }

        private static void ValidateObservedNode(Document document, DynamicResultReferenceNodeV1 node, IReadOnlyList<DynamicResolvedElementTargetV1> resolved,
            IReadOnlyList<DynamicCreatedResultFactV1> facts, DynamicAnnotationOperationReadbackV1 readback, Changes changes)
        {
            if (changes.Deleted.Count != 0) throw new InvalidOperationException("Annotation primitives may not delete elements.");
            if (node.Kind == "edit_text_note")
            {
                if (facts.Count != 0 || changes.Added.Count != 0 || changes.Modified.Count != 1 || !changes.Modified.Contains(resolved[0].ElementId) || readback.SubjectUniqueId != resolved[0].UniqueId)
                    throw new InvalidOperationException("edit_text_note produced unscoped or missing observed effects.");
            }
            else
            {
                if (facts.Count != 1 || changes.Added.Count != 1 || !changes.Added.Contains(facts[0].CreatedElementId) || changes.Modified.Count != 0)
                    throw new InvalidOperationException("create_tag produced collateral or failed exact creation accounting.");
                var element = document.GetElement(facts[0].CreatedUniqueId);
                if (!(element is IndependentTag) || readback.SubjectUniqueId != facts[0].CreatedUniqueId)
                    throw new InvalidOperationException("create_tag output/readback identity is not an IndependentTag.");
            }
        }

        private static string Semantic(DynamicResultReferenceNodeV1 node, IReadOnlyList<DynamicResolvedElementTargetV1> resolved,
            IReadOnlyList<DynamicCreatedResultFactV1> facts, DynamicAnnotationOperationReadbackV1 readback, Changes changes)
        {
            var values = string.Join("\n", readback.Values.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => pair.Key + "=" + pair.Value));
            var targets = string.Join("\n", resolved.Select(value => value.SourceKind + ":" + value.SourceIdentity).OrderBy(value => value, StringComparer.Ordinal));
            var outputs = string.Join("\n", facts.Select(value => value.OutputSlot + ":" + value.CategoryStableId + ":" + value.TypeUniqueId).OrderBy(value => value, StringComparer.Ordinal));
            return DynamicWire.Sha256("dynamic-annotation-node-semantic/v1\n" + node.NodeId + "\n" + node.Kind + "\n" + targets + "\n" + outputs + "\n" + values + "\n" +
                changes.Added.Count.ToString(CultureInfo.InvariantCulture) + ":" + changes.Modified.Count.ToString(CultureInfo.InvariantCulture) + ":" + changes.Deleted.Count.ToString(CultureInfo.InvariantCulture));
        }

        private static void VerifyLive(Document document, UIApplication application, IEnumerable<DynamicCreatedResultFactV1> outputs,
            IEnumerable<DynamicAnnotationOperationReadbackV1> readbacks)
        {
            foreach (var output in outputs)
            {
                var element = document.GetElement(output.CreatedUniqueId);
                if (element == null || ElementIdCompat.GetValue(element.Id) != output.CreatedElementId || DynamicAnnotationRevitStateV1.StateHash(element) != output.StateHash || element.IsHidden(application.ActiveUIDocument.ActiveView))
                    throw new InvalidOperationException("Fresh annotation output failed independent identity/state/visibility readback.");
            }
            foreach (var readback in readbacks.Where(value => value.Kind == "edit_text_note"))
            {
                var element = document.GetElement(readback.SubjectUniqueId);
                if (element == null || DynamicAnnotationRevitStateV1.StateHash(element) != readback.AfterStateHash)
                    throw new InvalidOperationException("Edited annotation failed independent post-state readback.");
            }
        }

        private static Dictionary<long, Baseline> CaptureBaseline(Document document)
        {
            var result = new Dictionary<long, Baseline>();
            foreach (var element in AllElements(document))
            {
                if (result.Count >= BaselineLimit) throw new InvalidOperationException("Annotation exact rollback baseline exceeds 50000 elements.");
                result[ElementIdCompat.GetValue(element.Id)] = new Baseline { UniqueId = element.UniqueId ?? "", StateHash = DynamicAnnotationRevitStateV1.StateHash(element) };
            }
            return result;
        }
        private static IEnumerable<Element> AllElements(Document document)
        {
            foreach (var element in new FilteredElementCollector(document).WhereElementIsNotElementType()) yield return element;
            foreach (var element in new FilteredElementCollector(document).WhereElementIsElementType()) yield return element;
        }
        private static bool VerifyRollback(Document document, IReadOnlyDictionary<long, Baseline> baseline, IEnumerable<long> ids) => ids.Distinct().All(id =>
        {
            var current = document.GetElement(ElementIdCompat.Create(id));
            return baseline.TryGetValue(id, out var prior) ? current != null && current.UniqueId == prior.UniqueId && DynamicAnnotationRevitStateV1.StateHash(current) == prior.StateHash : current == null;
        });
        private static DynamicCreatedResultFactV1 CloneRolledBack(DynamicCreatedResultFactV1 value)
        {
            var copy = new DynamicCreatedResultFactV1 { ProducerNodeId = value.ProducerNodeId, ResultId = value.ResultId, OutputSlot = value.OutputSlot,
                CreatedUniqueId = value.CreatedUniqueId, CreatedElementId = value.CreatedElementId, DocumentFingerprint = value.DocumentFingerprint,
                CategoryStableId = value.CategoryStableId, TypeUniqueId = value.TypeUniqueId, StateHash = value.StateHash,
                Status = "rolled_back_verified", Verified = true, Visible = false };
            copy.OutputHash = DynamicResultReferencePolicyV1.OutputHash(copy); return copy;
        }
        private static string OutputSetHash(IEnumerable<DynamicCreatedResultFactV1> outputs) => DynamicWire.Sha256("dynamic-annotation-output-set/v1\n" + string.Join("\n", outputs.Select(value => value.OutputHash).OrderBy(value => value, StringComparer.Ordinal)));
        private static string ReceiptHash(DynamicAnnotationApplyReceiptV1 value) => DynamicWire.Sha256(string.Join("\n", new[] { value.Schema, value.ContractManifestHash,
            value.GraphHash, value.PreviewHash, value.AuthorizationHash, value.EffectBudgetHash, value.DocumentFingerprint, value.DocumentSessionId,
            value.DocumentRevisionBefore.ToString(CultureInfo.InvariantCulture), value.DocumentRevisionAfter.ToString(CultureInfo.InvariantCulture),
            string.Join(",", value.AddedElementIds), string.Join(",", value.ModifiedElementIds), value.OutputSetHash, value.ReadbackSetHash, value.SemanticSetHash, value.Outcome }));
    }
}
