using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class RerouteMepRouteSegmentHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string kind { get; set; } = "duct";
            public long hostElementId { get; set; }
            public double? split1ChainageFt { get; set; }
            public double? split2ChainageFt { get; set; }
            public double? split1Normalized { get; set; }
            public double? split2Normalized { get; set; }
            public double? transitionChainageFt { get; set; }
            public double? transitionNormalized { get; set; }
            public string? offsetMode { get; set; } = "orthogonal";
            public double? doglegAngleDegrees { get; set; }
            public OffsetVector offsetVector { get; set; } = new OffsetVector();
            public string? upstreamDuctSize { get; set; }
            public string? downstreamDuctSize { get; set; }
            public string? upstreamPipeSize { get; set; }
            public string? downstreamPipeSize { get; set; }
            public string? upstreamDiameter { get; set; }
            public string? downstreamDiameter { get; set; }
            public string? sizePolicy { get; set; } = "explicit_required";
            public bool dryRun { get; set; } = true;
            public bool apply { get; set; } = false;
            public bool verify { get; set; } = true;
            public bool visualVerify { get; set; } = false;
            public bool preserveConnectedEndpoints { get; set; } = false;
            public long? visualViewId { get; set; }
            public int imageSize { get; set; } = 1800;
            public double focusPaddingFt { get; set; } = 4.0;
            public string? systemType { get; set; }
        }

        public sealed class OffsetVector
        {
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var kind = MepRoutingUtil.NormalizeKind(p.kind);
            var shouldApply = p.apply || !p.dryRun;
            var warnings = new List<string>();
            if (p.hostElementId <= 0) throw new ArgumentException("hostElementId is required.");

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            var host = doc.GetElement(ElementIdCompat.Create(p.hostElementId)) ?? throw new InvalidOperationException($"Element {p.hostElementId} not found.");
            if (kind == "duct" && host is not Duct) throw new InvalidOperationException($"Element {p.hostElementId} is not a duct.");
            if (kind == "pipe" && host is not Pipe) throw new InvalidOperationException($"Element {p.hostElementId} is not a pipe.");
            if (host.Location is not LocationCurve lc || lc.Curve is not Line curve)
                throw new InvalidOperationException("Reroute currently supports one straight duct or pipe curve.");

            var start = curve.GetEndPoint(0);
            var end = curve.GetEndPoint(1);
            var hostConnectors = MepRoutingUtil.GetConnectors(host);
            var endpointConnections = CollectEndpointConnections(doc, host, hostConnectors, start, end);
            var connectedEndpointCount = hostConnectors.Count(c => SafeIsConnected(c));
            if (connectedEndpointCount > 0 && endpointConnections.Count != connectedEndpointCount)
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    blockCode = "connected_host_endpoint_unresolved",
                    reason = "Connected endpoint preservation requires every connected host connector to resolve to an external connector at the original start or end point.",
                    host = SnapshotElement(host),
                    connectedEndpointCount,
                    endpointReconnectionPlan = endpointConnections.Select(x => x.ToResponse()).ToList(),
                    warnings
                });
            }

            if (shouldApply && connectedEndpointCount > 0 && !p.preserveConnectedEndpoints)
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    blockCode = "connected_host_requires_preserve_connected_endpoints",
                    reason = "The host has connected endpoints. Set preserveConnectedEndpoints:true to explicitly reconnect the replacement route to the original external endpoint connectors.",
                    host = SnapshotElement(host),
                    connectedEndpointCount,
                    endpointReconnectionPlan = endpointConnections.Select(x => x.ToResponse()).ToList(),
                    warnings
                });
            }

            var offsetMode = NormalizeOffsetMode(p.offsetMode);
            var offsetVector = new BranchPoint3d(p.offsetVector.x, p.offsetVector.y, p.offsetVector.z);
            var plan = offsetMode == "dogleg45"
                ? MepRouteReroutePlanner.PlanDoglegOffsetReroute(
                    ToPoint(start),
                    ToPoint(end),
                    p.split1ChainageFt,
                    p.split2ChainageFt,
                    p.split1Normalized,
                    p.split2Normalized,
                    offsetVector,
                    p.doglegAngleDegrees ?? 45.0)
                : MepRouteReroutePlanner.PlanOffsetReroute(
                    ToPoint(start),
                    ToPoint(end),
                    p.split1ChainageFt,
                    p.split2ChainageFt,
                    p.split1Normalized,
                    p.split2Normalized,
                    offsetVector);

            var selected = BuildSelected(doc, host, kind, p.systemType);
            var size = BuildExistingSizeChoice(host, kind);
            var hostSnapshot = SnapshotElement(host);
            var sizeTransitionRequested = p.transitionChainageFt.HasValue || p.transitionNormalized.HasValue ||
                HasText(p.upstreamDuctSize) || HasText(p.downstreamDuctSize) ||
                HasText(p.upstreamPipeSize) || HasText(p.downstreamPipeSize) ||
                HasText(p.upstreamDiameter) || HasText(p.downstreamDiameter);

            if (sizeTransitionRequested)
            {
                return Task.FromResult(HandleSizeTransition(app, doc, host, kind, p, shouldApply, selected, size, hostSnapshot, warnings));
            }

            if (!plan.ApplySupported)
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    dryRun = !shouldApply,
                    kind,
                    operation = offsetMode == "dogleg45" ? "offset_dogleg45" : "offset_orthogonal",
                    blockCode = plan.BlockCode,
                    reason = plan.BlockReason,
                    host = hostSnapshot,
                    selected = selected.response,
                    plan,
                    warnings
                });
            }

            if (!shouldApply)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    kind,
                    operation = offsetMode == "dogleg45" ? "offset_dogleg45" : "offset_orthogonal",
                    host = hostSnapshot,
                    selected = selected.response,
                    size = SizeResponse(size),
                    plan,
                    expectedFitting = "elbow",
                    endpointReconnectionPlan = endpointConnections.Select(x => x.ToResponse()).ToList(),
                    warnings
                });
            }

            var createdIds = new List<long>();
            var createdFittingIds = new List<long>();
            var connectionAttempts = new List<object>();
            var deletedOriginalIds = new List<long>();
            var createdElements = new List<Element>();
            var nativeFailures = new List<CapturedFailure>();
            var transactionStatus = "";

            using (var tx = new Transaction(doc, "Reroute MEP Route Segment"))
            {
                try
                {
                    tx.Start();
                    tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(tx, nativeFailures, rollbackOnErrors: true, deleteWarnings: false));

                    foreach (var segment in plan.Segments)
                    {
                        var created = CreateLikeHost(doc, host, kind, selected, size, segment);
                        createdElements.Add(created);
                        createdIds.Add(ElementIdCompat.GetValue(created.Id));
                    }

                    doc.Regenerate();

                    for (var i = 0; i < createdElements.Count - 1; i++)
                    {
                        var shared = ToXyz(plan.Segments[i].End);
                        var a = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(createdElements[i]), shared, 0.3);
                        var b = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(createdElements[i + 1]), shared, 0.3);
                        var ok = MepRoutingUtil.TryCreateElbowOrConnect(doc, a, b, out var fittingId, out var method, out var err);
                        connectionAttempts.Add(new
                        {
                            fromId = createdIds[i],
                            toId = createdIds[i + 1],
                            point = ToResponsePoint(shared),
                            expectedFitting = "elbow",
                            connected = ok,
                            method,
                            fittingId,
                            error = err
                        });
                        if (!ok) throw new InvalidOperationException($"Could not connect reroute segment {i} to {i + 1}: {err}");
                        if (fittingId.HasValue) createdFittingIds.Add(fittingId.Value);
                    }

                    doc.Regenerate();
                    var deleted = doc.Delete(host.Id);
                    deletedOriginalIds.AddRange(deleted.Select(ElementIdCompat.GetValue).Where(x => x > 0));
                    doc.Regenerate();

                    foreach (var endpoint in endpointConnections)
                    {
                        var replacement = endpoint.IsStart ? createdElements.FirstOrDefault() : createdElements.LastOrDefault();
                        var replacementPoint = endpoint.IsStart ? start : end;
                        var replacementConnector = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(replacement!), replacementPoint, 0.3);
                        var external = endpoint.ResolveConnector(doc);
                        var ok = MepRoutingUtil.TryCreateElbowOrConnect(doc, replacementConnector, external, out var fittingId, out var method, out var err);
                        connectionAttempts.Add(new
                        {
                            fromId = ElementIdCompat.GetValue(replacement!.Id),
                            toExternalId = endpoint.ExternalOwnerId,
                            endpoint = endpoint.Endpoint,
                            point = ToResponsePoint(replacementPoint),
                            expectedFitting = "preserve_endpoint_connection",
                            connected = ok,
                            method,
                            fittingId,
                            error = err
                        });
                        if (!ok) throw new InvalidOperationException($"Could not reconnect reroute endpoint '{endpoint.Endpoint}' to original external connector: {err}");
                        if (fittingId.HasValue) createdFittingIds.Add(fittingId.Value);
                    }

                    doc.Regenerate();
                    var st = tx.Commit();
                    transactionStatus = st.ToString();
                    if (st != TransactionStatus.Committed)
                    {
                        return Task.FromResult<object>(new
                        {
                            status = "Blocked",
                            dryRun = false,
                            kind,
                            operation = offsetMode == "dogleg45" ? "offset_dogleg45" : "offset_orthogonal",
                            blockCode = "native_revit_failure",
                            reason = "Revit rejected the reroute transaction; the transaction was rolled back before committing.",
                            host = hostSnapshot,
                            selected = selected.response,
                            plan,
                            transactionStatus,
                            nativeFailures,
                            attemptedCreatedElementIds = createdIds,
                            attemptedCreatedFittingIds = createdFittingIds.Distinct().ToList(),
                            connectionAttempts,
                            endpointReconnectionPlan = endpointConnections.Select(x => x.ToResponse()).ToList(),
                            warnings
                        });
                    }
                }
                catch (Exception ex)
                {
                    try { if (tx.GetStatus() == TransactionStatus.Started) tx.RollBack(); } catch { }
                    if (nativeFailures.Count > 0)
                    {
                        return Task.FromResult<object>(new
                        {
                            status = "Blocked",
                            dryRun = false,
                            kind,
                            operation = offsetMode == "dogleg45" ? "offset_dogleg45" : "offset_orthogonal",
                            blockCode = "native_revit_failure",
                            reason = "Revit rejected the reroute transaction; the transaction was rolled back before committing.",
                            host = hostSnapshot,
                            selected = selected.response,
                            plan,
                            transactionStatus,
                            nativeFailures,
                            exceptionMessage = ex.Message,
                            attemptedCreatedElementIds = createdIds,
                            attemptedCreatedFittingIds = createdFittingIds.Distinct().ToList(),
                            connectionAttempts,
                            endpointReconnectionPlan = endpointConnections.Select(x => x.ToResponse()).ToList(),
                            warnings
                        });
                    }
                    throw;
                }
            }

            var allIds = createdIds.Concat(createdFittingIds).Distinct().ToList();
            object? networkAudit = null;
            if (p.verify && createdIds.Count > 0)
            {
                networkAudit = new TraceConnectedNetworkHandler().Handle(app, JsonSerializer.Serialize(new TraceConnectedNetworkHandler.Params
                {
                    startElementId = createdIds[0],
                    includeSystemAudit = true,
                    maxElements = 500,
                    systemAuditMaxElements = 5000
                })).GetAwaiter().GetResult();
            }

            object visualVerification = new { status = "SkippedByRequest" };
            if (p.visualVerify && allIds.Count > 0)
            {
                visualVerification = new HighlightAndExportHandler().Handle(app, JsonSerializer.Serialize(new HighlightAndExportHandler.Params
                {
                    viewId = p.visualViewId,
                    elementIds = allIds,
                    focusElementIds = createdIds,
                    traceElementCurves = true,
                    imageSize = p.imageSize <= 0 ? 1800 : p.imageSize,
                    focusPaddingFt = p.focusPaddingFt <= 0 ? 4.0 : p.focusPaddingFt,
                    overrideStyle = new HighlightAndExportHandler.OverrideStyle { lineWeight = 14, r = 0, g = 170, b = 255 }
                })).GetAwaiter().GetResult();
            }

            var after = createdIds.Select(id => doc.GetElement(ElementIdCompat.Create(id))).Where(e => e != null).Select(e => SnapshotElement(e!)).ToList();
            return Task.FromResult<object>(new
            {
                status = "Rerouted",
                dryRun = false,
                kind,
                operation = offsetMode == "dogleg45" ? "offset_dogleg45" : "offset_orthogonal",
                host = hostSnapshot,
                selected = selected.response,
                size = SizeResponse(size),
                plan,
                createdElementIds = createdIds,
                createdFittingIds = createdFittingIds.Distinct().ToList(),
                deletedOriginalIds = deletedOriginalIds.Distinct().ToList(),
                connectionAttempts,
                endpointReconnectionPlan = endpointConnections.Select(x => x.ToResponse()).ToList(),
                verification = new
                {
                    openConnectorCount = MepRoutingUtil.CountOpenConnectors(createdElements),
                    connectedConnectorCount = createdElements.Sum(e => MepRoutingUtil.GetConnectors(e).Count(c => SafeIsConnected(c))),
                    networkAudit
                },
                visualVerification,
                after,
                warnings
            });
        }

        private static object HandleSizeTransition(
            UIApplication app,
            Document doc,
            Element host,
            string kind,
            Params p,
            bool shouldApply,
            SelectedIds selected,
            MepRoutingUtil.SizeChoice existingSize,
            Dictionary<string, object> hostSnapshot,
            List<string> warnings)
        {
            if (host.Location is not LocationCurve lc || lc.Curve is not Line curve)
                throw new InvalidOperationException("Size transition currently supports one straight duct or pipe curve.");

            var endpointConnections = CollectEndpointConnections(doc, host, MepRoutingUtil.GetConnectors(host), curve.GetEndPoint(0), curve.GetEndPoint(1));
            var transitionPlan = MepRouteReroutePlanner.PlanSizeTransition(
                ToPoint(curve.GetEndPoint(0)),
                ToPoint(curve.GetEndPoint(1)),
                p.transitionChainageFt,
                p.transitionNormalized);

            var upstreamSize = ResolveTransitionSize(kind, p, upstream: true, warnings);
            var downstreamSize = ResolveTransitionSize(kind, p, upstream: false, warnings);
            var sizesDiffer = SizesDiffer(kind, upstreamSize, downstreamSize);
            if (!sizesDiffer && transitionPlan.ApplySupported)
            {
                transitionPlan.ApplySupported = false;
                transitionPlan.BlockCode = "transition_sizes_match";
                transitionPlan.BlockReason = "Upstream and downstream sizes must differ to create a required transition fitting.";
            }

            if (upstreamSize.Missing || downstreamSize.Missing)
            {
                transitionPlan.ApplySupported = false;
                transitionPlan.BlockCode = "missing_transition_size";
                transitionPlan.BlockReason = "Both upstream and downstream sizes are required for a guarded size transition.";
            }

            if (!transitionPlan.ApplySupported)
            {
                return new
                {
                    status = "Blocked",
                    dryRun = !shouldApply,
                    kind,
                    operation = "size_transition",
                    blockCode = transitionPlan.BlockCode,
                    reason = transitionPlan.BlockReason,
                    host = hostSnapshot,
                    selected = selected.response,
                    existingSize = SizeResponse(existingSize),
                    upstreamSize = SizeResponse(upstreamSize),
                    downstreamSize = SizeResponse(downstreamSize),
                    plan = transitionPlan,
                    warnings
                };
            }

            if (!shouldApply)
            {
                return new
                {
                    status = "Dry Run",
                    dryRun = true,
                    kind,
                    operation = "size_transition",
                    host = hostSnapshot,
                    selected = selected.response,
                    existingSize = SizeResponse(existingSize),
                    upstreamSize = SizeResponse(upstreamSize),
                    downstreamSize = SizeResponse(downstreamSize),
                    plan = transitionPlan,
                    expectedFitting = "transition",
                    endpointReconnectionPlan = endpointConnections.Select(x => x.ToResponse()).ToList(),
                    warnings
                };
            }

            var createdIds = new List<long>();
            var createdFittingIds = new List<long>();
            var deletedOriginalIds = new List<long>();
            var connectionAttempts = new List<object>();
            var createdElements = new List<Element>();

            using (var tx = new Transaction(doc, "Change MEP Route Size At Transition"))
            {
                tx.Start();
                try
                {
                    var upstream = CreateLikeHost(doc, host, kind, selected, upstreamSize, transitionPlan.Segments[0]);
                    var downstream = CreateLikeHost(doc, host, kind, selected, downstreamSize, transitionPlan.Segments[1]);
                    createdElements.Add(upstream);
                    createdElements.Add(downstream);
                    createdIds.Add(ElementIdCompat.GetValue(upstream.Id));
                    createdIds.Add(ElementIdCompat.GetValue(downstream.Id));
                    doc.Regenerate();

                    var shared = ToXyz(transitionPlan.TransitionPoint);
                    var a = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(upstream), shared, 0.3);
                    var b = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(downstream), shared, 0.3);
                    var ok = MepRoutingUtil.TryCreateTransitionElbowOrConnect(doc, a, b, preferTransition: true, out var fittingId, out var method, out var err);
                    connectionAttempts.Add(new
                    {
                        fromId = createdIds[0],
                        toId = createdIds[1],
                        point = ToResponsePoint(shared),
                        expectedFitting = "transition",
                        connected = ok,
                        method,
                        fittingId,
                        error = err
                    });
                    if (!ok) throw new InvalidOperationException($"Could not create required transition fitting at route size change: {err}");
                    if (fittingId.HasValue) createdFittingIds.Add(fittingId.Value);

                    doc.Regenerate();
                    var deleted = doc.Delete(host.Id);
                    deletedOriginalIds.AddRange(deleted.Select(ElementIdCompat.GetValue).Where(x => x > 0));
                    doc.Regenerate();

                    foreach (var endpoint in endpointConnections)
                    {
                        var replacement = endpoint.IsStart ? createdElements.FirstOrDefault() : createdElements.LastOrDefault();
                        var replacementPoint = endpoint.IsStart ? curve.GetEndPoint(0) : curve.GetEndPoint(1);
                        var replacementConnector = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(replacement!), replacementPoint, 0.3);
                        var external = endpoint.ResolveConnector(doc);
                        var endpointOk = MepRoutingUtil.TryCreateElbowOrConnect(doc, replacementConnector, external, out var endpointFittingId, out var endpointMethod, out var endpointErr);
                        connectionAttempts.Add(new
                        {
                            fromId = ElementIdCompat.GetValue(replacement!.Id),
                            toExternalId = endpoint.ExternalOwnerId,
                            endpoint = endpoint.Endpoint,
                            point = ToResponsePoint(replacementPoint),
                            expectedFitting = "preserve_endpoint_connection",
                            connected = endpointOk,
                            method = endpointMethod,
                            fittingId = endpointFittingId,
                            error = endpointErr
                        });
                        if (!endpointOk) throw new InvalidOperationException($"Could not reconnect size-transition endpoint '{endpoint.Endpoint}' to original external connector: {endpointErr}");
                        if (endpointFittingId.HasValue) createdFittingIds.Add(endpointFittingId.Value);
                    }

                    doc.Regenerate();
                    tx.Commit();
                }
                catch
                {
                    try { tx.RollBack(); } catch { }
                    throw;
                }
            }

            var allIds = createdIds.Concat(createdFittingIds).Distinct().ToList();
            object? networkAudit = null;
            if (p.verify && createdIds.Count > 0)
            {
                networkAudit = new TraceConnectedNetworkHandler().Handle(app, JsonSerializer.Serialize(new TraceConnectedNetworkHandler.Params
                {
                    startElementId = createdIds[0],
                    includeSystemAudit = true,
                    maxElements = 500,
                    systemAuditMaxElements = 5000
                })).GetAwaiter().GetResult();
            }

            object visualVerification = new { status = "SkippedByRequest" };
            if (p.visualVerify && allIds.Count > 0)
            {
                visualVerification = new HighlightAndExportHandler().Handle(app, JsonSerializer.Serialize(new HighlightAndExportHandler.Params
                {
                    viewId = p.visualViewId,
                    elementIds = allIds,
                    focusElementIds = createdIds,
                    traceElementCurves = true,
                    imageSize = p.imageSize <= 0 ? 1800 : p.imageSize,
                    focusPaddingFt = p.focusPaddingFt <= 0 ? 4.0 : p.focusPaddingFt,
                    overrideStyle = new HighlightAndExportHandler.OverrideStyle { lineWeight = 14, r = 0, g = 170, b = 255 }
                })).GetAwaiter().GetResult();
            }

            var after = createdIds.Select(id => doc.GetElement(ElementIdCompat.Create(id))).Where(e => e != null).Select(e => SnapshotElement(e!)).ToList();
            return new
            {
                status = "ChangedSizeAtTransition",
                dryRun = false,
                kind,
                operation = "size_transition",
                host = hostSnapshot,
                selected = selected.response,
                existingSize = SizeResponse(existingSize),
                upstreamSize = SizeResponse(upstreamSize),
                downstreamSize = SizeResponse(downstreamSize),
                plan = transitionPlan,
                createdElementIds = createdIds,
                createdFittingIds = createdFittingIds.Distinct().ToList(),
                deletedOriginalIds = deletedOriginalIds.Distinct().ToList(),
                connectionAttempts,
                endpointReconnectionPlan = endpointConnections.Select(x => x.ToResponse()).ToList(),
                verification = new
                {
                    openConnectorCount = MepRoutingUtil.CountOpenConnectors(createdElements),
                    connectedConnectorCount = createdElements.Sum(e => MepRoutingUtil.GetConnectors(e).Count(c => SafeIsConnected(c))),
                    networkAudit
                },
                visualVerification,
                after,
                warnings
            };
        }

        private static Element CreateLikeHost(Document doc, Element host, string kind, SelectedIds selected, MepRoutingUtil.SizeChoice size, MepRouteRerouteSegmentPlan segment)
        {
            var a = ToXyz(segment.Start);
            var b = ToXyz(segment.End);
            if (kind == "pipe")
            {
                var pipe = Pipe.Create(doc, selected.systemTypeId, selected.typeId, selected.levelId, a, b);
                MepRoutingUtil.TryApplyPipeSize(pipe, size, out _);
                return pipe;
            }
            else
            {
                var duct = Duct.Create(doc, selected.systemTypeId, selected.typeId, selected.levelId, a, b);
                MepRoutingUtil.TryApplyDuctSize(duct, size, out _);
                return duct;
            }
        }

        private sealed class SelectedIds
        {
            public ElementId systemTypeId { get; set; } = ElementId.InvalidElementId;
            public ElementId typeId { get; set; } = ElementId.InvalidElementId;
            public ElementId levelId { get; set; } = ElementId.InvalidElementId;
            public object response { get; set; } = new { };
        }

        private sealed class EndpointConnectionPlan
        {
            public string Endpoint { get; set; } = "";
            public long ExternalOwnerId { get; set; }
            public string ExternalCategory { get; set; } = "";
            public XYZ HostConnectorOrigin { get; set; } = XYZ.Zero;
            public XYZ ExternalConnectorOrigin { get; set; } = XYZ.Zero;
            public bool IsStart => string.Equals(Endpoint, "start", StringComparison.OrdinalIgnoreCase);

            public Connector? ResolveConnector(Document doc)
            {
                var owner = doc.GetElement(ElementIdCompat.Create(ExternalOwnerId));
                if (owner == null) return null;
                return MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(owner), ExternalConnectorOrigin, 0.35);
            }

            public object ToResponse() => new
            {
                endpoint = Endpoint,
                externalOwnerId = ExternalOwnerId,
                externalCategory = ExternalCategory,
                hostConnectorOrigin = ToArray(HostConnectorOrigin),
                externalConnectorOrigin = ToArray(ExternalConnectorOrigin)
            };
        }

        private static SelectedIds BuildSelected(Document doc, Element host, string kind, string? requestedSystemType)
        {
            var selected = new SelectedIds();
            selected.typeId = kind == "pipe" && host is Pipe pipe
                ? pipe.PipeType.Id
                : kind == "duct" && host is Duct duct
                    ? duct.DuctType.Id
                    : ElementId.InvalidElementId;
            selected.systemTypeId = ResolveSystemTypeId(doc, host, kind, requestedSystemType);
            selected.levelId = ResolveLevelId(doc, host);
            if (selected.typeId == ElementId.InvalidElementId || selected.systemTypeId == ElementId.InvalidElementId || selected.levelId == ElementId.InvalidElementId)
                throw new InvalidOperationException("Could not resolve host type, system type, or level for reroute replacement segments.");

            selected.response = new
            {
                type = DescribeElement(doc, selected.typeId),
                systemType = DescribeElement(doc, selected.systemTypeId),
                level = DescribeElement(doc, selected.levelId)
            };
            return selected;
        }

        private static List<EndpointConnectionPlan> CollectEndpointConnections(Document doc, Element host, List<Connector> hostConnectors, XYZ start, XYZ end)
        {
            var plans = new List<EndpointConnectionPlan>();
            var hostId = ElementIdCompat.GetValue(host.Id);
            foreach (var c in hostConnectors ?? new List<Connector>())
            {
                if (!SafeIsConnected(c)) continue;

                var endpoint = "";
                var startDist = SafeDistance(c, start);
                var endDist = SafeDistance(c, end);
                if (startDist <= 0.35 && startDist <= endDist) endpoint = "start";
                else if (endDist <= 0.35) endpoint = "end";
                else continue;

                Connector? external = null;
                try
                {
                    var refs = c.AllRefs;
                    foreach (Connector r in refs)
                    {
                        if (r == null) continue;
                        var owner = r.Owner;
                        if (owner == null) continue;
                        if (ElementIdCompat.GetValue(owner.Id) == hostId) continue;
                        external = r;
                        break;
                    }
                }
                catch { }

                if (external == null || external.Owner == null) continue;
                plans.Add(new EndpointConnectionPlan
                {
                    Endpoint = endpoint,
                    ExternalOwnerId = ElementIdCompat.GetValue(external.Owner.Id),
                    ExternalCategory = external.Owner.Category?.Name ?? "",
                    HostConnectorOrigin = c.Origin,
                    ExternalConnectorOrigin = external.Origin
                });
            }

            return plans
                .GroupBy(x => $"{x.Endpoint}|{x.ExternalOwnerId}|{Math.Round(x.ExternalConnectorOrigin.X, 6)}|{Math.Round(x.ExternalConnectorOrigin.Y, 6)}|{Math.Round(x.ExternalConnectorOrigin.Z, 6)}")
                .Select(g => g.First())
                .ToList();
        }

        private static ElementId ResolveSystemTypeId(Document doc, Element host, string kind, string? requestedSystemType)
        {
            if (!string.IsNullOrWhiteSpace(requestedSystemType))
                return MepRoutingUtil.FindSystemType(doc, requestedSystemType, kind)?.Id ?? ElementId.InvalidElementId;
            try
            {
                var id = host is Duct duct ? duct.MEPSystem?.GetTypeId() : host is Pipe pipe ? pipe.MEPSystem?.GetTypeId() : null;
                if (id != null && id != ElementId.InvalidElementId) return id;
            }
            catch { }
            return MepRoutingUtil.FindSystemType(doc, null, kind)?.Id ?? ElementId.InvalidElementId;
        }

        private static ElementId ResolveLevelId(Document doc, Element host)
        {
            try
            {
                if (host is MEPCurve curve && curve.ReferenceLevel != null) return curve.ReferenceLevel.Id;
            }
            catch { }
            if (host.Location is LocationCurve lc) return MepRoutingUtil.ResolveLevelFromZ(doc, lc.Curve.GetEndPoint(0).Z)?.Id ?? ElementId.InvalidElementId;
            return ElementId.InvalidElementId;
        }

        private static MepRoutingUtil.SizeChoice BuildExistingSizeChoice(Element host, string kind)
        {
            var size = new MepRoutingUtil.SizeChoice();
            if (kind == "pipe")
            {
                size.DiameterFt = GetBuiltinDouble(host, BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
                size.RequestedText = size.AppliedText = size.DiameterFt.HasValue ? $"{size.DiameterFt.Value.ToString("G6", CultureInfo.InvariantCulture)} ft diameter" : "existing pipe diameter";
                return size;
            }
            size.WidthFt = GetBuiltinDouble(host, BuiltInParameter.RBS_CURVE_WIDTH_PARAM);
            size.HeightFt = GetBuiltinDouble(host, BuiltInParameter.RBS_CURVE_HEIGHT_PARAM);
            size.DiameterFt = GetBuiltinDouble(host, BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
            size.RequestedText = size.AppliedText = size.WidthFt.HasValue && size.HeightFt.HasValue
                ? $"{size.WidthFt.Value.ToString("G6", CultureInfo.InvariantCulture)}x{size.HeightFt.Value.ToString("G6", CultureInfo.InvariantCulture)} ft"
                : "existing duct size";
            return size;
        }

        private static MepRoutingUtil.SizeChoice ResolveTransitionSize(string kind, Params p, bool upstream, List<string> warnings)
        {
            if (kind == "pipe")
            {
                var pipeSize = upstream ? p.upstreamPipeSize : p.downstreamPipeSize;
                var diameter = upstream ? p.upstreamDiameter : p.downstreamDiameter;
                return MepRoutingUtil.ChooseSize(kind, null, diameter, pipeSize, p.sizePolicy, warnings);
            }

            var ductSize = upstream ? p.upstreamDuctSize : p.downstreamDuctSize;
            var ductDiameter = upstream ? p.upstreamDiameter : p.downstreamDiameter;
            return MepRoutingUtil.ChooseSize(kind, ductSize, ductDiameter, null, p.sizePolicy, warnings);
        }

        private static string NormalizeOffsetMode(string? mode)
        {
            var value = (mode ?? "orthogonal").Trim().ToLowerInvariant();
            if (value == "45" || value == "dogleg" || value == "dogleg45" || value == "forty_five" || value == "forty-five")
                return "dogleg45";
            return "orthogonal";
        }

        private static bool SizesDiffer(string kind, MepRoutingUtil.SizeChoice a, MepRoutingUtil.SizeChoice b)
        {
            const double tol = 1e-6;
            if (kind == "pipe")
                return a.DiameterFt.HasValue && b.DiameterFt.HasValue && Math.Abs(a.DiameterFt.Value - b.DiameterFt.Value) > tol;
            if (a.DiameterFt.HasValue || b.DiameterFt.HasValue)
                return a.DiameterFt.HasValue && b.DiameterFt.HasValue && Math.Abs(a.DiameterFt.Value - b.DiameterFt.Value) > tol;
            return a.WidthFt.HasValue && b.WidthFt.HasValue && a.HeightFt.HasValue && b.HeightFt.HasValue &&
                (Math.Abs(a.WidthFt.Value - b.WidthFt.Value) > tol || Math.Abs(a.HeightFt.Value - b.HeightFt.Value) > tol);
        }

        private static object SizeResponse(MepRoutingUtil.SizeChoice size) => new
        {
            requested = size.RequestedText,
            applied = size.AppliedText,
            widthFt = size.WidthFt,
            heightFt = size.HeightFt,
            diameterFt = size.DiameterFt
        };

        private static Dictionary<string, object> SnapshotElement(Element e)
        {
            var connectors = MepRoutingUtil.GetConnectors(e);
            var data = new Dictionary<string, object>
            {
                ["id"] = ElementIdCompat.GetValue(e.Id),
                ["category"] = e.Category?.Name ?? "",
                ["typeId"] = ElementIdCompat.GetValue(e.GetTypeId()),
                ["systemName"] = MepSystemUtil.TryGetSystemName(e) ?? "",
                ["connectorCount"] = connectors.Count,
                ["connectedConnectorCount"] = connectors.Count(c => SafeIsConnected(c)),
                ["openConnectorCount"] = connectors.Count(c => !SafeIsConnected(c)),
                ["size"] = SizeResponse(BuildExistingSizeChoice(e, e is Pipe ? "pipe" : "duct"))
            };
            if (e.Location is LocationCurve lc)
            {
                var a = lc.Curve.GetEndPoint(0);
                var b = lc.Curve.GetEndPoint(1);
                data["startXyz"] = ToArray(a);
                data["endXyz"] = ToArray(b);
                data["lengthFt"] = a.DistanceTo(b);
            }
            return data;
        }

        private static object DescribeElement(Document doc, ElementId id)
        {
            var e = id == ElementId.InvalidElementId ? null : doc.GetElement(id);
            return new { id = id == ElementId.InvalidElementId ? (long?)null : ElementIdCompat.GetValue(id), name = e?.Name };
        }

        private static bool SafeIsConnected(Connector c)
        {
            try { return c.IsConnected; } catch { return false; }
        }

        private static double SafeDistance(Connector c, XYZ point)
        {
            try { return c.Origin.DistanceTo(point); } catch { return double.MaxValue; }
        }

        private static double? GetBuiltinDouble(Element e, BuiltInParameter bip)
        {
            try
            {
                var p = e.get_Parameter(bip);
                if (p == null || !p.HasValue || p.StorageType != StorageType.Double) return null;
                return p.AsDouble();
            }
            catch { return null; }
        }

        private static BranchPoint3d ToPoint(XYZ p) => new BranchPoint3d(p.X, p.Y, p.Z);
        private static XYZ ToXyz(BranchPoint3d p) => new XYZ(p.X, p.Y, p.Z);
        private static double[] ToArray(XYZ p) => new[] { p.X, p.Y, p.Z };
        private static object ToResponsePoint(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };
        private static bool HasText(string? value) => !string.IsNullOrWhiteSpace(value);
    }
}
