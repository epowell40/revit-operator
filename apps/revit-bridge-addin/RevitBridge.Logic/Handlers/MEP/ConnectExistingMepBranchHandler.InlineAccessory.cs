using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    public sealed partial class ConnectExistingMepBranchHandler
    {
        // Explicit bounded mode; independent current readback is separate from
        // this atomic operation's apply-local preservation guard.
        private static object HandleInlineAccessory(UIApplication app, Document doc,
            InlineAccessoryRequest p, Action enterNativeScope)
        {
            // Validate even an internal caller; no object-construction bypass of the wire contract.
            p = InlineAccessoryRequest.Parse(JsonSerializer.Serialize(p));
            GuardExpectedModelPath(doc, p.expectedModelPath);
            const double tolerance = 0.000001;
            var host = doc.GetElement(ElementIdCompat.Create(p.mainElementId)) as Duct;
            var symbol = doc.GetElement(ElementIdCompat.Create(p.accessoryTypeId)) as FamilySymbol;
            if (host == null || host.UniqueId != p.expectedMainUniqueId || host.Pinned || host.GroupId != ElementId.InvalidElementId
                || (host.Location as LocationCurve)?.Curve is not Line line || host.ReferenceLevel == null)
                throw new ArgumentException("A current, ungrouped, unpinned straight duct with exact native identity is required.");
            if (symbol == null || symbol.UniqueId != p.expectedAccessoryTypeUniqueId
                || ElementIdCompat.GetValue(symbol.Category.Id) != (long)BuiltInCategory.OST_DuctAccessory
                || symbol.Family.FamilyPlacementType != FamilyPlacementType.OneLevelBased)
                throw new ArgumentException("A loaded, unhosted level-based duct accessory type with exact native identity is required.");
            var start = line.GetEndPoint(0); var end = line.GetEndPoint(1);
            var requested = ToXyz(p.insertionPointXyz);
            if (start.DistanceTo(ToXyz(p.expectedMainStartXyz)) > tolerance || end.DistanceTo(ToXyz(p.expectedMainEndXyz)) > tolerance)
                throw new ArgumentException("The guarded existing duct endpoints changed.");
            var hostPorts = InlineRoundPorts(host);
            if (hostPorts.Any(c => PhysicalConnectorReferences(c).Count > 1)
                || Math.Abs(hostPorts[0].Radius - hostPorts[1].Radius) > tolerance)
                throw new ArgumentException("The existing duct must have exactly two round HVAC ends with at most one physical peer each.");
            var diameter = hostPorts[0].Radius * 2;
            var metadata = ReplacementMetadata(host);
            var userParameters = InlineWritableParameters(host);
            var typeParameters = InlineWritableParameters(symbol);
            var symbolWasActive = symbol.IsActive;
            var hostBefore = CapturePhysicalConnections(host);
            var remoteIds = hostBefore.Select(e => e.ConnectedOwnerId).Distinct().ToArray();
            if (remoteIds.Length > 2 || hostBefore.Any(e => !e.ConnectorId.HasValue || !e.ConnectedConnectorId.HasValue))
                throw new InvalidOperationException("Exact native IDs for the original physical peers are required.");
            var remoteBefore = remoteIds.ToDictionary(id => id, id => CapturePhysicalConnections(doc.GetElement(ElementIdCompat.Create(id))));
            if (remoteBefore.Values.SelectMany(edges => edges).Any(e => !e.ConnectorId.HasValue || !e.ConnectedConnectorId.HasValue))
                throw new InvalidOperationException("The remote graph has unavailable native connector identities.");
            var remoteState = remoteIds.ToDictionary(id => id, id => InlineOwnerState(doc.GetElement(ElementIdCompat.Create(id))));
            var scheduleIds = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>()
                .Where(v => !v.IsTemplate && !v.IsTitleblockRevisionSchedule).Select(v => ElementIdCompat.GetValue(v.Id)).ToArray();
            var scheduleBefore = JsonSerializer.Serialize(AnnotationSchedulePreservation.Read(doc, scheduleIds));
            var preservationBefore = InlineAccessoryObservation.Read(doc, new[] { p.mainElementId }.Concat(remoteIds).ToArray(),
                scheduleIds, new[] { p.accessoryTypeId });
            using (var observationJson = JsonDocument.Parse(JsonSerializer.Serialize(preservationBefore)))
                if (!observationJson.RootElement.GetProperty("complete").GetBoolean())
                    throw new InvalidOperationException("Independent preservation baseline is unavailable.");
            using (var scheduleJson = JsonDocument.Parse(scheduleBefore))
                if (!scheduleJson.RootElement.GetProperty("complete").GetBoolean())
                    throw new InvalidOperationException("Bounded existing schedule preservation is unavailable.");

            var created = new List<long>(); long? accessoryId = null, splitId = null;
            var derivedCreated = new List<long>();
            long[] provisionalAdded = Array.Empty<long>();
            InlineAccessoryGeometryPlan? plan = null;
            var failureGuard = new OperatorNativeFailureGuard();
            var childInventory = new OperatorNativeChangeInventory(doc);
            var verified = false; var rollbackVerified = false;
            object? postCommitDiagnostic = null;
            object? preservationAfter = null;
            var systemBeforeDiagnostic = ReadInlineDiagnosticSystem(host.MEPSystem);
            BranchPoint3d Point(XYZ v) => new BranchPoint3d(v.X, v.Y, v.Z);
            XYZ Xyz(BranchPoint3d v) => new XYZ(v.X, v.Y, v.Z);
            long NativeId(Connector c) => MepSystemUtil.TryGetNativeConnectorId(c, out var id) ? id
                : throw new InvalidOperationException("Stable connector IDs are unavailable.");
            Duct[] Segments() => new[] { doc.GetElement(host.Id) as Duct, splitId.HasValue ? doc.GetElement(ElementIdCompat.Create(splitId.Value)) as Duct : null }
                .Select(d => d ?? throw new InvalidOperationException("A retained split segment disappeared.")).ToArray();
            Connector EndAt(Element owner, XYZ point) => InlineRoundPorts(owner).Single(c => c.Origin.DistanceTo(point) <= tolerance);
            Duct SegmentAt(XYZ point) => Segments().Single(d => InlineRoundPorts(d).Any(c => c.Origin.DistanceTo(point) <= tolerance));
            void VerifyResult()
            {
                if (plan == null || !accessoryId.HasValue || !splitId.HasValue) throw new InvalidOperationException("Incomplete insertion state.");
                var accessory = doc.GetElement(ElementIdCompat.Create(accessoryId.Value)) as FamilyInstance
                    ?? throw new InvalidOperationException("Inserted accessory disappeared.");
                if (accessory.GetTypeId() != symbol.Id || doc.GetElement(host.Id)?.UniqueId != p.expectedMainUniqueId
                    || InlineWritableParameters(symbol) != typeParameters)
                    throw new InvalidOperationException("The original duct or requested accessory type identity changed.");
                var ports = InlineRoundPorts(accessory).OrderBy(c => c.Origin.DistanceTo(start)).ToArray();
                InlineAccessoryGeometry.RequireOpposingAxialPorts(Point(ports[0].Origin), Point(ports[1].Origin),
                    Point(ports[0].CoordinateSystem.BasisZ), Point(ports[1].CoordinateSystem.BasisZ));
                if (ports[0].Origin.DistanceTo(Xyz(plan.FirstPort)) > tolerance || ports[1].Origin.DistanceTo(Xyz(plan.SecondPort)) > tolerance
                    || ports.Any(c => Math.Abs(c.Radius * 2 - diameter) > tolerance))
                    throw new InvalidOperationException("Accessory ports moved, changed size or no longer match the planned split span.");
                var first = SegmentAt(start); var second = SegmentAt(end);
                if (first.Id == second.Id) throw new InvalidOperationException("Insertion did not retain two distinct duct segments.");
                for (var i = 0; i < 2; i++)
                {
                    var segment = i == 0 ? first : second;
                    var far = i == 0 ? start : end;
                    var port = ports[i]; var near = EndAt(segment, port.Origin);
                    var segmentRole = segment.Id == host.Id ? "retained" : "new";
                    void FailSegment(string predicate) => throw new InvalidOperationException(
                        $"Inline accessory verification failed: segment={ElementIdCompat.GetValue(segment.Id)} role={segmentRole} predicate={predicate}. Atomic rollback required.");
                    var currentMetadata = ReplacementMetadata(segment);
                    if (currentMetadata != metadata) FailSegment(InlineAccessoryMetadataDiagnostic.Describe(metadata, currentMetadata));
                    var currentParameters = InlineWritableParameters(segment);
                    if (!InlineAccessoryParameterPreservation.Matches(userParameters, currentParameters, segment.Id != host.Id))
                        FailSegment("writable_parameters; changed_ids=" + InlineAccessoryParameterPreservation.ChangedIds(userParameters, currentParameters));
                    if ((segment.Location as LocationCurve)?.Curve is not Line segmentLine) FailSegment("straight_curve");
                    else if (Math.Abs(segmentLine.Length - (i == 0 ? plan.FirstRetainedLengthFt : plan.SecondRetainedLengthFt)) > tolerance) FailSegment("split_length");
                    if (InlineRoundPorts(segment).Any(c => Math.Abs(c.Radius * 2 - diameter) > tolerance)) FailSegment("port_diameter");
                    if (!near.IsConnectedTo(port) || !port.IsConnectedTo(near)) FailSegment("reciprocal_connection");
                    if (!PhysicalConnectedOwnerIds(near).SequenceEqual(new[] { accessoryId.Value })
                        || !PhysicalConnectedOwnerIds(port).SequenceEqual(new[] { ElementIdCompat.GetValue(segment.Id) })) FailSegment("physical_peer_set");
                    var farConnector = EndAt(segment, far);
                    var expected = hostBefore.Where(e => e.Origin.DistanceTo(far) <= tolerance).ToArray();
                    var peers = PhysicalConnectorReferences(farConnector);
                    if (peers.Count != expected.Length || expected.Any(e => !peers.Any(c =>
                        ElementIdCompat.GetValue(c.Owner.Id) == e.ConnectedOwnerId && NativeId(c) == e.ConnectedConnectorId
                        && c.Origin.DistanceTo(e.ConnectedOrigin) <= tolerance && c.IsConnectedTo(farConnector))))
                        throw new InvalidOperationException("An original far peer changed or became non-reciprocal.");
                }
                foreach (var id in remoteIds)
                {
                    var owner = doc.GetElement(ElementIdCompat.Create(id)) ?? throw new InvalidOperationException("A remote owner disappeared.");
                    if (InlineOwnerState(owner) != remoteState[id]) throw new InvalidOperationException("Remote geometry or parameters changed.");
                    var current = CapturePhysicalConnections(owner);
                    var expected = remoteBefore[id];
                    if (current.Count != expected.Count) throw new InvalidOperationException("The remote graph changed cardinality.");
                    foreach (var edge in expected)
                    {
                        var expectedOwner = edge.ConnectedOwnerId == p.mainElementId
                            ? ElementIdCompat.GetValue(SegmentAt(edge.Origin).Id) : edge.ConnectedOwnerId;
                        if (!current.Any(e => e.ConnectorId == edge.ConnectorId && e.ConnectedOwnerId == expectedOwner
                            && (edge.ConnectedOwnerId == p.mainElementId || e.ConnectedConnectorId == edge.ConnectedConnectorId)
                            && e.Origin.DistanceTo(edge.Origin) <= tolerance && e.ConnectedOrigin.DistanceTo(edge.ConnectedOrigin) <= tolerance))
                            throw new InvalidOperationException("A remote graph edge changed beyond the one split-owner substitution.");
                    }
                }
                if (JsonSerializer.Serialize(AnnotationSchedulePreservation.Read(doc, scheduleIds)) != scheduleBefore)
                    throw new InvalidOperationException("An existing schedule changed; this bounded insertion cannot preserve that scope.");
            }
            void Changed(object sender, DocumentChangedEventArgs e) => childInventory.Observe(() => e.GetDocument(),
                () => e.GetAddedElementIds().Select(ElementIdCompat.GetValue), () => e.GetModifiedElementIds().Select(ElementIdCompat.GetValue),
                () => e.GetDeletedElementIds().Select(ElementIdCompat.GetValue));

            enterNativeScope();
            Dictionary<string, object?> execution;
            app.Application.DocumentChanged += Changed;
            try
            {
                execution = NativeAtomicTransactionGroup.Execute(app, doc, "Insert Inline Duct Accessory", () =>
                {
                    using (var tx = new Transaction(doc, "Fit and Connect Inline Accessory"))
                    {
                        if (tx.Start() != TransactionStatus.Started) throw new InvalidOperationException("Insertion transaction did not start.");
                        NativeNonInteractiveFailureHandling.Configure(tx, failureGuard);
                        if (!symbol.IsActive) { symbol.Activate(); doc.Regenerate(); }
                        var accessory = doc.Create.NewFamilyInstance(requested, symbol, host.ReferenceLevel, StructuralType.NonStructural)
                            ?? throw new InvalidOperationException("Revit did not create the requested accessory instance.");
                        accessoryId = ElementIdCompat.GetValue(accessory.Id); created.Add(accessoryId.Value);
                        var parameters = accessory.GetParameters(p.instanceRadiusParameter);
                        if (parameters.Count != 1 || parameters[0].IsReadOnly || parameters[0].StorageType != StorageType.Double
                            || (parameters[0].Definition.GetDataType() != SpecTypeId.Length
                                && parameters[0].Definition.GetDataType() != SpecTypeId.DuctSize))
                            throw new InvalidOperationException("The named radius must be one writable native instance length parameter.");
                        if (!parameters[0].Set(diameter / 2)) throw new InvalidOperationException("Native instance sizing was rejected.");
                        accessory.CreatedPhaseId = host.CreatedPhaseId; accessory.DemolishedPhaseId = host.DemolishedPhaseId;
                        if (doc.IsWorkshared) accessory.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM).Set((int)ElementIdCompat.GetValue(host.WorksetId));
                        doc.Regenerate();
                        var ports = InlineRoundPorts(accessory);
                        InlineAccessoryGeometry.RequireOpposingAxialPorts(Point(ports[0].Origin), Point(ports[1].Origin),
                            Point(ports[0].CoordinateSystem.BasisZ), Point(ports[1].CoordinateSystem.BasisZ));
                        if (ports.Any(c => PhysicalConnectorReferences(c).Count != 0)) throw new InvalidOperationException("New accessory unexpectedly auto-connected.");
                        plan = InlineAccessoryGeometry.Plan(Point(start), Point(end), Point(requested), ports[0].Origin.DistanceTo(ports[1].Origin),
                            diameter, ports[0].Radius * 2, ports[1].Radius * 2, doc.Application.ShortCurveTolerance);
                        var center = (ports[0].Origin + ports[1].Origin) / 2;
                        var from = (ports[1].Origin - ports[0].Origin).Normalize(); var to = Xyz(plan.Axis);
                        var angle = from.AngleTo(to);
                        if (angle > tolerance)
                        {
                            var cross = from.CrossProduct(to);
                            if (cross.GetLength() <= tolerance) cross = from.CrossProduct(Math.Abs(from.Z) < .9 ? XYZ.BasisZ : XYZ.BasisX);
                            ElementTransformUtils.RotateElement(doc, accessory.Id, Line.CreateUnbound(center, cross.Normalize()), angle);
                        }
                        ElementTransformUtils.MoveElement(doc, accessory.Id, Xyz(plan.Center) - center); doc.Regenerate();
                        var newId = MechanicalUtils.BreakCurve(doc, host.Id, Xyz(plan.Center));
                        if (newId == ElementId.InvalidElementId || newId == host.Id) throw new InvalidOperationException("Native duct split failed.");
                        splitId = ElementIdCompat.GetValue(newId); created.Add(splitId.Value); doc.Regenerate();
                        var first = SegmentAt(start); var second = SegmentAt(end);
                        void Trim(Duct duct, XYZ far, XYZ near)
                        {
                            var location = (LocationCurve)duct.Location; var old = location.Curve;
                            location.Curve = old.GetEndPoint(0).DistanceTo(far) <= tolerance ? Line.CreateBound(far, near) : Line.CreateBound(near, far);
                        }
                        Trim(first, start, Xyz(plan.FirstPort)); Trim(second, end, Xyz(plan.SecondPort)); doc.Regenerate();
                        EndAt(first, Xyz(plan.FirstPort)).ConnectTo(EndAt(accessory, Xyz(plan.FirstPort)));
                        EndAt(second, Xyz(plan.SecondPort)).ConnectTo(EndAt(accessory, Xyz(plan.SecondPort)));
                        // MEP system membership on the new split may remain null until
                        // the child transaction commits. The outer group is still
                        // provisional: verify the complete result below before it can
                        // assimilate, and roll it all back on any failed invariant.
                        doc.Regenerate();
                        if (tx.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Insertion child transaction did not commit.");
                    }
                    var changes = childInventory.CommittedReceipt();
                    provisionalAdded = changes.AddedElementIds.ToArray();
                    try
                    {
                        if (!childInventory.Exhaustive) throw new InvalidOperationException("Incomplete native change inventory.");
                        var physicalIds = new[] { p.mainElementId }.Concat(remoteIds).Concat(created).ToArray();
                        preservationAfter = InlineAccessoryObservation.Read(doc, physicalIds, scheduleIds, new[] { p.accessoryTypeId });
                        using var prior = JsonDocument.Parse(JsonSerializer.Serialize(preservationBefore));
                        using var after = JsonDocument.Parse(JsonSerializer.Serialize(preservationAfter));
                        if (!after.RootElement.GetProperty("complete").GetBoolean()) throw new InvalidOperationException("Post-commit preservation observation unavailable.");
                        var ancillary = InlineAccessoryBookkeeping.RequireTransition(prior.RootElement.GetProperty("bookkeeping"),
                            after.RootElement.GetProperty("bookkeeping"), p.mainElementId, splitId!.Value, accessoryId!.Value, physicalIds);
                        derivedCreated.AddRange(ancillary.Added);
                        var allowedModified = new HashSet<long>(remoteIds.Concat(scheduleIds).Concat(created).Concat(ancillary.Modified).Concat(new[] { p.mainElementId, p.accessoryTypeId }));
                        InlineAccessoryFootprint.RequireExpected(created.Concat(derivedCreated), changes.AddedElementIds, changes.ModifiedElementIds,
                            changes.DeletedElementIds, allowedModified);
                        VerifyResult(); verified = true;
                        }
                    catch
                    {
                        // Materialize failure evidence before rollback. A successful
                        // operation already carries its two preservation projections;
                        // do not repeat the large diagnostic inventory on that path.
                        postCommitDiagnostic = CaptureInlineDiagnostic(doc,
                            changes.AddedElementIds.Concat(changes.ModifiedElementIds).Concat(changes.DeletedElementIds).ToArray(),
                            new[] { p.mainElementId }.Concat(remoteIds).Concat(created).ToArray(), scheduleIds,
                            p.accessoryTypeId, systemBeforeDiagnostic, host.MEPSystem);
                        throw;
                    }
                    return new Dictionary<string, object?> { ["success"] = true };
                }, () => created.Concat(derivedCreated), () => new[] { p.mainElementId },
                    p.dryRun ? NativeTransactionDisposition.Rollback : NativeTransactionDisposition.Commit);
            }
            finally { app.Application.DocumentChanged -= Changed; }
            var receipt = (OperatorNativeTransactionReceipt)execution["transaction"]!;
            if (receipt.Status == "rolled_back")
            {
                try
                {
                    var restored = doc.GetElement(ElementIdCompat.Create(p.mainElementId)) as Duct;
                    rollbackVerified = restored?.UniqueId == p.expectedMainUniqueId && ReplacementMetadata(restored) == metadata
                        && InlineWritableParameters(restored) == userParameters && created.Concat(provisionalAdded).All(id => doc.GetElement(ElementIdCompat.Create(id)) == null)
                        && (restored.Location as LocationCurve)?.Curve is Line restoredLine
                        && restoredLine.GetEndPoint(0).DistanceTo(start) <= tolerance && restoredLine.GetEndPoint(1).DistanceTo(end) <= tolerance
                        && InlineRoundPorts(restored).Count == 2 && CapturePhysicalConnections(restored).Count == hostBefore.Count
                        && FindMissingPhysicalConnections(restored, hostBefore, tolerance).Count == 0
                        && remoteIds.All(id => InlineOwnerState(doc.GetElement(ElementIdCompat.Create(id))) == remoteState[id]
                            && CapturePhysicalConnections(doc.GetElement(ElementIdCompat.Create(id))).Count == remoteBefore[id].Count
                            && FindMissingPhysicalConnections(doc.GetElement(ElementIdCompat.Create(id)), remoteBefore[id], tolerance).Count == 0)
                        && symbol.IsActive == symbolWasActive && InlineWritableParameters(symbol) == typeParameters
                        && JsonSerializer.Serialize(AnnotationSchedulePreservation.Read(doc, scheduleIds)) == scheduleBefore
                        && JsonSerializer.Serialize(InlineAccessoryObservation.Read(doc, new[] { p.mainElementId }.Concat(remoteIds).ToArray(),
                            scheduleIds, new[] { p.accessoryTypeId })) == JsonSerializer.Serialize(preservationBefore);
                }
                catch { rollbackVerified = false; }
            }
            var success = execution["success"] is bool ok && ok && verified && (receipt.CommittedValue == true || p.dryRun && rollbackVerified);
            return new { success, status = success ? (p.dryRun ? "DryRunReady" : "Inserted") : "Blocked", p.connectionMode, p.kind, p.dryRun,
                mainElementId = p.mainElementId, mainUniqueId = p.expectedMainUniqueId, accessoryTypeId = p.accessoryTypeId,
                createdAccessoryId = receipt.CommittedValue == true ? accessoryId : null, createdDuctId = receipt.CommittedValue == true ? splitId : null,
                originalStart = ToPoint(start), originalEnd = ToPoint(end), diameterFt = diameter, geometryPlan = plan,
                preservationBefore, preservationAfter, postCommitDiagnostic,
                preexistingMainConnections = hostBefore.Select(DescribePhysicalConnection).ToArray(),
                preexistingRemoteConnections = remoteBefore.ToDictionary(x => x.Key.ToString(), x => x.Value.Select(DescribePhysicalConnection).ToArray()),
                previewCreatedIds = p.dryRun ? created.ToArray() : Array.Empty<long>(), applied = receipt.CommittedValue,
                transaction = receipt, changeTracking = execution["changeTracking"], rollbackVerified, postChildCommitVerified = verified,
                error = execution.TryGetValue("error", out var error) ? error : null, capturedFailures = failureGuard.Failures };
        }

        private static List<Connector> InlineRoundPorts(Element owner)
        {
            var ports = MepRoutingUtil.GetConnectors(owner);
            if (ports.Count != 2 || ports.Any(c => c.ConnectorType != ConnectorType.End || c.Domain != Domain.DomainHvac
                || c.Shape != ConnectorProfileType.Round || c.Radius <= 0 || double.IsNaN(c.Radius) || double.IsInfinity(c.Radius)))
                throw new InvalidOperationException("Exactly two finite round HVAC end connectors are required.");
            return ports;
        }
        private static string InlineWritableParameters(Element owner)
            => InlineAccessoryObservation.WritableParameters(owner);
        private static string InlineOwnerState(Element owner)
            => JsonSerializer.Serialize(InlineAccessoryObservation.State(owner));
    }
}
