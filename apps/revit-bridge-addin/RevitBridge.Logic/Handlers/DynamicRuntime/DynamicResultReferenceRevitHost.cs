using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    /// <summary>
    /// Lab-only creation executor seam. Nothing in the live handler registry implements or invokes this surface.
    /// A future primitive adapter must return every declared slot and independently prove visibility.
    /// </summary>
    internal interface IDynamicResultReferenceRevitLabExecutorV1
    {
        IReadOnlyList<DynamicRevitLabCreatedOutputV1> Execute(Document document, DynamicResultReferenceNodeV1 node,
            IReadOnlyList<DynamicResolvedElementTargetV1> resolvedTargets);
    }

    internal sealed class DynamicRevitLabCreatedOutputV1
    {
        internal string OutputSlot { get; set; } = "";
        internal Element? Element { get; set; }
        internal bool VisibilityVerified { get; set; }
    }

    /// <summary>
    /// Transaction-scoped host for executable lab previews. The SDK resolver owns symbolic identity;
    /// this host alone converts verified outputs into exact Revit UniqueId/ElementId facts.
    /// It is deliberately internal, unregistered, and rollback-only.
    /// </summary>
    internal sealed class DynamicResultReferenceRevitTransactionalHostV1 : IDynamicResultReferenceTransactionalHostV1
    {
        private readonly UIApplication _application;
        private readonly Document _document;
        private readonly IDynamicResultReferenceRevitLabExecutorV1 _executor;
        private readonly List<string> _createdUniqueIds = new List<string>();
        private readonly Dictionary<string, string> _externalStates = new Dictionary<string, string>(StringComparer.Ordinal);
        private TransactionGroup? _group;
        private bool _finished;

        internal DynamicResultReferenceRevitTransactionalHostV1(UIApplication application, IDynamicResultReferenceRevitLabExecutorV1 executor)
        {
            _application = application ?? throw new ArgumentNullException(nameof(application));
            _document = application.ActiveUIDocument?.Document ?? throw new InvalidOperationException("A live active Revit document is required.");
            _executor = executor ?? throw new ArgumentNullException(nameof(executor));
        }

        public void Begin(DynamicResultReferenceGraphV1 graph)
        {
            if (_group != null || _finished || graph == null || graph.DocumentFingerprint != DynamicRuntimeSnapshotHandler.Fingerprint(_document) ||
                graph.DocumentSessionId != DynamicRuntimeSnapshotHandler.Session(_document))
                throw new InvalidOperationException("Result-reference graph does not bind the active Revit document/session or host state is invalid.");
            _group = new TransactionGroup(_document, "Dynamic Result Reference Lab Preview");
            if (_group.Start() != TransactionStatus.Started) throw new InvalidOperationException("Unable to start result-reference preview transaction group.");
        }

        public IReadOnlyList<DynamicCreatedResultFactV1> ExecuteNode(DynamicResultReferenceNodeV1 node, IReadOnlyList<DynamicResolvedElementTargetV1> resolvedTargets)
        {
            if (_group == null || _finished || node == null || resolvedTargets == null) throw new InvalidOperationException("Result-reference transaction is not active.");
            foreach (var resolved in resolvedTargets.Where(value => value.SourceKind == "external"))
            {
                var element = _document.GetElement(resolved.UniqueId) ?? throw new InvalidOperationException("Result-reference external target disappeared before mutation.");
                var state = DynamicAnnotationRevitStateV1.StateHash(element);
                if (state != resolved.StateHash || _externalStates.TryGetValue(resolved.UniqueId, out var prior) && prior != state)
                    throw new InvalidOperationException("Result-reference external target exact state is stale or changed twice.");
                _externalStates[resolved.UniqueId] = state;
            }
            using (var transaction = new Transaction(_document, "Dynamic Result Reference " + node.Kind))
            {
                if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Unable to start result-reference node transaction.");
                try
                {
                    var raw = (_executor.Execute(_document, node, resolvedTargets) ?? throw new InvalidOperationException("Lab executor returned no output authority.")).ToArray();
                    if (raw.Length != node.Outputs.Count || raw.Any(value => value == null) ||
                        raw.Select(value => value.OutputSlot).Distinct(StringComparer.Ordinal).Count() != raw.Length)
                        throw new InvalidOperationException("Lab executor did not return an exact, distinct declared output-slot set.");
                    _document.Regenerate();
                    var facts = node.Outputs.Select(declaration => CreateFact(node, declaration,
                        raw.SingleOrDefault(value => value.OutputSlot == declaration.OutputSlot) ?? throw new InvalidOperationException("Lab executor omitted a declared output slot."))).ToArray();
                    if (transaction.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Result-reference node transaction did not commit inside its rollback group.");
                    _createdUniqueIds.AddRange(facts.Select(value => value.CreatedUniqueId));
                    return facts;
                }
                catch
                {
                    if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack();
                    throw;
                }
            }
        }

        public bool Rollback()
        {
            if (_group == null || _finished) return false;
            _finished = true;
            var status = _group.RollBack();
            _group.Dispose();
            _group = null;
            if (status != TransactionStatus.RolledBack) return false;
            return _createdUniqueIds.All(uniqueId => _document.GetElement(uniqueId) == null) && _externalStates.All(pair =>
            {
                var element = _document.GetElement(pair.Key);
                return element != null && DynamicAnnotationRevitStateV1.StateHash(element) == pair.Value;
            });
        }

        internal bool Commit()
        {
            if (_group == null || _finished) return false;
            _finished = true;
            var status = _group.Assimilate();
            _group.Dispose();
            _group = null;
            return status == TransactionStatus.Committed;
        }

        internal DynamicTrustedElementFactV1? LiveExternalTarget(string uniqueId)
        {
            var element = _document.GetElement(uniqueId);
            if (element == null || !element.IsValidObject) return null;
            return new DynamicTrustedElementFactV1
            {
                UniqueId = element.UniqueId, ElementId = ElementIdCompat.GetValue(element.Id),
                DocumentFingerprint = DynamicRuntimeSnapshotHandler.Fingerprint(_document), CategoryStableId = CategoryStableId(element.Category),
                TypeUniqueId = TypeUniqueId(element), StateHash = DynamicAnnotationRevitStateV1.StateHash(element),
                Exists = true, Verified = true, Visible = IsVisible(element)
            };
        }

        private DynamicCreatedResultFactV1 CreateFact(DynamicResultReferenceNodeV1 node, DynamicResultOutputDeclarationV1 declaration,
            DynamicRevitLabCreatedOutputV1 output)
        {
            var element = output.Element;
            if (element == null || !element.IsValidObject || element.Document != _document || !output.VisibilityVerified || !IsVisible(element))
                throw new InvalidOperationException("Lab output is missing, foreign, hidden, or lacks independent visibility proof.");
            var category = CategoryStableId(element.Category); var type = TypeUniqueId(element);
            if (declaration.ExpectedDocumentFingerprint != DynamicRuntimeSnapshotHandler.Fingerprint(_document) ||
                declaration.ExpectedCategoryStableId != category || declaration.ExpectedTypeUniqueId != type)
                throw new InvalidOperationException("Created Revit output document, category, or type differs from its declaration.");
            var fact = new DynamicCreatedResultFactV1
            {
                ProducerNodeId = node.NodeId, ResultId = declaration.ResultId, OutputSlot = declaration.OutputSlot,
                CreatedUniqueId = element.UniqueId, CreatedElementId = ElementIdCompat.GetValue(element.Id),
                DocumentFingerprint = declaration.ExpectedDocumentFingerprint, CategoryStableId = category, TypeUniqueId = type,
                StateHash = DynamicAnnotationRevitStateV1.StateHash(element), Status = "created_verified", Verified = true, Visible = true
            };
            fact.OutputHash = DynamicResultReferencePolicyV1.OutputHash(fact);
            return fact;
        }

        private bool IsVisible(Element element)
        {
            try { return !element.IsHidden(_application.ActiveUIDocument.ActiveView); }
            catch { return false; }
        }

        private string TypeUniqueId(Element element)
        {
            var id = element.GetTypeId();
            return id == ElementId.InvalidElementId ? "type:none" : (_document.GetElement(id)?.UniqueId ?? "type:missing");
        }

        private static string CategoryStableId(Category? category)
        {
            if (category == null) return "category:none";
            var id = ElementIdCompat.GetValue(category.Id);
            var builtIn = id < 0 && id >= int.MinValue ? Enum.GetName(typeof(BuiltInCategory), (int)id) : null;
            return builtIn == null ? "category:element:" + id.ToString(CultureInfo.InvariantCulture) : "category:builtin:" + builtIn;
        }
    }

    internal static class DynamicResultReferenceRevitLabPreviewV1
    {
        internal static DynamicResultReferenceReceiptV1 Execute(UIApplication application, DynamicResultReferenceGraphV1 graph,
            DynamicEffectBudgetV1 budget, IEnumerable<string> allowedKinds,
            IReadOnlyDictionary<string, DynamicTrustedElementFactV1> admissionTargets, IDynamicResultReferenceRevitLabExecutorV1 executor)
        {
            var host = new DynamicResultReferenceRevitTransactionalHostV1(application, executor);
            return DynamicResultReferencePreviewEngineV1.Execute(graph, budget, allowedKinds, admissionTargets, host.LiveExternalTarget, host);
        }
    }
}
