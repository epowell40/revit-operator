using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    internal sealed class DynamicMepLabExecutionV1
    {
        internal IReadOnlyList<DynamicRevitLabCreatedOutputV1> Outputs { get; set; } = Array.Empty<DynamicRevitLabCreatedOutputV1>();
        internal IReadOnlyList<DynamicResultReferenceMutationReadbackV1> Readbacks { get; set; } = Array.Empty<DynamicResultReferenceMutationReadbackV1>();
        internal IReadOnlyDictionary<string, string> SemanticOutputStateHashes { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
        internal string TopologyHash { get; set; } = "";
    }

    /// <summary>Trusted, unregistered laboratory executor for the three exact MEP graph primitives.</summary>
    internal sealed class DynamicMepResultReferenceExecutorV1 : IDynamicResultReferenceRevitLabExecutorV1
    {
        private readonly UIApplication _application;
        internal DynamicMepResultReferenceExecutorV1(UIApplication application) { _application = application ?? throw new ArgumentNullException(nameof(application)); }

        public IReadOnlyList<DynamicRevitLabCreatedOutputV1> Execute(Document document, DynamicResultReferenceNodeV1 node,
            IReadOnlyList<DynamicResolvedElementTargetV1> resolvedTargets) => ExecuteWithEvidence(document, node, resolvedTargets).Outputs;

        internal DynamicMepLabExecutionV1 ExecuteWithEvidence(Document document, DynamicResultReferenceNodeV1 node,
            IReadOnlyList<DynamicResolvedElementTargetV1> resolvedTargets)
        {
            if (node.Kind == "create_mep_curve") return CreateCurve(document, node, resolvedTargets);
            if (node.Kind == "connect_mep") return Connect(document, node, resolvedTargets, false);
            if (node.Kind == "create_transition_fitting") return Connect(document, node, resolvedTargets, true);
            throw new InvalidOperationException("The laboratory MEP executor received an unknown primitive.");
        }

        private DynamicMepLabExecutionV1 CreateCurve(Document document, DynamicResultReferenceNodeV1 node,
            IReadOnlyList<DynamicResolvedElementTargetV1> resolvedTargets)
        {
            if (resolvedTargets.Count != 0 || node.Outputs.Count != 1) throw new InvalidOperationException("MEP curve shape was substituted.");
            var spec = DynamicMepCurveSpecV1.ParseCanonical(node.Attributes["curve"]);
            var level = document.GetElement(spec.LevelUniqueId) as Level ?? throw new InvalidOperationException("Exact MEP curve level is missing.");
            var systemType = document.GetElement(node.Attributes["system_type"]) ?? throw new InvalidOperationException("Exact MEP system type is missing.");
            var curveType = document.GetElement(node.Attributes["type_identity"]) ?? throw new InvalidOperationException("Exact MEP curve type is missing.");
            var start = Point(spec.StartFeet); var end = Point(spec.EndFeet); Element created;
            if (spec.CurveKind == "pipe")
            {
                if (!(systemType is PipingSystemType) || !(curveType is PipeType)) throw new InvalidOperationException("Pipe system/type identity is incompatible.");
                created = Pipe.Create(document, systemType.Id, curveType.Id, level.Id, start, end);
            }
            else
            {
                if (!(systemType is MechanicalSystemType) || !(curveType is DuctType)) throw new InvalidOperationException("Duct system/type identity is incompatible.");
                created = Duct.Create(document, systemType.Id, curveType.Id, level.Id, start, end);
            }
            document.Regenerate();
            var readback = Readback(node, "result:" + node.Outputs[0].ResultId + ":curve", AbsentHash(), ElementState(created));
            return Result(node, new[] { Output("curve", created) }, new[] { readback }, created);
        }

        private DynamicMepLabExecutionV1 Connect(Document document, DynamicResultReferenceNodeV1 node,
            IReadOnlyList<DynamicResolvedElementTargetV1> resolvedTargets, bool transition)
        {
            if (resolvedTargets.Count != 2 || node.Outputs.Count != (transition ? 1 : 0)) throw new InvalidOperationException("MEP connector operation shape was substituted.");
            var aSelector = DynamicMepConnectorSelectorV1.ParseCanonical(node.Attributes["connector_a"]);
            var bSelector = DynamicMepConnectorSelectorV1.ParseCanonical(node.Attributes["connector_b"]);
            var aTarget = ExactSelectorTarget(resolvedTargets, aSelector); var bTarget = ExactSelectorTarget(resolvedTargets, bSelector);
            if (aTarget.SourceKind == bTarget.SourceKind && aTarget.SourceIdentity == bTarget.SourceIdentity) throw new InvalidOperationException("MEP connector selectors resolved the same source.");
            var a = ResolveConnector(document, aTarget, aSelector); var b = ResolveConnector(document, bTarget, bSelector);
            if (a.Owner.Id == b.Owner.Id || a.Domain != b.Domain || a.Shape != b.Shape) throw new InvalidOperationException("MEP connectors are self, cross-domain, or cross-shape.");
            var subject = "pair:" + string.Join("|", resolvedTargets.Select(value => value.SourceKind + ":" + value.SourceIdentity).OrderBy(value => value, StringComparer.Ordinal));
            var before = PairState(a, b);
            Element? fitting = null;
            if (transition)
            {
                fitting = document.Create.NewTransitionFitting(a, b) ?? throw new InvalidOperationException("Revit did not create the exact transition fitting.");
                document.Regenerate();
                if (TypeUniqueId(document, fitting) != node.Attributes["expected_fitting_type"])
                    throw new InvalidOperationException("Routing preferences produced a different transition fitting type.");
            }
            else { a.ConnectTo(b); document.Regenerate(); }
            if (!Connected(a, b, fitting)) throw new InvalidOperationException("MEP topology readback does not prove the requested connection.");
            var after = PairState(a, b);
            var values = new Dictionary<string, string>(StringComparer.Ordinal) { ["connector_a"] = ConnectorState(a), ["connector_b"] = ConnectorState(b), ["connected"] = "1" };
            var readback = Readback(node, subject, before, after, values);
            return Result(node, fitting == null ? Array.Empty<DynamicRevitLabCreatedOutputV1>() : new[] { Output("fitting", fitting) }, new[] { readback }, a.Owner, b.Owner, fitting);
        }

        private DynamicMepLabExecutionV1 Result(DynamicResultReferenceNodeV1 node, IReadOnlyList<DynamicRevitLabCreatedOutputV1> outputs,
            IReadOnlyList<DynamicResultReferenceMutationReadbackV1> readbacks, params Element?[] topology)
        {
            return new DynamicMepLabExecutionV1 { Outputs = outputs, Readbacks = readbacks,
                SemanticOutputStateHashes = outputs.ToDictionary(value => value.OutputSlot, value => ElementState(value.Element ?? throw new InvalidOperationException("MEP output is missing.")), StringComparer.Ordinal),
                TopologyHash = DynamicWire.Sha256("mep-topology/v1\n" + string.Join("\n", topology.Where(value => value != null).Select(value => ElementState(value!)).OrderBy(value => value, StringComparer.Ordinal))) };
        }

        private DynamicRevitLabCreatedOutputV1 Output(string slot, Element element) => new DynamicRevitLabCreatedOutputV1
        {
            OutputSlot = slot, Element = element, VisibilityVerified = IsVisible(element)
        };

        private DynamicResultReferenceMutationReadbackV1 Readback(DynamicResultReferenceNodeV1 node, string subject, string before, string after,
            IReadOnlyDictionary<string, string>? values = null)
        {
            var result = new DynamicResultReferenceMutationReadbackV1 { NodeId = node.NodeId, Kind = node.Kind, SubjectIdentity = subject,
                BeforeStateHash = before, AfterStateHash = after, ExactValues = values ?? new Dictionary<string, string>(StringComparer.Ordinal) };
            result.ReadbackHash = DynamicMepMutationPolicyV1.ReadbackHash(result); return result;
        }

        private static Connector ResolveConnector(Document document, DynamicResolvedElementTargetV1 target, DynamicMepConnectorSelectorV1 selector)
        {
            if (selector.SourceIdentityHash != DynamicWire.Sha256(target.SourceIdentity)) throw new InvalidOperationException("Connector selector source identity was substituted.");
            var owner = document.GetElement(ElementIdCompat.Create(target.ElementId)) ?? throw new InvalidOperationException("MEP connector owner disappeared.");
            if (owner.UniqueId != target.UniqueId) throw new InvalidOperationException("MEP connector owner ID was recycled.");
            if (DynamicRuntimePreviewHandler.TrustedElementStateHash(owner) != target.StateHash) throw new InvalidOperationException("MEP connector owner changed after result resolution.");
            var connectors = owner is MEPCurve curve ? curve.ConnectorManager.Connectors.Cast<Connector>() :
                owner is FamilyInstance family && family.MEPModel != null ? family.MEPModel.ConnectorManager.Connectors.Cast<Connector>() : Enumerable.Empty<Connector>();
            var expected = Point(selector.ExpectedOriginFeet);
            var matches = connectors.Where(value => value.Domain.ToString() == selector.ExpectedDomain && value.Shape.ToString() == selector.ExpectedShape && value.Origin.DistanceTo(expected) <= 1e-7)
                .Where(value => selector.NativeConnectorId == "endpoint" || NativeConnectorId(value) == selector.NativeConnectorId).ToArray();
            if (matches.Length != 1) throw new InvalidOperationException("MEP connector selector did not resolve exactly once.");
            return matches[0];
        }
        private static DynamicResolvedElementTargetV1 ExactSelectorTarget(IReadOnlyList<DynamicResolvedElementTargetV1> targets, DynamicMepConnectorSelectorV1 selector)
        {
            var matches = targets.Where(value => selector.SourceIdentityHash == DynamicWire.Sha256(value.SourceIdentity)).ToArray();
            if (matches.Length != 1) throw new InvalidOperationException("Connector selector source identity did not resolve exactly once.");
            return matches[0];
        }

        private static bool Connected(Connector a, Connector b, Element? fitting)
        {
            if (fitting == null) return a.IsConnectedTo(b) && b.IsConnectedTo(a);
            var fittingIds = (fitting as FamilyInstance)?.MEPModel?.ConnectorManager?.Connectors.Cast<Connector>()
                .SelectMany(value => value.AllRefs.Cast<Connector>()).Select(value => value.Owner.Id).ToArray() ?? Array.Empty<ElementId>();
            return fittingIds.Contains(a.Owner.Id) && fittingIds.Contains(b.Owner.Id);
        }

        private static string PairState(Connector a, Connector b) => DynamicWire.Sha256("mep-pair/v1\n" + string.Join("\n", new[] { ConnectorState(a), ConnectorState(b) }.OrderBy(value => value, StringComparer.Ordinal)));
        private static string ConnectorState(Connector value) => DynamicWire.Sha256(string.Join("\n", new[] { "mep-connector-state/v1", value.Domain.ToString(), value.Shape.ToString(),
            PointText(value.Origin), value.Shape == ConnectorProfileType.Round ? DynamicCoreOperationCanonicalNumberV1.Format(value.Radius) : "not-round",
            value.Shape == ConnectorProfileType.Round ? "not-width" : DynamicCoreOperationCanonicalNumberV1.Format(value.Width),
            value.Shape == ConnectorProfileType.Round ? "not-height" : DynamicCoreOperationCanonicalNumberV1.Format(value.Height), value.IsConnected ? "1" : "0" }));
        private static string ElementState(Element value) => DynamicWire.Sha256("mep-element-state/v1\n" + CategoryId(value.Category) + "\n" + TypeUniqueId(value.Document, value) + "\n" +
            (value.Location is LocationCurve location ? PointText(location.Curve.GetEndPoint(0)) + "\n" + PointText(location.Curve.GetEndPoint(1)) : "non-curve") + "\n" + ConnectorSetState(value));
        internal static string SemanticState(Element value) => ElementState(value);
        private static string ConnectorSetState(Element element)
        {
            ConnectorSet? set = element is MEPCurve curve ? curve.ConnectorManager?.Connectors : element is FamilyInstance family ? family.MEPModel?.ConnectorManager?.Connectors : null;
            if (set == null) return "none"; return string.Join("\n", set.Cast<Connector>().Select(ConnectorState).OrderBy(value => value, StringComparer.Ordinal));
        }
        private static string TypeUniqueId(Document document, Element element) { var id = element.GetTypeId(); return id == ElementId.InvalidElementId ? "type:none" : document.GetElement(id)?.UniqueId ?? "type:missing"; }
        private static string CategoryId(Category? category) { if (category == null) return "category:none"; var id = ElementIdCompat.GetValue(category.Id); var name = id < 0 ? Enum.GetName(typeof(BuiltInCategory), (int)id) : null; return name == null ? "category:element:" + id.ToString(CultureInfo.InvariantCulture) : "category:builtin:" + name; }
        private static string NativeConnectorId(Connector connector) { try { var property = connector.GetType().GetProperty("Id"); return Convert.ToString(property?.GetValue(connector), CultureInfo.InvariantCulture) ?? ""; } catch { return ""; } }
        private static string AbsentHash() => DynamicWire.Sha256("absent/v1");
        private bool IsVisible(Element element) { try { return !element.IsHidden(_application.ActiveUIDocument.ActiveView); } catch { return false; } }
        private static XYZ Point(DynamicPointV1 value) => new XYZ(value.X, value.Y, value.Z);
        private static string PointText(XYZ value) => string.Join(",", DynamicCoreOperationCanonicalNumberV1.Format(value.X), DynamicCoreOperationCanonicalNumberV1.Format(value.Y), DynamicCoreOperationCanonicalNumberV1.Format(value.Z));
    }
}
