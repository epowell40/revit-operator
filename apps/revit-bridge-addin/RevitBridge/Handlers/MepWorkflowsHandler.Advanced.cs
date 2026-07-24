using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;

namespace RevitBridge.Handlers
{
    public sealed partial class MepWorkflowsHandler
    {
        private static object ConnectElementsWithDuct(UIApplication app, Document doc, Params p, string intent)
        {
            if (string.Equals(intent, "flex", StringComparison.OrdinalIgnoreCase))
                return ConnectElementsWithNativeFlex(doc, p);

            var dryRun = p.dryRun ?? false;
            var startId = p.startElementId.GetValueOrDefault(0);
            var endId = p.endElementId.GetValueOrDefault(0);
            if (startId <= 0 || endId <= 0)
            {
                var ids = (p.sourceElementIds ?? new List<long>()).Where(x => x > 0).Distinct().ToList();
                if (startId <= 0 && ids.Count > 0) startId = ids[0];
                if (endId <= 0 && ids.Count > 1) endId = ids[1];
            }

            if (startId <= 0 || endId <= 0)
                throw new InvalidOperationException("connect_elements_with_* requires startElementId and endElementId (or two sourceElementIds).");

            var start = doc.GetElement(ElementIdCompat.Create(startId));
            var end = doc.GetElement(ElementIdCompat.Create(endId));
            if (start == null || end == null) throw new InvalidOperationException("Start or end element not found.");

            var hasConnectorPair = TryResolveClosestConnectorPair(start, end, out var startConnector, out var endConnector, out var connectorSummary);
            var startPoint = startConnector?.Origin ?? ResolveElementPoint(start);
            var endPoint = endConnector?.Origin ?? ResolveElementPoint(end);
            if (startPoint == null || endPoint == null)
                throw new InvalidOperationException("Unable to resolve connector/point locations for start/end elements.");

            var length = startPoint.DistanceTo(endPoint);
            var maxLen = p.maxLengthFeet.GetValueOrDefault(0.0);
            var lengthExceeded = maxLen > 0 && length > maxLen;
            var requestedDuctSize = (p.ductSize ?? "").Trim();

            var systemType = ResolveSystemType(doc, (p.systemTypeName ?? "").Trim()) ?? ResolveDefaultMechanicalSystemType(doc);
            var ductType = ResolveDuctType(doc, p.ductTypeName) ?? ResolveDefaultDuctType(doc);
            var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().ToList();
            var level = ResolveLevel(doc, p.levelId, p.levelName) ?? ResolveNearestLevel(levels, (startPoint.Z + endPoint.Z) * 0.5) ?? levels.FirstOrDefault();
            if (systemType == null || ductType == null || level == null)
                throw new InvalidOperationException("Unable to resolve system type, duct type, or level for duct creation.");

            if (dryRun)
            {
                return new
                {
                    status = "Dry Run",
                    action = $"connect_elements_with_{intent}",
                    dryRun = true,
                    intent,
                    startElementId = startId,
                    endElementId = endId,
                    connectorSummary,
                    geometry = new
                    {
                        start = new[] { startPoint.X, startPoint.Y, startPoint.Z },
                        end = new[] { endPoint.X, endPoint.Y, endPoint.Z },
                        distanceFeet = length
                    },
                    limits = new
                    {
                        maxLengthFeet = maxLen > 0 ? maxLen : (double?)null,
                        exceedsMaxLength = lengthExceeded
                    },
                    selected = new
                    {
                        systemType = new { id = ElementIdCompat.GetValue(systemType.Id), name = systemType.Name },
                        ductType = new { id = ElementIdCompat.GetValue(ductType.Id), name = ductType.Name },
                        level = new { id = ElementIdCompat.GetValue(level.Id), name = level.Name }
                    },
                    requestedDuctSize = requestedDuctSize.Length == 0 ? null : requestedDuctSize,
                    warnings = BuildIntentWarnings(intent, p.maxElbowsPerBranch, lengthExceeded)
                };
            }

            if (lengthExceeded)
                throw new InvalidOperationException($"Connection length {length:F3}ft exceeds maxLengthFeet {maxLen:F3}.");

            Duct? created = null;
            var connectWarnings = new List<string>();
            object? sizeWrite = null;

            using (var tx = new Transaction(doc, "MEP Workflows - Connect Elements With Duct"))
            {
                tx.Start();

                created = Duct.Create(doc, systemType.Id, ductType.Id, level.Id, startPoint, endPoint);
                doc.Regenerate();
                if (created != null && requestedDuctSize.Length > 0)
                {
                    sizeWrite = TryApplyDuctSize(doc, created, requestedDuctSize);
                }

                if (created != null && hasConnectorPair && startConnector != null && endConnector != null)
                {
                    var createdConnectors = GetElementConnectors(created);
                    var nearStart = FindClosestConnector(createdConnectors, startPoint);
                    var nearEnd = FindClosestConnector(createdConnectors, endPoint);
                    if (!TryConnectTo(startConnector, nearStart, out var e1) && !string.IsNullOrWhiteSpace(e1)) connectWarnings.Add($"Start connect warning: {e1}");
                    if (!TryConnectTo(endConnector, nearEnd, out var e2) && !string.IsNullOrWhiteSpace(e2)) connectWarnings.Add($"End connect warning: {e2}");
                }

                tx.Commit();
            }

            var connectedByTrace = IsConnectedByTrace(app, startId, endId);
            var warnings = BuildIntentWarnings(intent, p.maxElbowsPerBranch, false);
            if (!connectedByTrace) warnings.Add("Trace verification did not find end element in connected network from start element.");
            warnings.AddRange(connectWarnings);

            return new
            {
                status = "Applied",
                action = $"connect_elements_with_{intent}",
                intent,
                startElementId = startId,
                endElementId = endId,
                ductId = created == null ? (long?)null : ElementIdCompat.GetValue(created.Id),
                connectedByTrace,
                connectorSummary,
                requestedDuctSize = requestedDuctSize.Length == 0 ? null : requestedDuctSize,
                sizeWrite,
                geometry = new
                {
                    start = new[] { startPoint.X, startPoint.Y, startPoint.Z },
                    end = new[] { endPoint.X, endPoint.Y, endPoint.Z },
                    distanceFeet = length
                },
                warnings
            };
        }

