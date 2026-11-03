using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.MEP;

namespace RevitBridge.Logic
{
    /// <summary>Read-only connected-system and prescribed-parameter observation.
    /// No mutation, fit verdict, ID-retention heuristic or hidden-state claim.</summary>
    public static class NativeInteractiveAccessoryObservation
    {
        public sealed class Scope
        {
            public NativeInteractiveAccessoryRequest.HostIdentity[] HostIdentities { get; set; }
                = Array.Empty<NativeInteractiveAccessoryRequest.HostIdentity>();
            public long[] PhysicalIds { get; set; } = Array.Empty<long>();
            public long[] SystemIds { get; set; } = Array.Empty<long>();
            public long[] ScheduleIds { get; set; } = Array.Empty<long>();
            public long TypeId { get; set; }
            public object Before { get; set; } = new { };
        }
        private static long Id(Element element) => ElementIdCompat.GetValue(element.Id);
        private static object FlowObservation(Func<double> read)
        {
            try
            {
                var value = read();
                if (double.IsNaN(value) || double.IsInfinity(value)) throw new InvalidOperationException("Nonfinite calculated flow.");
                return new { status = "observed", value, units = "cubic_feet_per_second", meaning = "calculated_output_not_prescribed_input" };
            }
            catch (Exception ex) { return new { status = "unavailable", reason = ex.GetType().Name + ": " + ex.Message }; }
        }
        private static Element Require(Document doc, long id) => doc.GetElement(ElementIdCompat.Create(id))
            ?? throw new InvalidOperationException("A scoped native element is missing: " + id);
        private static Connector[] Ports(Element owner)
        {
            var manager = (owner as MEPCurve)?.ConnectorManager ?? (owner as FamilyInstance)?.MEPModel?.ConnectorManager;
            return manager == null ? Array.Empty<Connector>() : manager.Connectors.Cast<Connector>()
                .Where(c => c.ConnectorType == ConnectorType.End || c.ConnectorType == ConnectorType.Curve).ToArray();
        }
        private static Element[] Network(MEPSystem system) => system switch
        {
            MechanicalSystem duct => duct.DuctNetwork.Cast<Element>().ToArray(),
            PipingSystem pipe => pipe.PipingNetwork.Cast<Element>().ToArray(),
            _ => throw new InvalidOperationException("Unsupported native system class.")
        };
        private static long[] Ids(IEnumerable<long> values, int maximum)
        {
            var ids = values.Distinct().OrderBy(x => x).ToArray();
            if (ids.Length > maximum || ids.Any(x => x <= 0)) throw new InvalidOperationException("Native observation scope exceeds its bound.");
            return ids;
        }
        public static Scope Before(UIApplication app, NativeInteractiveAccessoryRequest request, FamilySymbol symbol)
        {
            var doc = app.ActiveUIDocument.Document;
            var pipe = ElementIdCompat.GetValue(symbol.Category.Id) == (long)BuiltInCategory.OST_PipeAccessory;
            var hosts = request.targetHosts.Select(h => {
                var e = Require(doc, h.elementId);
                if (e.UniqueId != h.uniqueId || (pipe ? e is not Pipe : e is not Duct)
                    || (e.Location as LocationCurve)?.Curve is not Line || e.Pinned || e.GroupId != ElementId.InvalidElementId)
                    throw new ArgumentException("A target must remain the exact unpinned, ungrouped straight duct/pipe identity.");
                return (MEPCurve)e;
            }).ToArray();
            var systemIds = Ids(hosts.Select(h => h.MEPSystem).Where(s => s != null).Select(Id), 50);
            var owners = new HashSet<long>(hosts.Select(Id));
            foreach (var host in hosts)
                foreach (var port in Ports(host))
                    foreach (Connector peer in port.AllRefs)
                        if (peer.Owner.Id != host.Id && (peer.ConnectorType == ConnectorType.End || peer.ConnectorType == ConnectorType.Curve)
                            && port.IsConnectedTo(peer)) owners.Add(Id(peer.Owner));
            foreach (var id in systemIds)
            {
                var system = (MEPSystem)Require(doc, id);
                foreach (var e in Network(system).Concat(system.Elements.Cast<Element>()))
                    if (Ports(e).Length > 0) owners.Add(Id(e));
                if (system.BaseEquipment != null && Ports(system.BaseEquipment).Length > 0) owners.Add(Id(system.BaseEquipment));
            }
            var scope = new Scope { HostIdentities = hosts.Select(h => new NativeInteractiveAccessoryRequest.HostIdentity
                { elementId=Id(h),uniqueId=h.UniqueId }).ToArray(),
                PhysicalIds = Ids(owners, 5000), SystemIds = systemIds, TypeId = Id(symbol),
                ScheduleIds = Ids(new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>()
                    .Where(s => !s.IsTemplate && !s.IsTitleblockRevisionSchedule).Select(Id), 32) };
            scope.Before = ReadConnectors(app, scope.PhysicalIds, scope);
            RequireComplete(scope.Before);
            return scope;
        }
        public static object After(UIApplication app, Scope scope, OperatorNativeTransactionReceipt receipt)
        {
            var doc = app.ActiveUIDocument.Document;
            var added = receipt.AddedElementIds.Select(id => Require(doc, id)).Where(e => Ports(e).Length > 0).Select(Id);
            return ReadConnectors(app, Ids(scope.PhysicalIds.Concat(added), 5000), scope, Ids(receipt.AffectedElementIds, 1024));
        }
        private static object ReadConnectors(UIApplication app, long[] ids, Scope scope, long[]? changed = null)
            => new GetConnectorsHandler().HandleUnpacked(app, JsonSerializer.Serialize(new {
                elementIds = ids, includeNativePlacementState = true, placementTypeIds = new[] { scope.TypeId },
                placementSystemIds = scope.SystemIds, preservationScheduleIds = scope.ScheduleIds,
                placementChangedIds = changed ?? Array.Empty<long>(),
                includeAllRefs = true, includeCoordinateSystem = true, includeFlexGeometry = true,
                onlyOpenPhysicalConnectors = false, maxConnectorsPerElement = 512
            })).GetAwaiter().GetResult();
        private static void RequireComplete(object value)
        {
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(value));
            var root = json.RootElement;
            if (root.GetProperty("failedElementCount").GetInt32() != 0 || root.GetProperty("unknownPhysicalConnectorCount").GetInt32() != 0
                || root.GetProperty("connectorScanTruncatedElementCount").GetInt32() != 0
                || !root.GetProperty("nativePlacementState").GetProperty("complete").GetBoolean())
                throw new InvalidOperationException("Native insertion preservation baseline is incomplete.");
        }
        private static object FlowDisplayBindings(Document doc, Element[] owners)
        {
            var terminals = owners.Where(e => e.Category != null && ElementIdCompat.GetValue(e.Category.Id) == (long)BuiltInCategory.OST_DuctTerminal)
                .Select(Id).OrderBy(id => id).ToArray();
            var tags = new FilteredElementCollector(doc).OfClass(typeof(IndependentTag)).Cast<IndependentTag>().OrderBy(Id).ToArray();
            if (tags.Length > 10000) throw new InvalidOperationException("Tag display observation exceeds bound.");
            var rows = new List<object>();
            foreach (var tag in tags)
            {
                var targets = tag.GetTaggedLocalElementIds().Select(ElementIdCompat.GetValue).OrderBy(id => id).ToArray();
                if (targets.Length > 512) throw new InvalidOperationException("Tag reference observation exceeds bound.");
                if (!targets.Any(id => terminals.Contains(id))) continue;
                rows.Add(new { elementId = Id(tag), uniqueId = tag.UniqueId, typeId = ElementIdCompat.GetValue(tag.GetTypeId()),
                    ownerViewId = ElementIdCompat.GetValue(tag.OwnerViewId), targetIds = targets, text = tag.TagText });
            }
            return new { schema = "operator.native_terminal_tag_display.v1", complete = true, terminalIds = terminals,
                tags = rows, scope = "host_scoped_terminal_tag_references_and_actual_text; not_visual_readability" };
        }
        public static object ReadState(Document doc, IReadOnlyList<long> physicalIds, IReadOnlyList<long> systemIds,
            IReadOnlyList<long> scheduleIds, IReadOnlyList<long> additionalTypes, IReadOnlyList<long> changedIds)
        {
            var stage = "request";
            long? observedElementId = null;
            T Observe<T>(string next, long? id, Func<T> read)
            {
                stage = next; observedElementId = id;
                return read();
            }
            try
            {
                var owners = physicalIds.Select(id => Observe("owners", id, () => Require(doc, id))).OrderBy(Id).ToArray();
                var types = Observe("types", null, () => Ids(owners.Select(e => ElementIdCompat.GetValue(e.GetTypeId())).Concat(additionalTypes), 5001)
                    .Select(id => Require(doc, id)).ToArray());
                var schedules = Observe("schedules", null, () => AnnotationSchedulePreservation.Read(doc, scheduleIds));
                using (var check = JsonDocument.Parse(JsonSerializer.Serialize(schedules)))
                    if (!check.RootElement.GetProperty("complete").GetBoolean()) throw new InvalidOperationException("Schedule observation incomplete.");
                var systems = systemIds.Select(id => {
                    stage = "system_identity"; observedElementId = id;
                    var system = Require(doc, id) as MEPSystem ?? throw new InvalidOperationException("System identity changed.");
                    var type = Require(doc, ElementIdCompat.GetValue(system.GetTypeId()));
                    object[] Identity(IEnumerable<Element> elements) => elements.OrderBy(Id).Select(e => (object)new { elementId = Id(e), uniqueId = e.UniqueId }).ToArray();
                    var members = Observe("system_members", id, () => system.Elements.Cast<Element>().ToArray());
                    var network = Observe("system_network", id, () => Network(system));
                    if (members.Length > 5000 || network.Length > 5000) throw new InvalidOperationException("Native system membership exceeds bound.");
                    return new { elementId = id, uniqueId = system.UniqueId, className = system.GetType().FullName,
                        typeId = Id(type), typeUniqueId = type.UniqueId, parameters = Observe("system_parameters", id, () => InlineAccessoryObservation.WritableParameters(system)),
                        typeParameters = Observe("type_parameters", Id(type), () => InlineAccessoryObservation.WritableParameters(type)), members = Identity(members), network = Identity(network),
                        baseEquipmentId = system.BaseEquipment == null ? (long?)null : Id(system.BaseEquipment),
                        calculatedFlow = FlowObservation(() => system is MechanicalSystem mechanical ? mechanical.GetFlow()
                            : ((PipingSystem)system).GetFlow()) };
                }).ToArray();
                var dependents = new Dictionary<long, object>();
                foreach (var parent in owners)
                {
                    var ids = Observe("placement_dependents", Id(parent), () => parent.GetDependentElements(null).Select(ElementIdCompat.GetValue).ToArray());
                    if (ids.Length > 512) throw new InvalidOperationException("Dependent native scope exceeds bound.");
                    foreach (var id in ids.Where(id => !physicalIds.Contains(id)))
                    {
                        var e = Require(doc, id);
                        // Retain each exact parent relation. No class/category grants an exemption.
                        var key = Id(e);
                        if (!dependents.ContainsKey(key)) dependents[key] = Observe("placement_metadata", key, () => InlineAccessoryBookkeepingObservation.ReadPlacementMetadata(doc, key));
                    }
                }
                if (dependents.Count > 10000) throw new InvalidOperationException("Dependent observation exceeds bound.");
                // Revit may report its System Browser modified after native MEP
                // insertion. Capture its bounded public state BEFORE insertion
                // as well as at commit/readback; never exempt all changed Views.
                var browserViews = Observe("system_browser_inventory", null, () => new FilteredElementCollector(doc)
                    .OfClass(typeof(View)).Cast<View>().Where(v => v.ViewType == ViewType.SystemBrowser).Take(9).OrderBy(Id).ToArray());
                if (browserViews.Length > 8) throw new InvalidOperationException("System Browser observation exceeds bound.");
                var systemBrowserViews = NativeSystemBrowserObservation.Capture(browserViews, v => Observe("system_browser_state", Id(v), () => new {
                        elementId = Id(v), uniqueId = v.UniqueId, viewType = v.ViewType.ToString(), name = v.Name, isTemplate = v.IsTemplate,
                        metadata = InlineAccessoryBookkeepingObservation.ReadPlacementMetadata(doc, Id(v)) }));
                return new { schema = "operator.native_accessory_placement_state.v1", complete = true,
                    systemBrowserViews,
                    requestedElementIds = physicalIds, requestedSystemIds = systemIds, requestedTypeIds = additionalTypes,
                    requestedChangedIds = changedIds, affected = changedIds.Select(id => Observe("placement_metadata", id, () => InlineAccessoryBookkeepingObservation.ReadPlacementMetadata(doc, id))).ToArray(),
                    internalBookkeeping = Observe("internal_scan", null, () => InlineAccessoryBookkeepingObservation.ReadInternalCandidates(doc, value => stage = value, id => observedElementId = id,
                        retainUnavailableParameterLayout: true, classifyUnqualifiedDependencies: true)),
                    flowDisplayBindings = Observe("flow_display_bindings", null, () => FlowDisplayBindings(doc, owners)),
                    owners = owners.Select(e => new { elementId = Id(e), uniqueId = e.UniqueId, typeId = ElementIdCompat.GetValue(e.GetTypeId()),
                        state = Observe("owner_state", Id(e), () => State(e)), parameters = Observe("placement_owner_parameters", Id(e), () => InlineAccessoryBookkeepingObservation.ReadPlacementParameters(e)),
                        calculatedConnectorFlows = Observe("placement_calculated_flows", Id(e), () => Ports(e).Select(c => new {
                            connectorId = MepSystemUtil.TryGetNativeConnectorId(c, out var cid) ? cid : throw new InvalidOperationException("Connector identity unavailable."),
                            observation = FlowObservation(() => c.Flow) }).OrderBy(c => c.connectorId).ToArray()),
                        assignedConnectorFlows = Observe("placement_assigned_flows", Id(e), () => Ports(e).Select(c => new {
                            connectorId = MepSystemUtil.TryGetNativeConnectorId(c, out var cid) ? cid : throw new InvalidOperationException("Connector identity unavailable."),
                            observation = NativeConnectorFlowObservation.Read(c.Domain.ToString(), () => c.AssignedFlow,
                                () => c.Domain == Domain.DomainHvac ? c.AssignedDuctFlowConfiguration.ToString() : c.AssignedPipeFlowConfiguration.ToString(),
                                () => c.AssignedFlowDirection.ToString()) }).OrderBy(c => c.connectorId).ToArray()),
                        dependentIds = Observe("placement_dependents", Id(e), () => e.GetDependentElements(null).Select(ElementIdCompat.GetValue).OrderBy(id => id).ToArray()) }).ToArray(),
                    types = types.Select(e => new { elementId = Id(e), uniqueId = e.UniqueId, parameters = Observe("type_parameters", Id(e), () => InlineAccessoryObservation.WritableParameters(e)) }).ToArray(),
                    systems, dependents = dependents.OrderBy(p => p.Key).Select(p => p.Value).ToArray(), schedulePreservation = schedules,
                    scope = "native_physical_topology_and_prescribed_parameters; calculated_flow_values_are_observations_not_unchanged_inputs",
                    flowSemantics = "Assigned connector inputs and calculated outputs are separate native observations. Preserve assigned inputs; retain and report calculated differences. A physical/input comparison does not verify displayed tag CFM, visual correctness, hydraulic performance or engineering design. Never copy calculated values into assigned inputs merely to make readback match." };
            }
            catch (Exception ex) { return InlineAccessoryObservationDiagnostic.PlacementFailure(ex, stage, observedElementId); }
        }
        private static object State(Element e)
        {
            if (e is not FlexPipe pipe) return InlineAccessoryObservation.State(e);
            // Same native semantic fields as the existing duct/family projection;
            // flex pipe points are read only, never assigned or rebuilt.
            return new { e.UniqueId, metadata = new { type = ElementIdCompat.GetValue(e.GetTypeId()), phase = ElementIdCompat.GetValue(e.CreatedPhaseId),
                demolished = ElementIdCompat.GetValue(e.DemolishedPhaseId), workset = ElementIdCompat.GetValue(e.WorksetId),
                systemType = pipe.MEPSystem == null ? (long?)null : ElementIdCompat.GetValue(pipe.MEPSystem.GetTypeId()),
                level = pipe.ReferenceLevel == null ? (long?)null : ElementIdCompat.GetValue(pipe.ReferenceLevel.Id), diameter = (double?)null },
                parameters = InlineAccessoryObservation.WritableParameters(e), geometryKind = "FlexPipe",
                points = pipe.Points.Select(p => new[] { p.X, p.Y, p.Z }).ToArray(),
                ports = Ports(e).Select(c => new { id = MepSystemUtil.TryGetNativeConnectorId(c, out var id) ? id : throw new InvalidOperationException("Connector ID unavailable."),
                    origin = new[] { c.Origin.X, c.Origin.Y, c.Origin.Z }, direction = new[] { c.CoordinateSystem.BasisZ.X, c.CoordinateSystem.BasisZ.Y, c.CoordinateSystem.BasisZ.Z },
                    shape = c.Shape.ToString() }).OrderBy(c => c.id).ToArray() };
        }
    }
}
