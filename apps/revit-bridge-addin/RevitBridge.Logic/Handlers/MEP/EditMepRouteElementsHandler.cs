using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class EditMepRouteElementsHandler : IRequestHandler
    {
        public sealed class Params
        {
            public sealed class EndpointEditParams
            {
                public long elementId { get; set; }
                public int endpointIndex { get; set; }
                public double[]? expectedEndpointXyz { get; set; }
                public double[]? targetEndpointXyz { get; set; }
                public double coordinateToleranceFt { get; set; } = 0.001;
                public bool requireEditedEndpointOpen { get; set; } = true;
                public bool preserveExistingPhysicalConnections { get; set; } = true;
            }

            public sealed class DirectionEditParams
            {
                public long elementId { get; set; }
                public double[]? expectedStartXyz { get; set; }
                public double[]? expectedEndXyz { get; set; }
                public double coordinateToleranceFt { get; set; } = 0.001;
                public bool preserveExistingPhysicalConnections { get; set; } = true;
            }

            public string? expectedModelPath { get; set; }
            public string kind { get; set; } = "duct";
            public List<long> elementIds { get; set; } = new List<long>();
            public bool dryRun { get; set; } = true;
            public bool apply { get; set; } = false;

            public string? ductSize { get; set; }
            public string? diameter { get; set; }
            public string? pipeSize { get; set; }
            public string? sizePolicy { get; set; } = "explicit_required";

            public double? deltaZFt { get; set; }
            public double? targetCenterlineZFt { get; set; }
            public bool allowConnectedElevationMove { get; set; } = false;

            public bool verify { get; set; } = true;
            public EndpointEditParams? endpointEdit { get; set; }
            public DirectionEditParams? directionEdit { get; set; }
            public bool visualVerify { get; set; } = false;
            public long? visualViewId { get; set; }
            public int imageSize { get; set; } = 1600;
            public double focusPaddingFt { get; set; } = 3.0;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.elementIds == null || p.elementIds.Count == 0) throw new ArgumentException("elementIds must be a non-empty array.");
            var normalizedKind = MepRoutingUtil.NormalizeKind(p.kind);
            var shouldApply = p.apply || !p.dryRun;
            var changesSize = HasSizeRequest(p);
            var changesElevation = p.deltaZFt.HasValue || p.targetCenterlineZFt.HasValue;
            var changesCurve = p.endpointEdit != null || p.directionEdit != null;
            if (!changesSize && !changesElevation && !changesCurve) throw new ArgumentException("Request must include a size, elevation, endpoint, or direction change.");
            if (p.deltaZFt.HasValue && p.targetCenterlineZFt.HasValue) throw new ArgumentException("Specify either deltaZFt or targetCenterlineZFt, not both.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            GuardExpectedModelPath(doc, p.expectedModelPath);

            if (p.endpointEdit != null && p.directionEdit != null)
                throw new ArgumentException("Specify endpointEdit or directionEdit, not both.");
            if (p.directionEdit != null)
                return Task.FromResult(HandleDirectionEdit(doc, p, normalizedKind, shouldApply));
            if (p.endpointEdit != null)
                return Task.FromResult(HandleEndpointEdit(doc, p, normalizedKind, shouldApply));

            var warnings = new List<string>();
            var ids = p.elementIds.Where(x => x > 0).Distinct().ToList();
            var resolved = ResolveElements(doc, ids, normalizedKind);
            var before = resolved.Select(SnapshotElement).ToList();

            IReadOnlyList<MepRouteElementEditPlanner.CurvePlan> elevationPlan = new List<MepRouteElementEditPlanner.CurvePlan>();
            if (changesElevation)
            {
                var curveInputs = resolved.Select(ToPlannerCurveInput).ToList();
                elevationPlan = MepRouteElementEditPlanner.PlanElevationMove(curveInputs, p.deltaZFt, p.targetCenterlineZFt);
                if (!p.allowConnectedElevationMove)
                {
                    var connected = before
                        .Where(x => GetInt(x, "connectedConnectorCount") > 0)
                        .Select(x => GetLong(x, "id"))
                        .Where(x => x > 0)
                        .ToList();
                    if (connected.Count > 0)
                    {
                        throw new InvalidOperationException("Elevation move is blocked because one or more requested MEP curves have connected connectors. Set allowConnectedElevationMove:true only after planning the affected connected run. Connected ids: " + string.Join(", ", connected));
                    }
                }
            }

            MepRoutingUtil.SizeChoice? sizeChoice = null;
            if (changesSize)
            {
                sizeChoice = MepRoutingUtil.ChooseSize(normalizedKind, p.ductSize, p.diameter, p.pipeSize, p.sizePolicy, warnings);
                if (sizeChoice.Missing || (!sizeChoice.WidthFt.HasValue && !sizeChoice.HeightFt.HasValue && !sizeChoice.DiameterFt.HasValue))
                {
                    throw new ArgumentException("A parseable explicit size is required for this route edit.");
                }
            }

            var appliedIds = new List<long>();
            var sizeResults = new List<object>();
            var transactionFailures = new List<string>();
            List<Dictionary<string, object>> after = before;

            using (var t = new Transaction(doc, shouldApply ? "Edit MEP Route Elements" : "Edit MEP Route Elements (Dry Run)"))
            {
                t.Start();
                try
                {
                    if (changesElevation)
                    {
                        var byId = elevationPlan.ToDictionary(x => x.ElementId, x => x.DeltaZFt);
                        foreach (var e in resolved)
                        {
                            var id = ElementIdCompat.GetValue(e.Id);
                            var dz = byId[id];
                            if (Math.Abs(dz) < 1e-9) continue;
                            ElementTransformUtils.MoveElement(doc, e.Id, new XYZ(0, 0, dz));
                            appliedIds.Add(id);
                        }
                    }

                    if (changesSize && sizeChoice != null)
                    {
                        foreach (var e in resolved)
                        {
                            var id = ElementIdCompat.GetValue(e.Id);
                            bool ok;
                            object detail;
                            if (normalizedKind == "pipe" && e is Pipe pipe)
                            {
                                ok = MepRoutingUtil.TryApplyPipeSize(pipe, sizeChoice, out detail);
                            }
                            else if (normalizedKind == "duct" && e is Duct duct)
                            {
                                ok = MepRoutingUtil.TryApplyDuctSize(duct, sizeChoice, out detail);
                            }
                            else
                            {
                                throw new InvalidOperationException($"Element {id} is not a {normalizedKind} curve.");
                            }

                            sizeResults.Add(new { id, ok, detail, requestedSize = sizeChoice.RequestedText, appliedSize = sizeChoice.AppliedText });
                            if (!ok) throw new InvalidOperationException($"Element {id} did not expose writable size parameters for requested size '{sizeChoice.RequestedText}'.");
                            if (!appliedIds.Contains(id)) appliedIds.Add(id);
                        }
                    }

                    doc.Regenerate();
                    after = resolved.Select(SnapshotElement).ToList();

                    if (shouldApply)
                    {
                        t.Commit();
                    }
                    else
                    {
                        t.RollBack();
                    }
                }
                catch (Exception ex)
                {
                    transactionFailures.Add(ex.Message);
                    try { t.RollBack(); } catch { }
                    throw;
                }
            }

            object? capture = null;
            if (shouldApply && p.visualVerify)
            {
                var captureRequest = new RevitBridge.Logic.Handlers.HighlightAndExportHandler.Params
                {
                    viewId = p.visualViewId,
                    elementIds = ids,
                    focusElementIds = ids,
                    traceElementCurves = true,
                    imageSize = p.imageSize <= 0 ? 1600 : p.imageSize,
                    focusPaddingFt = p.focusPaddingFt <= 0 ? 3.0 : p.focusPaddingFt,
                    overrideStyle = new RevitBridge.Logic.Handlers.HighlightAndExportHandler.OverrideStyle { lineWeight = 14, r = 0, g = 170, b = 255 }
                };
                capture = new RevitBridge.Logic.Handlers.HighlightAndExportHandler()
                    .Handle(app, JsonSerializer.Serialize(captureRequest))
                    .GetAwaiter()
                    .GetResult();
            }

            object? networkAudit = null;
            if (p.verify && shouldApply && ids.Count > 0)
            {
                networkAudit = new TraceConnectedNetworkHandler().Handle(app, JsonSerializer.Serialize(new TraceConnectedNetworkHandler.Params
                {
                    startElementId = ids[0],
                    includeSystemAudit = true,
                    maxElements = 500,
                    systemAuditMaxElements = 5000
                })).GetAwaiter().GetResult();
            }

            return Task.FromResult<object>(new
            {
                status = shouldApply ? "Edited" : "Dry Run",
                kind = normalizedKind,
                dryRun = !shouldApply,
                elementIds = ids,
                plan = new
                {
                    changesSize,
                    requestedSize = sizeChoice == null ? null : sizeChoice.RequestedText,
                    parsedSize = sizeChoice == null ? null : new { sizeChoice.WidthFt, sizeChoice.HeightFt, sizeChoice.DiameterFt },
                    changesElevation,
                    elevationPlan,
                    allowConnectedElevationMove = p.allowConnectedElevationMove
                },
                before,
                after,
                appliedIds = shouldApply ? appliedIds.Distinct().ToList() : new List<long>(),
                sizeResults,
                warnings,
                transactionFailures,
                verification = new
                {
                    openConnectorCountBefore = before.Sum(x => GetInt(x, "openConnectorCount")),
                    openConnectorCountAfter = after.Sum(x => GetInt(x, "openConnectorCount")),
                    connectedConnectorCountBefore = before.Sum(x => GetInt(x, "connectedConnectorCount")),
                    connectedConnectorCountAfter = after.Sum(x => GetInt(x, "connectedConnectorCount")),
                    networkAudit
                },
                visualVerification = capture
            });
        }

        private static bool HasSizeRequest(Params p)
        {
            return !string.IsNullOrWhiteSpace(p.ductSize) ||
                   !string.IsNullOrWhiteSpace(p.diameter) ||
                   !string.IsNullOrWhiteSpace(p.pipeSize);
        }

        private static List<Element> ResolveElements(Document doc, IEnumerable<long> ids, string kind)
        {
            var resolved = new List<Element>();
            foreach (var id in ids)
            {
                var e = doc.GetElement(ElementIdCompat.Create(id));
                if (e == null) throw new InvalidOperationException($"Element {id} not found.");
                if (kind == "pipe" && e is not Pipe) throw new InvalidOperationException($"Element {id} is not a pipe.");
                if (kind == "duct" && e is not Duct) throw new InvalidOperationException($"Element {id} is not a duct.");
                if (e.Location is not LocationCurve lc || lc.Curve is not Line)
                {
                    throw new InvalidOperationException($"Element {id} is not a straight MEP curve.");
                }
                resolved.Add(e);
            }
            return resolved;
        }

        private static MepRouteElementEditPlanner.CurveInput ToPlannerCurveInput(Element e)
        {
            var lc = (LocationCurve)e.Location;
            var curve = lc.Curve;
            var p0 = curve.GetEndPoint(0);
            var p1 = curve.GetEndPoint(1);
            return new MepRouteElementEditPlanner.CurveInput
            {
                ElementId = ElementIdCompat.GetValue(e.Id),
                StartXyz = new[] { p0.X, p0.Y, p0.Z },
                EndXyz = new[] { p1.X, p1.Y, p1.Z }
            };
        }

        private static Dictionary<string, object> SnapshotElement(Element e)
        {
            var id = ElementIdCompat.GetValue(e.Id);
            var connectors = MepRoutingUtil.GetConnectors(e);
            var connected = 0;
            var open = 0;
            foreach (var c in connectors)
            {
                try
                {
                    if (c.IsConnected) connected++;
                    else open++;
                }
                catch
                {
                    open++;
                }
            }

            var data = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase)
            {
                { "id", id },
                { "category", e.Category?.Name ?? "" },
                { "typeId", ElementIdCompat.GetValue(e.GetTypeId()) },
                { "systemName", MepSystemUtil.TryGetSystemName(e) ?? "" },
                { "connectorCount", connectors.Count },
                { "connectedConnectorCount", connected },
                { "openConnectorCount", open },
                { "size", SnapshotSize(e) }
            };

            if (e.Location is LocationCurve lc)
            {
                var p0 = lc.Curve.GetEndPoint(0);
                var p1 = lc.Curve.GetEndPoint(1);
                data["startXyz"] = new[] { p0.X, p0.Y, p0.Z };
                data["endXyz"] = new[] { p1.X, p1.Y, p1.Z };
                data["centerlineZFt"] = (p0.Z + p1.Z) * 0.5;
                data["lengthFt"] = p0.DistanceTo(p1);
            }

            return data;
        }

        private static object SnapshotSize(Element e)
        {
            if (e is Pipe)
            {
                return new { diameterFt = GetBuiltinDouble(e, BuiltInParameter.RBS_PIPE_DIAMETER_PARAM) };
            }
            return new
            {
                widthFt = GetBuiltinDouble(e, BuiltInParameter.RBS_CURVE_WIDTH_PARAM),
                heightFt = GetBuiltinDouble(e, BuiltInParameter.RBS_CURVE_HEIGHT_PARAM),
                diameterFt = GetBuiltinDouble(e, BuiltInParameter.RBS_CURVE_DIAMETER_PARAM)
            };
        }

        private static double? GetBuiltinDouble(Element e, BuiltInParameter bip)
        {
            try
            {
                var p = e.get_Parameter(bip);
                if (p == null || !p.HasValue || p.StorageType != StorageType.Double) return null;
                return p.AsDouble();
            }
            catch
            {
                return null;
            }
        }

        private static int GetInt(Dictionary<string, object> obj, string key)
        {
            if (!obj.TryGetValue(key, out var value) || value == null) return 0;
            if (value is int i) return i;
            if (value is long l) return (int)l;
            if (int.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)) return parsed;
            return 0;
        }

        private static long GetLong(Dictionary<string, object> obj, string key)
        {
            if (!obj.TryGetValue(key, out var value) || value == null) return 0;
            if (value is long l) return l;
            if (value is int i) return i;
            if (long.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)) return parsed;
            return 0;
        }

        private sealed class PhysicalConnectionSnapshot
        {
            public long? ConnectorId { get; set; }
            public XYZ Origin { get; set; } = XYZ.Zero;
            public long ConnectedOwnerId { get; set; }
        }

        private static object HandleEndpointEdit(Document doc, Params p, string normalizedKind, bool shouldApply)
        {
            var edit = p.endpointEdit ?? throw new InvalidOperationException("endpointEdit is required.");
            if (p.elementIds.Count != 1 || p.elementIds[0] != edit.elementId)
                throw new ArgumentException("Endpoint edit requires elementIds to contain exactly endpointEdit.elementId.");
            if (edit.endpointIndex != 0 && edit.endpointIndex != 1)
                throw new ArgumentException("endpointEdit.endpointIndex must be 0 or 1.");
            if (!HasPoint(edit.expectedEndpointXyz) || !HasPoint(edit.targetEndpointXyz))
                throw new ArgumentException("endpointEdit requires finite expectedEndpointXyz and targetEndpointXyz arrays.");
            if (edit.coordinateToleranceFt <= 0 || edit.coordinateToleranceFt > 0.25 ||
                double.IsNaN(edit.coordinateToleranceFt) || double.IsInfinity(edit.coordinateToleranceFt))
                throw new ArgumentException("endpointEdit.coordinateToleranceFt must be greater than zero and no more than 0.25 ft.");

            var element = ResolveElements(doc, p.elementIds, normalizedKind).Single();
            var location = element.Location as LocationCurve
                ?? throw new InvalidOperationException("The requested MEP curve has no LocationCurve.");
            if (location.Curve is not Line originalLine)
                throw new InvalidOperationException("Endpoint edit requires a straight MEP curve.");

            var originalStart = originalLine.GetEndPoint(0);
            var originalEnd = originalLine.GetEndPoint(1);
            var expected = ToXyz(edit.expectedEndpointXyz!);
            var target = ToXyz(edit.targetEndpointXyz!);
            var originalEdited = edit.endpointIndex == 0 ? originalStart : originalEnd;
            var fixedEndpoint = edit.endpointIndex == 0 ? originalEnd : originalStart;
            var expectedDelta = originalEdited.DistanceTo(expected);
            if (expectedDelta > edit.coordinateToleranceFt)
                throw new InvalidOperationException($"Endpoint origin guard failed by {expectedDelta:F6} ft (tolerance {edit.coordinateToleranceFt:F6} ft).");
            if (fixedEndpoint.DistanceTo(target) <= 0.01)
                throw new InvalidOperationException("Endpoint edit would create a curve shorter than 0.01 ft.");

            var originalConnectors = MepRoutingUtil.GetConnectors(element);
            var editedConnector = originalConnectors.OrderBy(c => c.Origin.DistanceTo(originalEdited)).FirstOrDefault()
                ?? throw new InvalidOperationException("The edited endpoint has no resolvable connector.");
            if (editedConnector.Origin.DistanceTo(originalEdited) > Math.Max(edit.coordinateToleranceFt, 0.01))
                throw new InvalidOperationException("No connector is located at the guarded endpoint.");
            if (edit.requireEditedEndpointOpen && PhysicalConnectedOwnerIds(editedConnector).Count > 0)
                throw new InvalidOperationException("The edited endpoint is physically connected; edit a verified open endpoint only.");

            var preexistingConnections = CapturePhysicalConnections(element);
            var before = SnapshotElement(element);
            Dictionary<string, object>? after = null;
            var postCommitVerified = false;
            var rolledBack = false;
            var rollbackVerified = false;
            var failures = new List<string>();

            using (var group = new TransactionGroup(doc, "Edit MEP Curve Endpoint"))
            {
                group.Start();
                try
                {
                    using (var tx = new Transaction(doc, "Edit MEP Curve Endpoint"))
                    {
                        tx.Start();
                        location.Curve = edit.endpointIndex == 0
                            ? Line.CreateBound(target, originalEnd)
                            : Line.CreateBound(originalStart, target);
                        doc.Regenerate();

                        VerifyEndpointEdit(element, edit.endpointIndex, target, edit.coordinateToleranceFt, edit.requireEditedEndpointOpen, edit.preserveExistingPhysicalConnections, preexistingConnections);
                        after = SnapshotElement(element);
                        tx.Commit();
                    }

                    var committedElement = doc.GetElement(element.Id)
                        ?? throw new InvalidOperationException("The edited MEP curve did not survive transaction commit.");
                    VerifyEndpointEdit(committedElement, edit.endpointIndex, target, edit.coordinateToleranceFt, edit.requireEditedEndpointOpen, edit.preserveExistingPhysicalConnections, preexistingConnections);
                    postCommitVerified = true;

                    if (shouldApply)
                    {
                        group.Assimilate();
                        rollbackVerified = postCommitVerified;
                    }
                    else
                    {
                        group.RollBack();
                        rolledBack = true;
                        var restored = doc.GetElement(element.Id)
                            ?? throw new InvalidOperationException("Dry-run rollback did not restore the edited MEP curve.");
                        VerifyCurveEndpoints(restored, originalStart, originalEnd, edit.coordinateToleranceFt);
                        if (FindMissingPhysicalConnections(restored, preexistingConnections, Math.Max(edit.coordinateToleranceFt, 0.01)).Count > 0)
                            throw new InvalidOperationException("Dry-run rollback did not restore all pre-existing physical connections.");
                        rollbackVerified = true;
                    }
                }
                catch (Exception ex)
                {
                    failures.Add(ex.Message);
                    try
                    {
                        group.RollBack();
                        rolledBack = true;
                        var restored = doc.GetElement(element.Id);
                        rollbackVerified = restored != null && CurveEndpointsMatch(restored, originalStart, originalEnd, edit.coordinateToleranceFt) &&
                            FindMissingPhysicalConnections(restored, preexistingConnections, Math.Max(edit.coordinateToleranceFt, 0.01)).Count == 0;
                    }
                    catch (Exception rollbackError)
                    {
                        failures.Add($"Rollback failed: {rollbackError.Message}");
                    }
                }
            }

            var ok = failures.Count == 0 && rollbackVerified;
            return new
            {
                status = ok ? (shouldApply ? "Edited" : "DryRunReady") : "Blocked",
                kind = normalizedKind,
                dryRun = !shouldApply,
                elementId = edit.elementId,
                endpointIndex = edit.endpointIndex,
                expectedEndpoint = ToPoint(expected),
                targetEndpoint = ToPoint(target),
                coordinateToleranceFt = edit.coordinateToleranceFt,
                requireEditedEndpointOpen = edit.requireEditedEndpointOpen,
                preserveExistingPhysicalConnections = edit.preserveExistingPhysicalConnections,
                preexistingPhysicalConnections = preexistingConnections.Select(DescribePhysicalConnection).ToList(),
                before,
                after,
                postCommitVerified,
                transactionGroupRolledBack = rolledBack,
                rollbackVerified,
                failures,
                nextAction = ok && !shouldApply
                    ? "Apply this exact one-endpoint edit only if the guarded endpoint, retained connections, post-commit proof, and rollback proof are accepted."
                    : null
            };
        }

        private static object HandleDirectionEdit(Document doc, Params p, string normalizedKind, bool shouldApply)
        {
            var edit = p.directionEdit ?? throw new InvalidOperationException("directionEdit is required.");
            if (p.elementIds.Count != 1 || p.elementIds[0] != edit.elementId) throw new ArgumentException("Direction edit requires elementIds to contain exactly directionEdit.elementId.");
            if (!HasPoint(edit.expectedStartXyz) || !HasPoint(edit.expectedEndXyz)) throw new ArgumentException("directionEdit requires finite expectedStartXyz and expectedEndXyz arrays.");
            if (edit.coordinateToleranceFt <= 0 || edit.coordinateToleranceFt > 0.25 || double.IsNaN(edit.coordinateToleranceFt) || double.IsInfinity(edit.coordinateToleranceFt)) throw new ArgumentException("directionEdit.coordinateToleranceFt must be greater than zero and no more than 0.25 ft.");
            var element = ResolveElements(doc, p.elementIds, normalizedKind).Single();
            if (element.Location is not LocationCurve location || location.Curve is not Line originalLine) throw new InvalidOperationException("Direction edit requires a straight MEP curve.");
            var originalStart = originalLine.GetEndPoint(0);
            var originalEnd = originalLine.GetEndPoint(1);
            var expectedStart = ToXyz(edit.expectedStartXyz!);
            var expectedEnd = ToXyz(edit.expectedEndXyz!);
            if (originalStart.DistanceTo(expectedStart) > edit.coordinateToleranceFt || originalEnd.DistanceTo(expectedEnd) > edit.coordinateToleranceFt) throw new InvalidOperationException("Direction edit start/end guard does not match the current curve direction.");
            var preexistingConnections = CapturePhysicalConnections(element);
            var before = SnapshotElement(element);
            Dictionary<string, object>? after = null;
            var postCommitVerified = false;
            var rolledBack = false;
            var rollbackVerified = false;
            var failures = new List<string>();
            using (var group = new TransactionGroup(doc, "Reverse MEP Curve Direction"))
            {
                group.Start();
                try
                {
                    using (var tx = new Transaction(doc, "Reverse MEP Curve Direction"))
                    {
                        tx.Start();
                        location.Curve = Line.CreateBound(originalEnd, originalStart);
                        doc.Regenerate();
                        VerifyDirectionEdit(element, originalEnd, originalStart, edit.coordinateToleranceFt, edit.preserveExistingPhysicalConnections, preexistingConnections);
                        after = SnapshotElement(element);
                        tx.Commit();
                    }
                    var committedElement = doc.GetElement(element.Id) ?? throw new InvalidOperationException("The reversed MEP curve did not survive transaction commit.");
                    VerifyDirectionEdit(committedElement, originalEnd, originalStart, edit.coordinateToleranceFt, edit.preserveExistingPhysicalConnections, preexistingConnections);
                    postCommitVerified = true;
                    if (shouldApply) { group.Assimilate(); rollbackVerified = true; }
                    else
                    {
                        group.RollBack(); rolledBack = true;
                        var restored = doc.GetElement(element.Id) ?? throw new InvalidOperationException("Dry-run rollback did not restore the reversed MEP curve.");
                        VerifyCurveEndpoints(restored, originalStart, originalEnd, edit.coordinateToleranceFt);
                        if (FindMissingPhysicalConnections(restored, preexistingConnections, Math.Max(edit.coordinateToleranceFt, 0.01)).Count > 0) throw new InvalidOperationException("Dry-run rollback did not restore all pre-existing physical connections.");
                        rollbackVerified = true;
                    }
                }
                catch (Exception ex)
                {
                    failures.Add(ex.Message);
                    try
                    {
                        group.RollBack(); rolledBack = true;
                        var restored = doc.GetElement(element.Id);
                        rollbackVerified = restored != null && CurveEndpointsMatch(restored, originalStart, originalEnd, edit.coordinateToleranceFt) && FindMissingPhysicalConnections(restored, preexistingConnections, Math.Max(edit.coordinateToleranceFt, 0.01)).Count == 0;
                    }
                    catch (Exception rollbackError) { failures.Add($"Rollback failed: {rollbackError.Message}"); }
                }
            }
            var ok = failures.Count == 0 && rollbackVerified;
            return new
            {
                status = ok ? (shouldApply ? "Edited" : "DryRunReady") : "Blocked",
                kind = normalizedKind,
                dryRun = !shouldApply,
                elementId = edit.elementId,
                directionReversed = ok && shouldApply,
                expectedStart = ToPoint(expectedStart),
                expectedEnd = ToPoint(expectedEnd),
                targetStart = ToPoint(originalEnd),
                targetEnd = ToPoint(originalStart),
                coordinateToleranceFt = edit.coordinateToleranceFt,
                preserveExistingPhysicalConnections = edit.preserveExistingPhysicalConnections,
                preexistingPhysicalConnections = preexistingConnections.Select(DescribePhysicalConnection).ToList(),
                before,
                after,
                postCommitVerified,
                transactionGroupRolledBack = rolledBack,
                rollbackVerified,
                failures,
                nextAction = ok && !shouldApply ? "Apply this exact curve-direction reversal only if the unchanged geometry, retained topology, post-commit proof, and rollback proof are accepted." : null
            };
        }

        private static void VerifyDirectionEdit(Element element, XYZ expectedStart, XYZ expectedEnd, double toleranceFt, bool preserveConnections, IReadOnlyList<PhysicalConnectionSnapshot> preexistingConnections)
        {
            VerifyCurveEndpoints(element, expectedStart, expectedEnd, toleranceFt);
            if (preserveConnections)
            {
                var missing = FindMissingPhysicalConnections(element, preexistingConnections, Math.Max(toleranceFt, 0.01));
                if (missing.Count > 0) throw new InvalidOperationException($"Direction edit disconnected retained topology: {string.Join("; ", missing)}");
            }
        }

        private static void VerifyEndpointEdit(Element element, int endpointIndex, XYZ target, double toleranceFt, bool requireEditedEndpointOpen, bool preserveExistingPhysicalConnections, IReadOnlyList<PhysicalConnectionSnapshot> preexistingConnections)
        {
            if (element.Location is not LocationCurve location || location.Curve is not Line line)
                throw new InvalidOperationException("The edited element is no longer a straight MEP curve.");
            var actual = line.GetEndPoint(endpointIndex);
            if (actual.DistanceTo(target) > toleranceFt)
                throw new InvalidOperationException("The edited curve endpoint does not match the requested target.");
            var connector = MepRoutingUtil.GetConnectors(element).OrderBy(c => c.Origin.DistanceTo(actual)).FirstOrDefault()
                ?? throw new InvalidOperationException("The edited endpoint connector could not be re-resolved.");
            if (connector.Origin.DistanceTo(actual) > Math.Max(toleranceFt, 0.01))
                throw new InvalidOperationException("The edited endpoint connector does not match the requested target.");
            if (requireEditedEndpointOpen && PhysicalConnectedOwnerIds(connector).Count > 0)
                throw new InvalidOperationException("The edited endpoint unexpectedly became physically connected.");
            if (preserveExistingPhysicalConnections)
            {
                var missing = FindMissingPhysicalConnections(element, preexistingConnections, Math.Max(toleranceFt, 0.01));
                if (missing.Count > 0)
                    throw new InvalidOperationException($"Endpoint edit disconnected retained topology: {string.Join("; ", missing)}");
            }
        }

        private static void VerifyCurveEndpoints(Element element, XYZ expectedStart, XYZ expectedEnd, double toleranceFt)
        {
            if (!CurveEndpointsMatch(element, expectedStart, expectedEnd, toleranceFt))
                throw new InvalidOperationException("MEP curve endpoints do not match the rollback baseline.");
        }

        private static bool CurveEndpointsMatch(Element element, XYZ expectedStart, XYZ expectedEnd, double toleranceFt)
        {
            if (element.Location is not LocationCurve location || location.Curve is not Line line) return false;
            return line.GetEndPoint(0).DistanceTo(expectedStart) <= toleranceFt && line.GetEndPoint(1).DistanceTo(expectedEnd) <= toleranceFt;
        }

        private static List<PhysicalConnectionSnapshot> CapturePhysicalConnections(Element owner)
        {
            var result = new List<PhysicalConnectionSnapshot>();
            foreach (var connector in MepRoutingUtil.GetConnectors(owner))
            {
                var connectorId = MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId) ? nativeId : (long?)null;
                foreach (var connectedOwnerId in PhysicalConnectedOwnerIds(connector))
                    result.Add(new PhysicalConnectionSnapshot { ConnectorId = connectorId, Origin = connector.Origin, ConnectedOwnerId = connectedOwnerId });
            }
            return result;
        }

        private static List<string> FindMissingPhysicalConnections(Element owner, IEnumerable<PhysicalConnectionSnapshot> expected, double toleranceFt)
        {
            var connectors = MepRoutingUtil.GetConnectors(owner);
            var missing = new List<string>();
            foreach (var edge in expected)
            {
                var connector = edge.ConnectorId.HasValue
                    ? connectors.FirstOrDefault(candidate => MepSystemUtil.TryGetNativeConnectorId(candidate, out var nativeId) && nativeId == edge.ConnectorId.Value)
                    : connectors.OrderBy(candidate => candidate.Origin.DistanceTo(edge.Origin)).FirstOrDefault();
                if (connector == null || connector.Origin.DistanceTo(edge.Origin) > toleranceFt)
                    connector = connectors.OrderBy(candidate => candidate.Origin.DistanceTo(edge.Origin)).FirstOrDefault();
                if (connector == null || connector.Origin.DistanceTo(edge.Origin) > toleranceFt || !PhysicalConnectedOwnerIds(connector).Contains(edge.ConnectedOwnerId))
                    missing.Add($"connector {edge.ConnectorId?.ToString() ?? "origin_guard"} -> owner {edge.ConnectedOwnerId}");
            }
            return missing;
        }

        private static List<long> PhysicalConnectedOwnerIds(Connector connector)
        {
            var result = new HashSet<long>();
            try
            {
                foreach (Connector reference in connector.AllRefs)
                {
                    var owner = reference?.Owner;
                    if (owner == null || owner is MEPSystem || owner.Id == connector.Owner?.Id) continue;
                    result.Add(ElementIdCompat.GetValue(owner.Id));
                }
            }
            catch { }
            return result.OrderBy(id => id).ToList();
        }

        private static object DescribePhysicalConnection(PhysicalConnectionSnapshot edge) => new { connectorId = edge.ConnectorId, origin = ToPoint(edge.Origin), connectedOwnerId = edge.ConnectedOwnerId };

        private static bool HasPoint(double[]? point) => point != null && point.Length == 3 && point.All(value => !double.IsNaN(value) && !double.IsInfinity(value));

        private static XYZ ToXyz(double[] point) => new XYZ(point[0], point[1], point[2]);

        private static double[] ToPoint(XYZ point) => new[] { point.X, point.Y, point.Z };

        private static void GuardExpectedModelPath(Document doc, string? expectedModelPath)
        {
            if (string.IsNullOrWhiteSpace(expectedModelPath)) return;
            var actual = string.IsNullOrWhiteSpace(doc.PathName) ? "" : Path.GetFullPath(doc.PathName);
            var expected = Path.GetFullPath(expectedModelPath.Trim());
            if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"Active model path '{actual}' does not match expectedModelPath '{expected}'.");
        }
    }
}