        private static object ConnectElementsWithNativeFlex(Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var verify = p.verify ?? true;
            var startId = p.startElementId.GetValueOrDefault(0);
            var endId = p.endElementId.GetValueOrDefault(0);
            if (startId <= 0 || endId <= 0)
            {
                var ids = (p.sourceElementIds ?? new List<long>()).Where(x => x > 0).Distinct().ToList();
                if (startId <= 0 && ids.Count > 0) startId = ids[0];
                if (endId <= 0 && ids.Count > 1) endId = ids[1];
            }

            if (startId <= 0 || endId <= 0)
                throw new InvalidOperationException("connect_elements_with_flex requires startElementId and endElementId (or two sourceElementIds).");

            var start = doc.GetElement(ElementIdCompat.Create(startId))
                ?? throw new InvalidOperationException($"Start element {startId} was not found.");
            var end = doc.GetElement(ElementIdCompat.Create(endId))
                ?? throw new InvalidOperationException($"End element {endId} was not found.");

            if (!TryResolveClosestConnectorPair(start, end, out var startConnector, out var endConnector, out var connectorSummary) ||
                startConnector == null ||
                endConnector == null)
            {
                throw new InvalidOperationException("Unable to resolve one connector on each flex endpoint element.");
            }

            if (startConnector.Domain != Domain.DomainHvac || endConnector.Domain != Domain.DomainHvac)
                throw new InvalidOperationException("Native flex duct endpoints must both be HVAC connectors.");
            if (startConnector.Shape != ConnectorProfileType.Round || endConnector.Shape != ConnectorProfileType.Round)
                throw new InvalidOperationException("Native flex duct endpoints must both be round connectors.");

            var connectorDiameterFt = startConnector.Radius * 2.0;
            var endDiameterFt = endConnector.Radius * 2.0;
            if (Math.Abs(connectorDiameterFt - endDiameterFt) > 1e-4)
            {
                throw new InvalidOperationException(
                    $"Native flex duct endpoint diameters do not match ({connectorDiameterFt:G9}ft vs {endDiameterFt:G9}ft).");
            }

            var requestedSize = (p.ductSize ?? "").Trim();
            var diameterFt = connectorDiameterFt;
            if (requestedSize.Length > 0)
            {
                if (!LengthTextUtil.TryParseLengthToFeet(doc, requestedSize, out diameterFt, out var sizeError) || diameterFt <= 0)
                    throw new InvalidOperationException($"Invalid flex duct size '{requestedSize}'. {sizeError}");
                if (Math.Abs(diameterFt - connectorDiameterFt) > 1e-4 ||
                    Math.Abs(diameterFt - endDiameterFt) > 1e-4)
                {
                    throw new InvalidOperationException(
                        $"Requested flex duct size {diameterFt:G9}ft does not match both native endpoint connector diameters.");
                }
            }

            var systemType = ResolveSystemType(doc, (p.systemTypeName ?? "").Trim()) ?? ResolveDefaultMechanicalSystemType(doc)
                ?? throw new InvalidOperationException("Unable to resolve a mechanical system type for native flex duct creation.");
            var level = ResolveLevel(doc, p.levelId, p.levelName) ??
                ResolveNearestLevel(
                    new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().ToList(),
                    (startConnector.Origin.Z + endConnector.Origin.Z) * 0.5) ??
                throw new InvalidOperationException("Unable to resolve a level for native flex duct creation.");
            var flexType = ResolveFlexDuctType(doc, p.flexDuctTypeId, p.flexDuctTypeName)
                ?? throw new InvalidOperationException("Unable to resolve the requested native flex duct type.");
            var workset = ResolveFlexWorkset(doc, p.worksetId, p.worksetName);

            var points = (p.flexPoints ?? new List<FlexRoutePoint>())
                .Where(x => x != null)
                .Select(x => new XYZ(x.x, x.y, x.z))
                .Where(IsFinitePoint)
                .ToList();
            if (points.Count == 0)
            {
                points.Add(startConnector.Origin);
                points.Add(endConnector.Origin);
            }
            else
            {
                if (points[0].DistanceTo(startConnector.Origin) > 1e-6)
                    points.Insert(0, startConnector.Origin);
                else
                    points[0] = startConnector.Origin;

                if (points[points.Count - 1].DistanceTo(endConnector.Origin) > 1e-6)
                    points.Add(endConnector.Origin);
                else
                    points[points.Count - 1] = endConnector.Origin;
            }

            points = RemoveAdjacentDuplicatePoints(points, 1e-5);
            if (points.Count < 2)
                throw new InvalidOperationException("Native flex duct creation requires at least two distinct points.");

            var maxLength = p.maxLengthFeet.GetValueOrDefault(0.0);
            var controlPolylineLength = 0.0;
            for (var i = 1; i < points.Count; i++)
                controlPolylineLength += points[i - 1].DistanceTo(points[i]);
            if (maxLength > 0 && controlPolylineLength > maxLength)
            {
                throw new InvalidOperationException(
                    $"Flex control polyline length {controlPolylineLength:F3}ft exceeds maxLengthFeet {maxLength:F3}.");
            }

            long transientOrCreatedId = 0;
            object? diameterWrite = null;
            object? worksetWrite = null;
            List<double[]> nativePoints = new List<double[]>();
            double nativeDiameterFt = 0.0;
            bool startConnected = false;
            bool endConnected = false;
            int createdConnectorCount = 0;
            var warnings = new List<string>();

            using (var tx = new Transaction(doc, dryRun ? "MEP Workflows - Native Flex Duct (Dry Run)" : "MEP Workflows - Native Flex Duct"))
            {
                tx.Start();
                try
                {
                    var flex = FlexDuct.Create(doc, systemType.Id, flexType.Id, level.Id, points);
                    transientOrCreatedId = ElementIdCompat.GetValue(flex.Id);

                    var diameterParameter = flex.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM)
                        ?? flex.LookupParameter("Diameter")
                        ?? flex.LookupParameter("Duct Diameter");
                    if (diameterParameter == null || diameterParameter.IsReadOnly)
                        throw new InvalidOperationException($"Flex duct {transientOrCreatedId} has no writable diameter parameter.");
                    var diameterBefore = ParameterValueUtil.SnapshotForWire(diameterParameter);
                    diameterParameter.Set(diameterFt);
                    var diameterAfter = ParameterValueUtil.SnapshotForWire(diameterParameter);
                    diameterWrite = new { requestedDiameterFt = diameterFt, before = diameterBefore, after = diameterAfter };

                    if (workset != null)
                    {
                        var worksetParameter = flex.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM)
                            ?? throw new InvalidOperationException($"Flex duct {transientOrCreatedId} does not expose ELEM_PARTITION_PARAM.");
                        if (worksetParameter.IsReadOnly)
                            throw new InvalidOperationException($"Flex duct {transientOrCreatedId} workset parameter is read-only.");
                        worksetParameter.Set(workset.Id.IntegerValue);
                        var readbackWorksetId = worksetParameter.AsInteger();
                        if (readbackWorksetId != workset.Id.IntegerValue)
                            throw new InvalidOperationException($"Flex duct {transientOrCreatedId} workset readback did not match the requested workset.");
                        worksetWrite = new
                        {
                            requestedWorksetId = workset.Id.IntegerValue,
                            requestedWorksetName = workset.Name,
                            readbackWorksetId,
                            verified = true
                        };
                    }

                    doc.Regenerate();
                    var createdConnectors = GetElementConnectors(flex);
                    createdConnectorCount = createdConnectors.Count;
                    var nearStart = FindClosestConnector(createdConnectors, startConnector.Origin);
                    var nearEnd = FindClosestConnector(createdConnectors, endConnector.Origin);
                    if (!TryConnectTo(startConnector, nearStart, out var startError))
                        throw new InvalidOperationException($"Native flex start connection failed. {startError}");
                    if (!TryConnectTo(endConnector, nearEnd, out var endError))
                        throw new InvalidOperationException($"Native flex end connection failed. {endError}");

                    doc.Regenerate();
                    startConnected = IsConnectorPhysicallyConnectedToOwner(nearStart, startId);
                    endConnected = IsConnectorPhysicallyConnectedToOwner(nearEnd, endId);
                    nativeDiameterFt = flex.Diameter;
                    nativePoints = flex.Points.Select(x => new[] { x.X, x.Y, x.Z }).ToList();

                    if (verify)
                    {
                        if (!startConnected || !endConnected)
                            throw new InvalidOperationException("Native flex duct endpoint connection readback failed.");
                        if (createdConnectorCount != 2)
                            throw new InvalidOperationException($"Native flex duct connector readback returned {createdConnectorCount} connectors; expected exactly 2.");
                        if (Math.Abs(nativeDiameterFt - diameterFt) > 1e-4)
                            throw new InvalidOperationException(
                                $"Native flex duct diameter readback {nativeDiameterFt:G9}ft did not match requested {diameterFt:G9}ft.");
                    }

                    if (dryRun) tx.RollBack();
                    else tx.Commit();
                }
                catch
                {
                    if (tx.GetStatus() == TransactionStatus.Started)
                        tx.RollBack();
                    throw;
                }
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "connect_elements_with_flex",
                intent = "native_flex",
                dryRun,
                rolledBack = dryRun,
                startElementId = startId,
                endElementId = endId,
                connectorSummary,
                flexDuctElementId = dryRun ? (long?)null : transientOrCreatedId,
                dryRunFlexDuctElementId = dryRun ? transientOrCreatedId : (long?)null,
                selected = new
                {
                    systemType = new { id = ElementIdCompat.GetValue(systemType.Id), name = systemType.Name },
                    flexDuctType = new { id = ElementIdCompat.GetValue(flexType.Id), name = flexType.Name },
                    level = new { id = ElementIdCompat.GetValue(level.Id), name = level.Name },
                    workset = workset == null ? null : new { id = workset.Id.IntegerValue, name = workset.Name }
                },
                requestedDuctSize = requestedSize.Length == 0 ? null : requestedSize,
                diameterWrite,
                worksetWrite,
                controlPoints = points.Select(x => new[] { x.X, x.Y, x.Z }).ToList(),
                controlPolylineLengthFt = controlPolylineLength,
                nativePoints,
                nativeDiameterFt,
                createdConnectorCount,
                startConnected,
                endConnected,
                verify,
                warnings
            };
        }

        private static object CreateOpenFlexFromElement(Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var verify = p.verify ?? true;
            var startId = p.startElementId.GetValueOrDefault(0);
            if (startId <= 0)
                throw new InvalidOperationException("create_open_flex_from_element requires startElementId.");

            var start = doc.GetElement(ElementIdCompat.Create(startId))
                ?? throw new InvalidOperationException($"Start element {startId} was not found.");
            var originToleranceFt = Math.Max(1e-6, p.originToleranceFt ?? 0.01);
            var startConnector = ResolveGuardedOpenConnector(
                start,
                p.startConnectorId,
                p.expectedStartOriginXyz,
                originToleranceFt,
                "start");

            if (startConnector.Domain != Domain.DomainHvac)
                throw new InvalidOperationException("Open flex start connector must be HVAC.");
            if (startConnector.Shape != ConnectorProfileType.Round)
                throw new InvalidOperationException("Open flex start connector must be round.");

            // Snapshot retained-element evidence before entering the transaction. A
            // connector wrapper used by the transient flex relationship may become
            // invalid after a dry-run rollback even though its owner still exists.
            var startConnectorSnapshot = DescribeConnector(startConnector);

            var diameterFt = startConnector.Radius * 2.0;
            var requestedSize = (p.ductSize ?? "").Trim();
            if (requestedSize.Length > 0)
            {
                if (!LengthTextUtil.TryParseLengthToFeet(doc, requestedSize, out var parsedDiameterFt, out var sizeError) ||
                    parsedDiameterFt <= 0)
                {
                    throw new InvalidOperationException($"Invalid flex duct size '{requestedSize}'. {sizeError}");
                }
                if (Math.Abs(parsedDiameterFt - diameterFt) > 1e-4)
                {
                    throw new InvalidOperationException(
                        $"Requested flex duct size {parsedDiameterFt:G9}ft does not match the guarded start connector diameter {diameterFt:G9}ft.");
                }
                diameterFt = parsedDiameterFt;
            }

            var systemType = ResolveSystemType(doc, (p.systemTypeName ?? "").Trim()) ?? ResolveDefaultMechanicalSystemType(doc)
                ?? throw new InvalidOperationException("Unable to resolve a mechanical system type for open flex duct creation.");
            var level = ResolveLevel(doc, p.levelId, p.levelName) ??
                ResolveNearestLevel(
                    new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().ToList(),
                    startConnector.Origin.Z) ??
                throw new InvalidOperationException("Unable to resolve a level for open flex duct creation.");
            var flexType = ResolveFlexDuctType(doc, p.flexDuctTypeId, p.flexDuctTypeName)
                ?? throw new InvalidOperationException("Unable to resolve the requested native flex duct type.");
            var workset = ResolveFlexWorkset(doc, p.worksetId, p.worksetName);
            var requestedStartTangent = ParseOptionalNonZeroVector(p.flexStartTangentXyz, "flexStartTangentXyz");
            var requestedEndTangent = ParseOptionalNonZeroVector(p.flexEndTangentXyz, "flexEndTangentXyz");

            var points = (p.flexPoints ?? new List<FlexRoutePoint>())
                .Where(x => x != null)
                .Select(x => new XYZ(x.x, x.y, x.z))
                .Where(IsFinitePoint)
                .ToList();
            if (points.Count == 0)
                throw new InvalidOperationException("create_open_flex_from_element requires flexPoints ending at the intended open connector origin.");
            if (points[0].DistanceTo(startConnector.Origin) > 1e-6)
                points.Insert(0, startConnector.Origin);
            else
                points[0] = startConnector.Origin;

            points = RemoveAdjacentDuplicatePoints(points, 1e-5);
            if (points.Count < 2)
                throw new InvalidOperationException("Open flex duct creation requires at least two distinct points.");

            var expectedOpenOrigin = points[points.Count - 1];
            var maxLength = p.maxLengthFeet.GetValueOrDefault(0.0);
            var controlPolylineLength = 0.0;
            for (var i = 1; i < points.Count; i++)
                controlPolylineLength += points[i - 1].DistanceTo(points[i]);
            if (maxLength > 0 && controlPolylineLength > maxLength)
            {
                throw new InvalidOperationException(
                    $"Flex control polyline length {controlPolylineLength:F3}ft exceeds maxLengthFeet {maxLength:F3}.");
            }

            long transientOrCreatedId = 0;
            object? diameterWrite = null;
            object? worksetWrite = null;
            List<double[]> nativePoints = new List<double[]>();
            double nativeDiameterFt = 0.0;
            double[]? nativeStartTangent = null;
            double[]? nativeEndTangent = null;
            int createdConnectorCount = 0;
            bool startConnected = false;
            bool openEndVerified = false;
            long? openConnectorId = null;
            double[]? openConnectorOrigin = null;

            using (var tx = new Transaction(doc, dryRun
                ? "MEP Workflows - Open Flex Duct (Dry Run)"
                : "MEP Workflows - Open Flex Duct"))
            {
                tx.Start();
                try
                {
                    var flex = FlexDuct.Create(doc, systemType.Id, flexType.Id, level.Id, points);
                    transientOrCreatedId = ElementIdCompat.GetValue(flex.Id);

                    if (requestedStartTangent != null) flex.StartTangent = requestedStartTangent;
                    if (requestedEndTangent != null) flex.EndTangent = requestedEndTangent;

                    var diameterParameter = flex.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM)
                        ?? flex.LookupParameter("Diameter")
                        ?? flex.LookupParameter("Duct Diameter");
                    if (diameterParameter == null || diameterParameter.IsReadOnly)
                        throw new InvalidOperationException($"Flex duct {transientOrCreatedId} has no writable diameter parameter.");
                    var diameterBefore = ParameterValueUtil.SnapshotForWire(diameterParameter);
                    diameterParameter.Set(diameterFt);
                    var diameterAfter = ParameterValueUtil.SnapshotForWire(diameterParameter);
                    diameterWrite = new { requestedDiameterFt = diameterFt, before = diameterBefore, after = diameterAfter };

                    if (workset != null)
                    {
                        var worksetParameter = flex.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM)
                            ?? throw new InvalidOperationException($"Flex duct {transientOrCreatedId} does not expose ELEM_PARTITION_PARAM.");
                        if (worksetParameter.IsReadOnly)
                            throw new InvalidOperationException($"Flex duct {transientOrCreatedId} workset parameter is read-only.");
                        worksetParameter.Set(workset.Id.IntegerValue);
                        var readbackWorksetId = worksetParameter.AsInteger();
                        if (readbackWorksetId != workset.Id.IntegerValue)
                            throw new InvalidOperationException($"Flex duct {transientOrCreatedId} workset readback did not match the requested workset.");
                        worksetWrite = new
                        {
                            requestedWorksetId = workset.Id.IntegerValue,
                            requestedWorksetName = workset.Name,
                            readbackWorksetId,
                            verified = true
                        };
                    }

                    doc.Regenerate();
                    var createdConnectors = GetElementConnectors(flex);
                    createdConnectorCount = createdConnectors.Count;
                    var nearStart = FindClosestConnector(createdConnectors, startConnector.Origin)
                        ?? throw new InvalidOperationException("Unable to resolve the created flex start connector.");
                    var nearOpen = createdConnectors
                        .Where(candidate => candidate != nearStart)
                        .OrderBy(candidate => candidate.Origin.DistanceTo(expectedOpenOrigin))
                        .FirstOrDefault()
                        ?? throw new InvalidOperationException("Unable to resolve the created flex open-end connector.");

                    if (!TryConnectTo(startConnector, nearStart, out var startError))
                        throw new InvalidOperationException($"Open flex start connection failed. {startError}");

                    doc.Regenerate();
                    startConnected = IsConnectorPhysicallyConnectedToOwner(nearStart, startId);
                    openEndVerified =
                        !HasPhysicalConnection(nearOpen) &&
                        nearOpen.Origin.DistanceTo(expectedOpenOrigin) <= originToleranceFt;
                    if (TryGetNativeConnectorId(nearOpen, out var nativeOpenConnectorId))
                        openConnectorId = nativeOpenConnectorId;
                    openConnectorOrigin = new[] { nearOpen.Origin.X, nearOpen.Origin.Y, nearOpen.Origin.Z };
                    nativeDiameterFt = flex.Diameter;
                    nativePoints = flex.Points.Select(x => new[] { x.X, x.Y, x.Z }).ToList();
                    nativeStartTangent = new[] { flex.StartTangent.X, flex.StartTangent.Y, flex.StartTangent.Z };
                    nativeEndTangent = new[] { flex.EndTangent.X, flex.EndTangent.Y, flex.EndTangent.Z };

                    if (verify)
                    {
                        if (!startConnected)
                            throw new InvalidOperationException("Open flex start connection readback failed.");
                        if (!openEndVerified)
                            throw new InvalidOperationException("Open flex endpoint was not physically open at the guarded origin.");
                        if (createdConnectorCount != 2)
                            throw new InvalidOperationException($"Open flex connector readback returned {createdConnectorCount} connectors; expected exactly 2.");
                        if (Math.Abs(nativeDiameterFt - diameterFt) > 1e-4)
                            throw new InvalidOperationException(
                                $"Open flex diameter readback {nativeDiameterFt:G9}ft did not match requested {diameterFt:G9}ft.");
                        if (requestedStartTangent != null && !DirectionsMatch(flex.StartTangent, requestedStartTangent))
                            throw new InvalidOperationException("Open flex start tangent readback did not match flexStartTangentXyz.");
                        if (requestedEndTangent != null && !DirectionsMatch(flex.EndTangent, requestedEndTangent))
                            throw new InvalidOperationException("Open flex end tangent readback did not match flexEndTangentXyz.");
                    }

                    if (dryRun) tx.RollBack();
                    else tx.Commit();
                }
                catch
                {
                    if (tx.GetStatus() == TransactionStatus.Started)
                        tx.RollBack();
                    throw;
                }
            }

            var startRestoredOpen = !HasPhysicalConnection(ResolveGuardedConnector(
                start,
                p.startConnectorId,
                p.expectedStartOriginXyz,
                originToleranceFt,
                "start"));
            if (dryRun && verify && !startRestoredOpen)
                throw new InvalidOperationException("Dry-run rollback did not restore the guarded start connector to its prior open state.");

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "create_open_flex_from_element",
                dryRun,
                rolledBack = dryRun,
                rollbackVerified = dryRun ? startRestoredOpen : (bool?)null,
                startElementId = startId,
                startConnector = startConnectorSnapshot,
                flexDuctElementId = dryRun ? (long?)null : transientOrCreatedId,
                dryRunFlexDuctElementId = dryRun ? transientOrCreatedId : (long?)null,
                selected = new
                {
                    systemType = new { id = ElementIdCompat.GetValue(systemType.Id), name = systemType.Name },
                    flexDuctType = new { id = ElementIdCompat.GetValue(flexType.Id), name = flexType.Name },
                    level = new { id = ElementIdCompat.GetValue(level.Id), name = level.Name },
                    workset = workset == null ? null : new { id = workset.Id.IntegerValue, name = workset.Name }
                },
                requestedDuctSize = requestedSize.Length == 0 ? null : requestedSize,
                diameterWrite,
                worksetWrite,
                controlPoints = points.Select(x => new[] { x.X, x.Y, x.Z }).ToList(),
                requestedStartTangent = requestedStartTangent == null ? null : new[] { requestedStartTangent.X, requestedStartTangent.Y, requestedStartTangent.Z },
                requestedEndTangent = requestedEndTangent == null ? null : new[] { requestedEndTangent.X, requestedEndTangent.Y, requestedEndTangent.Z },
                controlPolylineLengthFt = controlPolylineLength,
                nativePoints,
                nativeStartTangent,
                nativeEndTangent,
                nativeDiameterFt,
                createdConnectorCount,
                startConnected,
                openEndVerified,
                openConnectorId,
                openConnectorOrigin,
                verify,
                warnings = Array.Empty<string>()
            };
        }

        private static Connector ResolveGuardedOpenConnector(
            Element element,
            long? requestedConnectorId,
            double[]? expectedOriginXyz,
            double originToleranceFt,
            string label)
        {
            var connector = ResolveGuardedConnector(element, requestedConnectorId, expectedOriginXyz, originToleranceFt, label);
            if (HasPhysicalConnection(connector))
                throw new InvalidOperationException($"The guarded {label} connector is already physically connected.");
            return connector;
        }

        private static Connector ResolveGuardedConnector(
            Element element,
            long? requestedConnectorId,
            double[]? expectedOriginXyz,
            double originToleranceFt,
            string label)
        {
            var connectors = GetElementConnectors(element);
            if (connectors.Count == 0)
                throw new InvalidOperationException($"Element {ElementIdCompat.GetValue(element.Id)} exposes no connectors.");

            Connector? connector = null;
            if (requestedConnectorId.HasValue)
            {
                connector = connectors.FirstOrDefault(candidate =>
                    TryGetNativeConnectorId(candidate, out var nativeId) &&
                    nativeId == requestedConnectorId.Value);
                if (connector == null)
                {
                    throw new InvalidOperationException(
                        $"Native {label} connector {requestedConnectorId.Value} was not found on element {ElementIdCompat.GetValue(element.Id)}.");
                }
            }
            else if (TryParsePoint(expectedOriginXyz, out var expectedOrigin))
            {
                connector = connectors
                    .OrderBy(candidate => candidate.Origin.DistanceTo(expectedOrigin))
                    .FirstOrDefault();
            }
            else
            {
                var physicallyOpen = connectors.Where(candidate => !HasPhysicalConnection(candidate)).ToList();
                if (physicallyOpen.Count != 1)
                {
                    throw new InvalidOperationException(
                        $"{label}ConnectorId or expected origin is required unless the element exposes exactly one physically open connector.");
                }
                connector = physicallyOpen[0];
            }

            if (connector == null)
                throw new InvalidOperationException($"Unable to resolve the guarded {label} connector.");
            if (TryParsePoint(expectedOriginXyz, out var guardedOrigin) &&
                connector.Origin.DistanceTo(guardedOrigin) > originToleranceFt)
            {
                throw new InvalidOperationException(
                    $"The guarded {label} connector origin differs from the expected origin by {connector.Origin.DistanceTo(guardedOrigin):G9}ft.");
            }
            return connector;
        }

        private static bool TryParsePoint(double[]? values, out XYZ point)
        {
            point = XYZ.Zero;
            if (values == null || values.Length != 3 ||
                values.Any(value => double.IsNaN(value) || double.IsInfinity(value)))
                return false;
            point = new XYZ(values[0], values[1], values[2]);
            return true;
        }

        private static XYZ? ParseOptionalNonZeroVector(double[]? values, string fieldName)
        {
            if (values == null) return null;
            if (!TryParsePoint(values, out var vector))
                throw new InvalidOperationException($"{fieldName} must contain exactly three finite numbers.");
            if (vector.GetLength() <= 1e-9)
                throw new InvalidOperationException($"{fieldName} must be non-zero.");
            return vector.Normalize();
        }

        private static bool DirectionsMatch(XYZ actual, XYZ expected) =>
            actual.GetLength() > 1e-9 &&
            expected.GetLength() > 1e-9 &&
            actual.Normalize().DistanceTo(expected.Normalize()) <= 1e-6;

        private static bool TryGetNativeConnectorId(Connector connector, out long connectorId)
        {
            connectorId = -1;
            try
            {
                var property = connector.GetType().GetProperty("Id");
                var value = property?.GetValue(connector);
                if (value == null) return false;
                connectorId = Convert.ToInt64(value);
                return connectorId >= 0;
            }
            catch
            {
                connectorId = -1;
                return false;
            }
        }

        private static bool HasPhysicalConnection(Connector connector)
        {
            try
            {
                foreach (Connector reference in connector.AllRefs)
                {
                    if (reference?.Owner == null || reference.Owner is MEPSystem) continue;
                    if (reference.Owner.Id != connector.Owner.Id)
                        return true;
                }
            }
            catch
            {
                return false;
            }
            return false;
        }

        private static object DescribeConnector(Connector connector)
        {
            var connectorId = TryGetNativeConnectorId(connector, out var nativeId) ? nativeId : (long?)null;
            return new
            {
                connectorId,
                connectorIdBasis = connectorId.HasValue ? "revit_native_connector_id" : "origin_guard",
                origin = new[] { connector.Origin.X, connector.Origin.Y, connector.Origin.Z },
                domain = connector.Domain.ToString(),
                shape = connector.Shape.ToString(),
                diameterFt = connector.Shape == ConnectorProfileType.Round ? connector.Radius * 2.0 : (double?)null
            };
        }

        private static FlexDuctType? ResolveFlexDuctType(Document doc, long? requestedId, string? requestedName)
        {
            if (requestedId.GetValueOrDefault(0) > 0)
                return doc.GetElement(ElementIdCompat.Create(requestedId!.Value)) as FlexDuctType;

            var types = new FilteredElementCollector(doc)
                .OfClass(typeof(FlexDuctType))
                .Cast<FlexDuctType>()
                .ToList();
            var name = (requestedName ?? "").Trim();
            if (name.Length == 0)
                return types.FirstOrDefault();
            return types.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
        }

        private static Workset? ResolveFlexWorkset(Document doc, long? requestedId, string? requestedName)
        {
            if (!doc.IsWorkshared)
            {
                if (requestedId.GetValueOrDefault(0) > 0 || !string.IsNullOrWhiteSpace(requestedName))
                    throw new InvalidOperationException("A flex duct workset was requested, but the document is not workshared.");
                return null;
            }

            var userWorksets = new FilteredWorksetCollector(doc)
                .OfKind(WorksetKind.UserWorkset)
                .ToWorksets()
                .ToList();
            if (requestedId.GetValueOrDefault(0) > 0)
            {
                var byId = userWorksets.FirstOrDefault(x => x.Id.IntegerValue == requestedId!.Value);
                return byId ?? throw new InvalidOperationException($"User workset id {requestedId.Value} was not found.");
            }

            var name = (requestedName ?? "").Trim();
            if (name.Length == 0)
                return null;
            return userWorksets.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"User workset '{name}' was not found.");
        }

        private static bool IsFinitePoint(XYZ point)
        {
            return !(double.IsNaN(point.X) || double.IsInfinity(point.X) ||
                     double.IsNaN(point.Y) || double.IsInfinity(point.Y) ||
                     double.IsNaN(point.Z) || double.IsInfinity(point.Z));
        }

        private static List<XYZ> RemoveAdjacentDuplicatePoints(List<XYZ> points, double toleranceFt)
        {
            var result = new List<XYZ>();
            foreach (var point in points)
            {
                if (result.Count == 0 || result[result.Count - 1].DistanceTo(point) > toleranceFt)
                    result.Add(point);
            }
            return result;
        }

        private static bool IsConnectorPhysicallyConnectedToOwner(Connector? connector, long ownerId)
        {
            if (connector == null) return false;
            try
            {
                foreach (Connector reference in connector.AllRefs)
                {
                    if (reference?.Owner == null || reference.Owner is MEPSystem) continue;
                    if (ElementIdCompat.GetValue(reference.Owner.Id) == ownerId)
                        return true;
                }
            }
            catch
            {
                return false;
            }
            return false;
        }

        private static object RouteTerminalsToEquipment(UIApplication app, Document doc, Params p)
        {
            var equipmentId = p.equipmentElementId.GetValueOrDefault(0);
            if (equipmentId <= 0) throw new InvalidOperationException("route_terminals_to_equipment requires equipmentElementId.");
            var dryRun = p.dryRun ?? false;
            var maxBranches = ClampInt(p.maxBranches ?? 200, 1, 5000);

            var terminals = (p.terminalElementIds ?? new List<long>())
                .Where(x => x > 0 && x != equipmentId)
                .Distinct()
                .Take(maxBranches)
                .ToList();
            if (terminals.Count == 0)
            {
                terminals = (p.sourceElementIds ?? new List<long>())
                    .Where(x => x > 0 && x != equipmentId)
                    .Distinct()
                    .Take(maxBranches)
                    .ToList();
            }
            if (terminals.Count == 0)
            {
                terminals = ResolveTargetElements(doc, p, new[] { BuiltInCategory.OST_DuctTerminal }, maxBranches + 10)
                    .Select(x => ElementIdCompat.GetValue(x.Id))
                    .Where(x => x > 0 && x != equipmentId)
                    .Distinct()
                    .Take(maxBranches)
                    .ToList();
            }
            if (terminals.Count == 0) throw new InvalidOperationException("route_terminals_to_equipment found no terminal elements to route.");

            var rows = new List<object>();
            var success = 0;
            foreach (var tid in terminals)
            {
                var sub = new Params
                {
                    action = "connect_elements_with_duct",
                    dryRun = dryRun,
                    startElementId = equipmentId,
                    endElementId = tid,
                    systemTypeName = p.systemTypeName,
                    ductTypeName = p.ductTypeName,
                    ductSize = p.ductSize,
                    levelId = p.levelId,
                    levelName = p.levelName,
                    maxLengthFeet = p.maxLengthFeet,
                    maxElbowsPerBranch = p.maxElbowsPerBranch
                };

                object result;
                try
                {
                    result = ConnectElementsWithDuct(app, doc, sub, "duct");
                    if (dryRun || TryReadLong(result, "ductId") > 0) success++;
                }
                catch (Exception ex)
                {
                    result = new { status = "Error", message = ex.Message };
                }

                rows.Add(new
                {
                    equipmentElementId = equipmentId,
                    terminalElementId = tid,
                    result
                });
            }

            var warnings = new List<string>();
            if (p.maxElbowsPerBranch.HasValue)
                warnings.Add("maxElbowsPerBranch is currently best-effort metadata; branch routing is direct connector-to-connector.");

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "route_terminals_to_equipment",
                dryRun,
                equipmentElementId = equipmentId,
                requestedTerminalCount = terminals.Count,
                successfulCount = success,
                routed = rows,
                warnings
            };
        }

        private static object PlaceEquipmentAndConnect(UIApplication app, Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var symbol = (p.symbolName ?? "").Trim();
            if (symbol.Length == 0) throw new InvalidOperationException("place_equipment_and_connect requires symbolName.");
            if (!p.x.HasValue || !p.y.HasValue) throw new InvalidOperationException("place_equipment_and_connect requires x and y.");

            var level = ResolveLevel(doc, p.levelId, p.levelName);
            var levelName = level?.Name ?? p.levelName ?? "";
            var z = p.z ?? level?.Elevation ?? 0.0;

            var createRequest = new
            {
                familyName = string.IsNullOrWhiteSpace(p.familyName) ? null : p.familyName!.Trim(),
                symbolName = symbol,
                levelName,
                x = p.x.Value,
                y = p.y.Value,
                z = z
            };

            if (dryRun)
            {
                return new
                {
                    status = "Dry Run",
                    action = "place_equipment_and_connect",
                    dryRun = true,
                    createRequest,
                    routePlanned = (p.terminalElementIds?.Count ?? 0) > 0
                };
            }

            var created = new CreateFamilyInstanceHandler().Handle(app, JsonSerializer.Serialize(createRequest)).GetAwaiter().GetResult();
            var equipmentId = TryReadLong(created, "id");
            object? routeResult = null;
            if (equipmentId > 0 && (p.terminalElementIds?.Count ?? 0) > 0)
            {
                var routeParams = new Params
                {
                    dryRun = false,
                    equipmentElementId = equipmentId,
                    terminalElementIds = p.terminalElementIds,
                    systemTypeName = p.systemTypeName,
                    ductTypeName = p.ductTypeName,
                    ductSize = p.ductSize,
                    levelId = p.levelId,
                    levelName = p.levelName,
                    maxLengthFeet = p.maxLengthFeet,
                    maxElbowsPerBranch = p.maxElbowsPerBranch,
                    maxBranches = p.maxBranches
                };
                routeResult = RouteTerminalsToEquipment(app, doc, routeParams);
            }

            return new
            {
                status = "Applied",
                action = "place_equipment_and_connect",
                equipmentElementId = equipmentId > 0 ? equipmentId : (long?)null,
                createResult = created,
                routeResult
            };
        }

        private static object CreateRiserOffset(UIApplication app, Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var startId = p.startElementId.GetValueOrDefault(0);
            var endId = p.endElementId.GetValueOrDefault(0);
            if (startId <= 0 || endId <= 0) throw new InvalidOperationException("create_riser_offset requires startElementId and endElementId.");

            var start = doc.GetElement(ElementIdCompat.Create(startId));
            var end = doc.GetElement(ElementIdCompat.Create(endId));
            if (start == null || end == null) throw new InvalidOperationException("Start or end element not found.");

            TryResolveClosestConnectorPair(start, end, out var startConnector, out var endConnector, out var connectorSummary);
            var p1 = startConnector?.Origin ?? ResolveElementPoint(start);
            var p2 = endConnector?.Origin ?? ResolveElementPoint(end);
            if (p1 == null || p2 == null) throw new InvalidOperationException("Unable to resolve connection points for riser offset.");

            var rise = Math.Max(1.0, p.sectionHeightFeet ?? p.paddingFeet ?? 3.0);
            var highZ = Math.Max(p1.Z, p2.Z) + rise;
            var m1 = new XYZ(p1.X, p1.Y, highZ);
            var m2 = new XYZ(p2.X, p2.Y, highZ);

            var points = new[]
            {
                new[] { p1.X, p1.Y, p1.Z },
                new[] { m1.X, m1.Y, m1.Z },
                new[] { m2.X, m2.Y, m2.Z },
                new[] { p2.X, p2.Y, p2.Z }
            };

            if (dryRun)
            {
                return new
                {
                    status = "Dry Run",
                    action = "create_riser_offset",
                    dryRun = true,
                    startElementId = startId,
                    endElementId = endId,
                    connectorSummary,
                    riseFeet = rise,
                    pathPoints = points
                };
            }

            var level = ResolveLevel(doc, p.levelId, p.levelName) ?? ResolveNearestLevel(new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().ToList(), highZ);
            var systemType = ResolveSystemType(doc, (p.systemTypeName ?? "").Trim()) ?? ResolveDefaultMechanicalSystemType(doc);
            var ductType = ResolveDuctType(doc, p.ductTypeName) ?? ResolveDefaultDuctType(doc);
            if (level == null || systemType == null || ductType == null) throw new InvalidOperationException("Unable to resolve level/system/duct type for riser offset.");

            var createdIds = new List<long>();
            using (var tx = new Transaction(doc, "MEP Workflows - Create Riser Offset"))
            {
                tx.Start();
                var d1 = Duct.Create(doc, systemType.Id, ductType.Id, level.Id, p1, m1);
                var d2 = Duct.Create(doc, systemType.Id, ductType.Id, level.Id, m1, m2);
                var d3 = Duct.Create(doc, systemType.Id, ductType.Id, level.Id, m2, p2);
                createdIds.Add(ElementIdCompat.GetValue(d1.Id));
                createdIds.Add(ElementIdCompat.GetValue(d2.Id));
                createdIds.Add(ElementIdCompat.GetValue(d3.Id));
                tx.Commit();
            }

            return new
            {
                status = "Applied",
                action = "create_riser_offset",
                startElementId = startId,
                endElementId = endId,
                riseFeet = rise,
                segmentIds = createdIds,
                pathPoints = points
            };
        }

        private static object EnsureSpacesAndTag(UIApplication app, Document doc, Params p)
        {
            var level = ResolveLevel(doc, p.levelId, p.levelName);
            var levelName = level?.Name ?? (p.levelName ?? "").Trim();
            if (levelName.Length == 0) throw new InvalidOperationException("ensure_spaces_and_tag requires levelName (or levelId).");
            var dryRun = p.dryRun ?? false;
            var shouldTag = p.createSpaceTags ?? true;

            if (dryRun)
            {
                return new
                {
                    status = "Dry Run",
                    action = "ensure_spaces_and_tag",
                    dryRun = true,
                    levelName,
                    tagSpaces = shouldTag,
                    viewId = p.viewId
                };
            }

            var ensure = new EnsureSpacesHandler().Handle(app, JsonSerializer.Serialize(new { levelName })).GetAwaiter().GetResult();
            object? tagResult = null;
            if (shouldTag)
            {
                var tagReq = new
                {
                    viewId = p.viewId,
                    categoryNames = new[] { "OST_MEPSpaces" },
                    onlyUntagged = p.onlyTagUntagged ?? true,
                    addLeader = p.addTagLeader ?? false,
                    offsetX = p.tagOffsetFeet ?? 1.0,
                    offsetY = p.tagOffsetFeet ?? 1.0,
                    dryRun = false
                };
                try
                {
                    tagResult = new TagElementsHandler().Handle(app, JsonSerializer.Serialize(tagReq)).GetAwaiter().GetResult();
                }
                catch (Exception ex)
                {
                    tagResult = new { status = "Error", message = ex.Message };
                }
            }

            return new
            {
                status = "Applied",
                action = "ensure_spaces_and_tag",
                levelName,
                ensureSpaces = ensure,
                tagResult
            };
        }

        private static object CreateHvacSchematic(UIApplication app, Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var name = (p.name ?? "HVAC Schematic").Trim();
            if (name.Length == 0) name = "HVAC Schematic";

            var createReq = new CreateViewHandler.Params
            {
                action = "create_drafting",
                name = name,
                dryRun = dryRun
            };
            var createResult = new CreateViewHandler().Handle(app, JsonSerializer.Serialize(createReq)).GetAwaiter().GetResult();
            var viewId = TryReadLong(createResult, "view.id");

            var equipmentIds = (p.equipmentElementIds ?? p.sourceElementIds ?? new List<long>())
                .Where(x => x > 0)
                .Distinct()
                .Take(100)
                .ToList();
            if (equipmentIds.Count == 0)
            {
                equipmentIds = ResolveTargetElements(doc, p, new[] { BuiltInCategory.OST_MechanicalEquipment }, 100)
                    .Select(x => ElementIdCompat.GetValue(x.Id))
                    .Distinct()
                    .ToList();
            }

            var annotate = p.annotateEquipment ?? true;
            var notes = new List<object>();
            if (!dryRun && annotate && viewId > 0 && equipmentIds.Count > 0)
            {
                var y = 0.0;
                foreach (var id in equipmentIds.Take(50))
                {
                    var e = doc.GetElement(ElementIdCompat.Create(id));
                    var label = e == null ? $"Equipment {id}" : BuildEquipmentLabel(e);
                    var textReq = new CreateTextNoteHandler.Params
                    {
                        action = "create",
                        viewId = viewId,
                        x = 0.0,
                        y = y,
                        text = label,
                        dryRun = false
                    };
                    try
                    {
                        var note = new CreateTextNoteHandler().Handle(app, JsonSerializer.Serialize(textReq)).GetAwaiter().GetResult();
                        notes.Add(new { equipmentId = id, text = label, result = note });
                    }
                    catch (Exception ex)
                    {
                        notes.Add(new { equipmentId = id, text = label, error = ex.Message });
                    }
                    y -= 0.75;
                }
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "create_hvac_schematic",
                dryRun,
                viewId = viewId > 0 ? viewId : (long?)null,
                equipmentCount = equipmentIds.Count,
                annotateEquipment = annotate,
                createResult,
                notes
            };
        }

        private static object Duplicate3dWithSectionBox(UIApplication app, Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var source = ResolveSource3dView(doc, p.sourceViewId) ?? throw new InvalidOperationException("duplicate_3d_with_section_box requires sourceViewId (or an active/default 3D view).");
            var name = (p.name ?? $"{source.Name} - Sectioned").Trim();
            if (name.Length == 0) name = $"{source.Name} - Sectioned";

            var targetBox = ResolveCoordinationBox(doc, p, out var sourceSummary);
            if (dryRun)
            {
                return new
                {
                    status = "Dry Run",
                    action = "duplicate_3d_with_section_box",
                    dryRun = true,
                    sourceView = new { id = ElementIdCompat.GetValue(source.Id), name = source.Name },
                    targetName = name,
                    sourceSummary,
                    hasSectionBox = targetBox != null
                };
            }

            var dupReq = new
            {
                viewId = ElementIdCompat.GetValue(source.Id),
                newName = name,
                withDetailing = false
            };
            var dupResult = new DuplicateViewHandler().Handle(app, JsonSerializer.Serialize(dupReq)).GetAwaiter().GetResult();
            var duplicatedViewId = TryReadLong(dupResult, "viewId");
            if (duplicatedViewId <= 0) throw new InvalidOperationException("Failed to duplicate source 3D view.");

            object? sectionResult = null;
            if (targetBox != null)
            {
                var padding = Math.Max(0.0, p.paddingFeet ?? 1.0);
                var min = new XYZ(targetBox.Min.X - padding, targetBox.Min.Y - padding, targetBox.Min.Z - padding);
                var max = new XYZ(targetBox.Max.X + padding, targetBox.Max.Y + padding, targetBox.Max.Z + padding);
                var visReq = new ViewVisibilityHandler.Params
                {
                    action = "set_section_box",
                    viewId = duplicatedViewId,
                    boxMin = new ViewVisibilityHandler.Point3 { x = min.X, y = min.Y, z = min.Z },
                    boxMax = new ViewVisibilityHandler.Point3 { x = max.X, y = max.Y, z = max.Z }
                };
                sectionResult = new ViewVisibilityHandler().Handle(app, JsonSerializer.Serialize(visReq)).GetAwaiter().GetResult();
            }

            return new
            {
                status = "Applied",
                action = "duplicate_3d_with_section_box",
                sourceViewId = ElementIdCompat.GetValue(source.Id),
                duplicatedViewId,
                sourceSummary,
                duplicateResult = dupResult,
                sectionResult
            };
        }

        private static object CreateDependentWithCrop(UIApplication app, Document doc, Params p)
        {
            var sourceViewId = p.sourceViewId.GetValueOrDefault(0);
            if (sourceViewId <= 0) throw new InvalidOperationException("create_dependent_with_crop requires sourceViewId.");
            var dryRun = p.dryRun ?? false;

            var createReq = new CreateViewHandler.Params
            {
                action = "create_dependent",
                sourceViewId = sourceViewId,
                name = p.name,
                dryRun = dryRun
            };
            var createResult = new CreateViewHandler().Handle(app, JsonSerializer.Serialize(createReq)).GetAwaiter().GetResult();
            var dependentViewId = TryReadLong(createResult, "view.id");

            var targetBox = ResolveCoordinationBox(doc, p, out var sourceSummary);
            if (dryRun || dependentViewId <= 0 || targetBox == null)
            {
                return new
                {
                    status = dryRun ? "Dry Run" : "AppliedWithWarnings",
                    action = "create_dependent_with_crop",
                    sourceViewId,
                    dependentViewId = dependentViewId > 0 ? dependentViewId : (long?)null,
                    sourceSummary,
                    hasCropBox = targetBox != null,
                    createResult
                };
            }

            var padding = Math.Max(0.0, p.paddingFeet ?? 1.0);
            var min = new XYZ(targetBox.Min.X - padding, targetBox.Min.Y - padding, targetBox.Min.Z - padding);
            var max = new XYZ(targetBox.Max.X + padding, targetBox.Max.Y + padding, targetBox.Max.Z + padding);
            var visReq = new ViewVisibilityHandler.Params
            {
                action = "set_crop_box",
                viewId = dependentViewId,
                boxMin = new ViewVisibilityHandler.Point3 { x = min.X, y = min.Y, z = min.Z },
                boxMax = new ViewVisibilityHandler.Point3 { x = max.X, y = max.Y, z = max.Z }
            };
            object cropResult;
            try
            {
                cropResult = new ViewVisibilityHandler().Handle(app, JsonSerializer.Serialize(visReq)).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                cropResult = new { status = "Error", message = ex.Message };
            }

            return new
            {
                status = "Applied",
                action = "create_dependent_with_crop",
                sourceViewId,
                dependentViewId,
                sourceSummary,
                createResult,
                cropResult
            };
        }

        private static List<string> BuildIntentWarnings(string intent, int? maxElbowsPerBranch, bool lengthExceeded)
        {
            var warnings = new List<string>();
            if (intent == "elbow" || intent == "transition")
                warnings.Add($"connect_elements_with_{intent} relies on connector attachment and Revit auto-fitting behavior.");
            if (maxElbowsPerBranch.HasValue)
                warnings.Add("maxElbowsPerBranch is currently best-effort metadata.");
            if (lengthExceeded)
                warnings.Add("Planned connection exceeds maxLengthFeet.");
            return warnings;
        }

        private static MEPSystemType? ResolveDefaultMechanicalSystemType(Document doc)
        {
            var all = new FilteredElementCollector(doc)
                .OfClass(typeof(MEPSystemType))
                .Cast<MEPSystemType>()
                .ToList();
            var preferred = all.FirstOrDefault(x => (x.Name ?? "").IndexOf("supply", StringComparison.OrdinalIgnoreCase) >= 0);
            return preferred ?? all.FirstOrDefault();
        }

        private static DuctType? ResolveDefaultDuctType(Document doc)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(DuctType))
                .Cast<DuctType>()
                .FirstOrDefault();
        }

        private static DuctType? ResolveDuctType(Document doc, string? token)
        {
            var all = new FilteredElementCollector(doc)
                .OfClass(typeof(DuctType))
                .Cast<DuctType>()
                .ToList();
            var q = (token ?? "").Trim();
            if (q.Length == 0) return all.FirstOrDefault();
            var exact = all.FirstOrDefault(x => string.Equals((x.Name ?? "").Trim(), q, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;
            return all.FirstOrDefault(x => (x.Name ?? "").IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0) ?? all.FirstOrDefault();
        }

        private static object TryApplyDuctSize(Document doc, Duct duct, string requested)
        {
            var raw = (requested ?? "").Trim();
            if (raw.Length == 0)
            {
                return new { ok = false, applied = false, error = "No ductSize provided." };
            }

            // Rectangular input like "24x12" or "24 x 12".
            var pair = raw.Split(new[] { 'x', 'X' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(x => x.Trim())
                .Where(x => x.Length > 0)
                .ToList();
            if (pair.Count == 2)
            {
                var width = TrySetAnySizeParameter(doc, duct, pair[0], new[] { "Width", "Duct Width", "W" }, new[] { "RBS_CURVE_WIDTH_PARAM" });
                var height = TrySetAnySizeParameter(doc, duct, pair[1], new[] { "Height", "Duct Height", "H" }, new[] { "RBS_CURVE_HEIGHT_PARAM" });
                return new
                {
                    ok = width.ok || height.ok,
                    applied = width.applied || height.applied,
                    mode = "rectangular",
                    requested = raw,
                    width,
                    height
                };
            }

            var diameter = TrySetAnySizeParameter(doc, duct, raw, new[] { "Diameter", "Duct Diameter", "Size" }, new[] { "RBS_CURVE_DIAMETER_PARAM" });
            if (diameter.ok) return new { ok = true, applied = diameter.applied, mode = "round", requested = raw, diameter };

            // Fallback for non-round shape: try width then height with single scalar.
            var widthFallback = TrySetAnySizeParameter(doc, duct, raw, new[] { "Width", "Duct Width" }, new[] { "RBS_CURVE_WIDTH_PARAM" });
            var heightFallback = TrySetAnySizeParameter(doc, duct, raw, new[] { "Height", "Duct Height" }, new[] { "RBS_CURVE_HEIGHT_PARAM" });
            return new
            {
                ok = widthFallback.ok || heightFallback.ok,
                applied = widthFallback.applied || heightFallback.applied,
                mode = "fallback",
                requested = raw,
                width = widthFallback,
                height = heightFallback
            };
        }

        private static (bool ok, bool applied, object? before, object? after, string? parameterName, string? error) TrySetAnySizeParameter(
            Document doc,
            Duct duct,
            string requested,
            IEnumerable<string> nameCandidates,
            IEnumerable<string> builtInCandidates)
        {
            foreach (var name in nameCandidates)
            {
                var p = duct.LookupParameter(name);
                if (p == null || p.IsReadOnly) continue;
                var before = ParameterValueUtil.SnapshotForWire(p);
                if (TrySetParameterFromString(doc, p, requested, out var changed, out var err))
                {
                    var after = ParameterValueUtil.SnapshotForWire(p);
                    return (true, changed, before, after, name, err);
                }
            }

            foreach (var bipName in builtInCandidates)
            {
                try
                {
                    var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), bipName, ignoreCase: true);
                    var p = duct.get_Parameter(bip);
                    if (p == null || p.IsReadOnly) continue;
                    var before = ParameterValueUtil.SnapshotForWire(p);
                    if (TrySetParameterFromString(doc, p, requested, out var changed, out var err))
                    {
                        var after = ParameterValueUtil.SnapshotForWire(p);
                        return (true, changed, before, after, bipName, err);
                    }
                }
                catch
                {
                    // try next
                }
            }

            return (false, false, null, null, null, "No writable size parameter was found on the created duct.");
        }

        private static List<Connector> GetElementConnectors(Element? e)
        {
            var outList = new List<Connector>();
            if (e == null) return outList;

            try
            {
                if (e is MEPCurve curve)
                {
                    var cm = curve.ConnectorManager;
                    if (cm != null)
                    {
                        foreach (Connector c in cm.Connectors)
                        {
                            if (c != null) outList.Add(c);
                        }
                    }
                }
            }
            catch
            {
                // ignore
            }

            try
            {
                if (e is FamilyInstance fi)
                {
                    var cm = fi.MEPModel?.ConnectorManager;
                    if (cm != null)
                    {
                        foreach (Connector c in cm.Connectors)
                        {
                            if (c != null) outList.Add(c);
                        }
                    }
                }
            }
            catch
            {
                // ignore
            }

            return outList;
        }

        private static bool TryResolveClosestConnectorPair(Element start, Element end, out Connector? startConnector, out Connector? endConnector, out object summary)
        {
            startConnector = null;
            endConnector = null;
            var startAll = GetElementConnectors(start);
            var endAll = GetElementConnectors(end);
            var startOpen = startAll.Where(c => IsConnectorOpen(c)).ToList();
            var endOpen = endAll.Where(c => IsConnectorOpen(c)).ToList();
            var startCandidates = startOpen.Count > 0 ? startOpen : startAll;
            var endCandidates = endOpen.Count > 0 ? endOpen : endAll;

            double best = double.MaxValue;
            foreach (var s in startCandidates)
            {
                foreach (var t in endCandidates)
                {
                    var d = s.Origin.DistanceTo(t.Origin);
                    if (d < best)
                    {
                        best = d;
                        startConnector = s;
                        endConnector = t;
                    }
                }
            }

            summary = new
            {
                startConnectorCount = startAll.Count,
                startOpenConnectorCount = startOpen.Count,
                endConnectorCount = endAll.Count,
                endOpenConnectorCount = endOpen.Count,
                pairDistanceFeet = best < double.MaxValue ? best : (double?)null
            };
            return startConnector != null && endConnector != null;
        }

        private static bool IsConnectorOpen(Connector c)
        {
            try
            {
                return !c.IsConnected;
            }
            catch
            {
                return true;
            }
        }

        private static Connector? FindClosestConnector(IEnumerable<Connector> connectors, XYZ point)
        {
            Connector? best = null;
            var bestDist = double.MaxValue;
            foreach (var c in connectors ?? Enumerable.Empty<Connector>())
            {
                try
                {
                    var d = c.Origin.DistanceTo(point);
                    if (d < bestDist)
                    {
                        bestDist = d;
                        best = c;
                    }
                }
                catch
                {
                    // ignore
                }
            }
            return best;
        }

        private static bool TryConnectTo(Connector? a, Connector? b, out string? error)
        {
            error = null;
            if (a == null || b == null) return false;
            try
            {
                a.ConnectTo(b);
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static bool IsConnectedByTrace(UIApplication app, long startElementId, long endElementId)
        {
            try
            {
                var trace = new TraceConnectedNetworkHandler().Handle(app, JsonSerializer.Serialize(new
                {
                    startElementId,
                    maxElements = 5000,
                    maxHops = 200
                })).GetAwaiter().GetResult();

                var ids = TryReadLongArray(trace, "elementIdsOrdered");
                return ids.Contains(endElementId);
            }
            catch
            {
                return false;
            }
        }

        private static HashSet<long> TryReadLongArray(object payload, string propertyName)
        {
            var set = new HashSet<long>();
            try
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(payload));
                if (!doc.RootElement.TryGetProperty(propertyName, out var arr) || arr.ValueKind != JsonValueKind.Array) return set;
                foreach (var item in arr.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out var v) && v > 0) set.Add(v);
                }
            }
            catch
            {
                // ignore
            }
            return set;
        }

        private static string BuildEquipmentLabel(Element e)
        {
            var family = "";
            var type = "";
            try
            {
                if (e is FamilyInstance fi)
                {
                    family = fi.Symbol?.FamilyName ?? "";
                    type = fi.Symbol?.Name ?? "";
                }
            }
            catch
            {
                // ignore
            }

            var mark = "";
            try
            {
                mark = e.LookupParameter("Mark")?.AsString() ?? "";
            }
            catch
            {
                // ignore
            }

            var parts = new List<string>();
            if (!string.IsNullOrWhiteSpace(mark)) parts.Add($"[{mark.Trim()}]");
            parts.Add(string.IsNullOrWhiteSpace(family) ? e.Name : family);
            if (!string.IsNullOrWhiteSpace(type)) parts.Add(type.Trim());
            return string.Join(" ", parts.Where(x => !string.IsNullOrWhiteSpace(x)));
        }

        private static View3D? ResolveSource3dView(Document doc, long? sourceViewId)
        {
            if (sourceViewId.HasValue && sourceViewId.Value > 0)
            {
                return doc.GetElement(ElementIdCompat.Create(sourceViewId.Value)) as View3D;
            }

            if (doc.ActiveView is View3D active3d && !active3d.IsTemplate) return active3d;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(View3D))
                .Cast<View3D>()
                .FirstOrDefault(v => !v.IsTemplate && !v.IsPerspective);
        }
    }
}
