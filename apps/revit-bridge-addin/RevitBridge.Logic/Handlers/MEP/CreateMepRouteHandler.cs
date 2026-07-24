using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class CreateMepRouteHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string kind { get; set; } = "duct";
            public string? frameId { get; set; }
            public List<MepRoutingUtil.RoutePoint> points { get; set; } = new List<MepRoutingUtil.RoutePoint>();
            public long? viewId { get; set; }
            public string? roomNumber { get; set; }
            public string? levelName { get; set; }
            public long? levelId { get; set; }
            public string? worksetName { get; set; }
            public long? worksetId { get; set; }
            public string? systemType { get; set; }
            public string? ductType { get; set; }
            public long? ductTypeId { get; set; }
            public string? ductShape { get; set; }
            public string? pipeType { get; set; }
            public long? pipeTypeId { get; set; }
            public string? conduitType { get; set; }
            public long? conduitTypeId { get; set; }
            public string? ductSize { get; set; }
            public string? diameter { get; set; }
            public string? pipeSize { get; set; }
            public List<string>? segmentSizes { get; set; }
            public string? sizePolicy { get; set; } = "use_default_with_warning";
            public string? elevationPolicy { get; set; } = "resolve_context_default";
            public string? routingMode { get; set; } = "polyline";
            public bool connectSegments { get; set; } = true;
            public bool connectToExisting { get; set; } = false;
            public bool requireExistingEndpointConnections { get; set; } = false;
            public double externalConnectionToleranceFt { get; set; } = 0.1;
            public bool verify { get; set; } = true;
            public bool dryRun { get; set; } = true;
            public double? defaultOffsetFt { get; set; }
            public double? ceilingOffsetFt { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();

            var warnings = new List<string>();
            var kind = MepRoutingUtil.NormalizeKind(p.kind);
            if (p.points == null || p.points.Count < 2)
            {
                return Task.FromResult<object>(new { status = "Blocked", error = "At least two route points are required.", warnings });
            }
            if (p.requireExistingEndpointConnections && !p.connectToExisting)
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    error = "requireExistingEndpointConnections=true requires connectToExisting=true.",
                    warnings
                });
            }

            var doc = app.ActiveUIDocument.Document;
            var requestedWorkset = ResolveRequestedWorkset(doc, p.worksetId, p.worksetName, out var worksetError);
            if (!string.IsNullOrWhiteSpace(worksetError))
            {
                return Task.FromResult<object>(new { status = "Blocked", error = worksetError, warnings });
            }
            var ctxReq = new MepRoutingUtil.RoutingContextRequest
            {
                viewId = p.viewId,
                roomNumber = p.roomNumber,
                levelName = p.levelName,
                levelId = p.levelId,
                systemKind = kind,
                routingMode = p.routingMode,
                defaultOffsetFt = p.defaultOffsetFt,
                ceilingOffsetFt = p.ceilingOffsetFt,
                dryRun = true
            };
            var ctx = MepRoutingUtil.ResolveRoutingContext(doc, app, ctxReq);
            warnings.AddRange(ctx.Warnings);
            if (ctx.Level == null)
            {
                return Task.FromResult<object>(new { status = "Blocked", error = "Could not resolve a level for this route.", warnings });
            }

            var routeSegmentCount = Math.Max(0, p.points.Count - 1);
            var segmentSizeTexts = ResolveSegmentSizeTexts(kind, p, routeSegmentCount);
            var size = MepRoutingUtil.ChooseSize(kind, p.ductSize, p.diameter, p.pipeSize, p.sizePolicy, warnings);
            if (size.Missing && string.Equals((p.sizePolicy ?? "").Trim(), "explicit_required", StringComparison.OrdinalIgnoreCase))
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    error = "Size is required by sizePolicy=explicit_required.",
                    plannedRoute = BuildPlanOnly(p.points, p.frameId, ctx.RecommendedZ, warnings),
                    selected = BuildSelected(ctx, null, null, null, null),
                    warnings
                });
            }

            var usedElevationFallback = false;
            var resolvedPoints = new List<XYZ>();
            foreach (var rp in p.points)
            {
                var xyz = MepRoutingUtil.ResolveRoutePoint(rp, p.frameId, ctx.RecommendedZ, out var usedFallback);
                if (usedFallback) usedElevationFallback = true;
                resolvedPoints.Add(xyz);
            }

            if (usedElevationFallback && string.Equals((p.elevationPolicy ?? "").Trim(), "explicit_required", StringComparison.OrdinalIgnoreCase))
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    error = "At least one route point is missing an explicit usable Z and elevationPolicy=explicit_required.",
                    plannedRoute = BuildPlan(resolvedPoints),
                    recommendedElevation = ctx.ToResponse("Ok"),
                    warnings
                });
            }

            if (usedElevationFallback)
            {
                warnings.Add($"One or more route points used resolved routing elevation Z={ctx.RecommendedZ:G6} ft ({ctx.Assumption}).");
            }
            else
            {
                warnings.RemoveAll(IsUnusedElevationContextWarning);
            }

            var totalLength = 0.0;
            for (var i = 0; i < resolvedPoints.Count - 1; i++)
            {
                var len = resolvedPoints[i].DistanceTo(resolvedPoints[i + 1]);
                if (len <= 1e-6)
                {
                    return Task.FromResult<object>(new { status = "Blocked", error = $"Route segment {i + 1} has zero length.", warnings });
                }
                totalLength += len;
            }

            MEPSystemType? sysType = kind == "conduit" ? null : MepRoutingUtil.FindSystemType(doc, p.systemType, kind);
            MepRoutingUtil.DuctTypeResolution? ductTypeResolution = kind == "duct"
                ? MepRoutingUtil.ResolveDuctType(doc, p.ductTypeId, p.ductType)
                : null;
            DuctType? dType = ductTypeResolution?.Selected;
            MepRoutingUtil.PipeTypeResolution? pipeTypeResolution = kind == "pipe"
                ? MepRoutingUtil.ResolvePipeType(doc, p.pipeTypeId, p.pipeType)
                : null;
            PipeType? pType = pipeTypeResolution?.Selected;
            MepRoutingUtil.ConduitTypeResolution? conduitTypeResolution = kind == "conduit"
                ? MepRoutingUtil.ResolveConduitType(doc, p.conduitTypeId, p.conduitType)
                : null;
            ConduitType? conduitType = conduitTypeResolution?.Selected;
            if ((kind != "conduit" && sysType == null) ||
                (kind == "duct" && dType == null) ||
                (kind == "pipe" && pType == null) ||
                (kind == "conduit" && conduitType == null))
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    error = kind == "duct" && dType == null && !string.IsNullOrWhiteSpace(ductTypeResolution?.Receipt.Error)
                        ? ductTypeResolution!.Receipt.Error
                        : kind == "conduit" && conduitType == null && !string.IsNullOrWhiteSpace(conduitTypeResolution?.Error)
                            ? conduitTypeResolution!.Error
                            : kind == "pipe" && pType == null && !string.IsNullOrWhiteSpace(pipeTypeResolution?.Error)
                                ? pipeTypeResolution!.Error
                            : "Could not find required Revit MEP definitions for level/system/type.",
                    selected = BuildSelected(ctx, sysType, dType, pType, conduitType),
                    ductTypeCandidates = ductTypeResolution?.Receipt.Candidates,
                    pipeTypeCandidates = pipeTypeResolution?.Candidates,
                    conduitTypeCandidates = conduitTypeResolution?.Candidates,
                    warnings
                });
            }

            var created = new List<Element>();
            var createdIds = new List<long>();
            var segmentResults = new List<object>();
            var connectionAttempts = new List<object>();
            var fittingIds = new List<long>();
            var internalConnectionFailures = 0;
            var jointPlans = MepRouteJointPlanner.PlanJoints(segmentSizeTexts);

            using (var tx = new Transaction(doc, p.dryRun ? "Create MEP Route (Dry Run)" : "Create MEP Route"))
            {
                tx.Start();
                try
                {
                    for (var i = 0; i < resolvedPoints.Count - 1; i++)
                    {
                        var a = resolvedPoints[i];
                        var b = resolvedPoints[i + 1];
                        Element curve;
                        object sizeApplied;
                        object? worksetApplied = null;
                        object? nativeSizeReadback = null;
                        object? nativeGeometryReadback = null;
                        var segmentSize = MepRoutingUtil.ChooseSize(
                            kind,
                            kind == "duct" ? segmentSizeTexts[i] : p.ductSize,
                            kind == "pipe" || kind == "conduit" ? segmentSizeTexts[i] : p.diameter,
                            kind == "pipe" ? segmentSizeTexts[i] : p.pipeSize,
                            p.sizePolicy,
                            warnings);
                        if (kind == "pipe")
                        {
                            var pipe = Pipe.Create(doc, sysType.Id, pType!.Id, ctx.Level.Id, a, b);
                            MepRoutingUtil.TryApplyPipeSize(pipe, segmentSize, out sizeApplied);
                            curve = pipe;
                        }
                        else if (kind == "conduit")
                        {
                            var conduit = Conduit.Create(doc, conduitType!.Id, a, b, ctx.Level.Id);
                            MepRoutingUtil.TryApplyConduitSize(conduit, segmentSize, out sizeApplied);
                            doc.Regenerate();
                            var readbackValid = MepRoutingUtil.ValidateConduitSize(conduit, segmentSize, out var diameterFt, out var readbackError);
                            if (p.verify && !readbackValid) throw new InvalidOperationException(readbackError);
                            nativeSizeReadback = new { shape = "round", diameterFt };
                            curve = conduit;
                        }
                        else
                        {
                            var duct = Duct.Create(doc, sysType.Id, dType!.Id, ctx.Level.Id, a, b);
                            MepRoutingUtil.TryApplyDuctSize(duct, segmentSize, out sizeApplied);
                            doc.Regenerate();
                            var readbackValid = MepRoutingUtil.ValidateDuctSizeAndShape(duct, segmentSize, p.ductShape, out var readback, out var readbackError);
                            if (p.verify && !readbackValid)
                            {
                                throw new InvalidOperationException(readbackError);
                            }
                            else
                            {
                                nativeSizeReadback = new
                                {
                                    shape = readback.Shape,
                                    widthFt = readback.WidthFt,
                                    heightFt = readback.HeightFt,
                                    diameterFt = readback.DiameterFt
                                };
                            }
                            curve = duct;
                        }

                        if (requestedWorkset != null)
                        {
                            worksetApplied = ApplyAndVerifyWorkset(curve, requestedWorkset, p.verify);
                        }

                        doc.Regenerate();
                        nativeGeometryReadback = BuildNativeGeometryReadback(curve);

                        created.Add(curve);
                        createdIds.Add(ElementIdCompat.GetValue(curve.Id));
                        segmentResults.Add(new
                        {
                            index = i,
                            id = ElementIdCompat.GetValue(curve.Id),
                            start = ToPointObject(a),
                            end = ToPointObject(b),
                            lengthFt = a.DistanceTo(b),
                            requestedSize = segmentSizeTexts[i],
                            chosenSize = new
                            {
                                requested = segmentSize.RequestedText.Length == 0 ? null : segmentSize.RequestedText,
                                applied = segmentSize.AppliedText,
                                usedDefault = segmentSize.UsedDefault,
                                widthFt = segmentSize.WidthFt,
                                heightFt = segmentSize.HeightFt,
                                diameterFt = segmentSize.DiameterFt
                            },
                            sizeApplied,
                            worksetApplied,
                            nativeSizeReadback,
                            nativeGeometryReadback
                        });
                    }

                    doc.Regenerate();

                    if (p.connectSegments && created.Count > 1)
                    {
                        for (var i = 0; i < created.Count - 1; i++)
                        {
                            var shared = resolvedPoints[i + 1];
                            var a = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(created[i]), shared, 0.25);
                            var b = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(created[i + 1]), shared, 0.25);
                            var jointPlan = jointPlans.FirstOrDefault(j => j.JointIndex == i);
                            var expectTransition = string.Equals(jointPlan?.ExpectedFitting, "transition", StringComparison.OrdinalIgnoreCase);
                            var ok = MepRoutingUtil.TryCreateTransitionElbowOrConnect(doc, a, b, expectTransition, out var fittingId, out var method, out var err);
                            if (!ok) internalConnectionFailures++;
                            if (fittingId.HasValue) fittingIds.Add(fittingId.Value);
                            connectionAttempts.Add(new
                            {
                                fromSegment = i,
                                toSegment = i + 1,
                                sharedPoint = ToPointObject(shared),
                                expectedFitting = jointPlan?.ExpectedFitting ?? "elbow_or_connect",
                                connected = ok,
                                method,
                                fittingId,
                                error = err
                            });
                        }
                        doc.Regenerate();

                        if (kind == "conduit" && p.verify && internalConnectionFailures > 0)
                        {
                            throw new InvalidOperationException($"Conduit route verification failed because {internalConnectionFailures} internal segment connection(s) could not be created.");
                        }
                    }

                    if (p.connectToExisting)
                    {
                        var excludedOwnerIds = new HashSet<long>(createdIds);
                        var toleranceFt = Math.Max(1e-4, Math.Min(1.0, p.externalConnectionToleranceFt));
                        var externalEndpointFailures = 0;
                        TryConnectExternalEndpoint(
                            doc,
                            created[0],
                            resolvedPoints[0],
                            "start",
                            excludedOwnerIds,
                            toleranceFt,
                            connectionAttempts,
                            ref externalEndpointFailures);
                        TryConnectExternalEndpoint(
                            doc,
                            created[created.Count - 1],
                            resolvedPoints[resolvedPoints.Count - 1],
                            "end",
                            excludedOwnerIds,
                            toleranceFt,
                            connectionAttempts,
                            ref externalEndpointFailures);
                        doc.Regenerate();

                        if (externalEndpointFailures > 0)
                        {
                            var message = $"Could not physically connect {externalEndpointFailures} route endpoint(s) to compatible existing connectors within {toleranceFt:G6} ft.";
                            if (p.requireExistingEndpointConnections) throw new InvalidOperationException(message);
                            warnings.Add(message);
                        }
                    }

                    var createdFittingWorksets = new List<object>();
                    if (requestedWorkset != null)
                    {
                        foreach (var fittingId in fittingIds.Distinct())
                        {
                            var fitting = doc.GetElement(ElementIdCompat.Create(fittingId));
                            if (fitting == null) throw new InvalidOperationException($"Created route fitting {fittingId} was not found for workset assignment.");
                            createdFittingWorksets.Add(ApplyAndVerifyWorkset(fitting, requestedWorkset, p.verify));
                        }
                        doc.Regenerate();
                    }

                    var openConnectorCount = p.verify ? MepRoutingUtil.CountOpenConnectors(created) : (int?)null;
                    var postConnectionGeometryReadback = created.Select((element, index) => new
                    {
                        segmentIndex = index,
                        elementId = ElementIdCompat.GetValue(element.Id),
                        geometry = BuildNativeGeometryReadback(element)
                    }).ToList();
                    var status = p.dryRun
                        ? "Dry Run"
                        : (openConnectorCount.GetValueOrDefault(0) == 0 ? "CreatedAndConnected" : "CreatedWithOpenConnectors");

                    if (openConnectorCount.GetValueOrDefault(0) > 0)
                    {
                        warnings.Add($"Connector verification found {openConnectorCount} open connector(s) on created route elements.");
                    }

                    var result = new
                    {
                        status,
                        dryRun = p.dryRun,
                        kind,
                        plannedPoints = resolvedPoints.Select(ToPointObject).ToList(),
                        segmentCount = resolvedPoints.Count - 1,
                        totalLengthFt = totalLength,
                        selected = BuildSelected(ctx, sysType, dType, pType, conduitType),
                        selectedWorkset = requestedWorkset == null ? null : new
                        {
                            id = requestedWorkset.Id.IntegerValue,
                            name = requestedWorkset.Name
                        },
                        chosenSize = new
                        {
                            requested = size.RequestedText.Length == 0 ? null : size.RequestedText,
                            applied = size.AppliedText,
                            usedDefault = size.UsedDefault,
                            widthFt = size.WidthFt,
                            heightFt = size.HeightFt,
                            diameterFt = size.DiameterFt
                        },
                        segmentSizes = segmentSizeTexts,
                        jointPlan = jointPlans.Select(j => new
                        {
                            jointIndex = j.JointIndex,
                            expectedFitting = j.ExpectedFitting,
                            reason = j.Reason,
                            fromSize = j.FromSize,
                            toSize = j.ToSize
                        }).ToList(),
                        chosenElevation = BuildChosenElevation(ctx, resolvedPoints, usedElevationFallback),
                        createdElementIds = p.dryRun ? new List<long>() : createdIds,
                        createdFittingIds = p.dryRun ? new List<long>() : fittingIds,
                        dryRunElementIds = p.dryRun ? createdIds : new List<long>(),
                        dryRunFittingIds = p.dryRun ? fittingIds : new List<long>(),
                        segments = segmentResults,
                        createdFittingWorksets,
                        postConnectionGeometryReadback,
                        connectionAttempts,
                        internalConnectionsVerified = !p.connectSegments || internalConnectionFailures == 0,
                        openConnectorCount,
                        warnings,
                        rolledBack = p.dryRun
                    };

                    if (p.dryRun) tx.RollBack();
                    else tx.Commit();
                    return Task.FromResult<object>(result);
                }
                catch (Exception ex)
                {
                    try { tx.RollBack(); } catch { }
                    return Task.FromResult<object>(new
                    {
                        status = "Blocked",
                        error = ex.Message,
                        dryRun = p.dryRun,
                        createdElementIds = new List<long>(),
                        plannedPoints = resolvedPoints.Select(ToPointObject).ToList(),
                        warnings,
                        rolledBack = true
                    });
                }
            }
        }

        private static object BuildPlanOnly(List<MepRoutingUtil.RoutePoint> points, string? frameId, double z, List<string> warnings)
        {
            try
            {
                var resolved = points.Select(p => MepRoutingUtil.ResolveRoutePoint(p, frameId, z, out _)).ToList();
                return BuildPlan(resolved);
            }
            catch (Exception ex)
            {
                warnings.Add($"Could not fully resolve route points during blocked dry-run: {ex.Message}");
                return new { pointCount = points.Count };
            }
        }

        private static void TryConnectExternalEndpoint(
            Document doc,
            Element routeElement,
            XYZ endpoint,
            string endpointName,
            ISet<long> excludedOwnerIds,
            double toleranceFt,
            List<object> connectionAttempts,
            ref int failureCount)
        {
            var routeConnector = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(routeElement), endpoint, toleranceFt);
            if (routeConnector == null)
            {
                failureCount++;
                connectionAttempts.Add(new
                {
                    connectionKind = "existing_endpoint",
                    endpoint = endpointName,
                    routeElementId = ElementIdCompat.GetValue(routeElement.Id),
                    connected = false,
                    method = "route_connector_not_found",
                    error = "Created route connector was not found near the requested endpoint."
                });
                return;
            }

            var external = MepRoutingUtil.FindClosestCompatibleOpenConnector(doc, routeConnector, excludedOwnerIds, toleranceFt, out var distanceFt);
            if (external == null || external.Owner == null)
            {
                failureCount++;
                connectionAttempts.Add(new
                {
                    connectionKind = "existing_endpoint",
                    endpoint = endpointName,
                    routeElementId = ElementIdCompat.GetValue(routeElement.Id),
                    connected = false,
                    method = "compatible_existing_connector_not_found",
                    toleranceFt,
                    error = "No physically open compatible existing connector was found near the route endpoint."
                });
                return;
            }

            var connected = MepRoutingUtil.TryConnect(routeConnector, external, out var error);
            if (!connected) failureCount++;
            connectionAttempts.Add(new
            {
                connectionKind = "existing_endpoint",
                endpoint = endpointName,
                routeElementId = ElementIdCompat.GetValue(routeElement.Id),
                externalOwnerId = ElementIdCompat.GetValue(external.Owner.Id),
                externalCategory = external.Owner.Category?.Name ?? "",
                distanceFt,
                connected,
                method = connected ? "connector_connect_to" : "failed",
                error
            });
        }

        private static object BuildPlan(List<XYZ> points)
        {
            return new
            {
                points = points.Select(ToPointObject).ToList(),
                segmentCount = Math.Max(0, points.Count - 1),
                totalLengthFt = points.Count < 2 ? 0.0 : Enumerable.Range(0, points.Count - 1).Sum(i => points[i].DistanceTo(points[i + 1]))
            };
        }

        private static object BuildSelected(MepRoutingUtil.RoutingContext ctx, MEPSystemType? sysType, DuctType? dType, PipeType? pType, ConduitType? conduitType)
        {
            return new
            {
                level = ctx.Level == null ? null : new { id = ElementIdCompat.GetValue(ctx.Level.Id), name = ctx.Level.Name, elevation = ctx.Level.Elevation },
                systemType = sysType == null ? null : new { id = ElementIdCompat.GetValue(sysType.Id), name = sysType.Name },
                ductType = dType == null ? null : new { id = ElementIdCompat.GetValue(dType.Id), name = dType.Name, familyName = dType.FamilyName },
                pipeType = pType == null ? null : new { id = ElementIdCompat.GetValue(pType.Id), name = pType.Name },
                conduitType = conduitType == null ? null : new { id = ElementIdCompat.GetValue(conduitType.Id), name = conduitType.Name }
            };
        }

        private static List<string?> ResolveSegmentSizeTexts(string kind, Params p, int segmentCount)
        {
            var fallback = kind == "pipe"
                ? FirstNonEmpty(p.pipeSize, p.diameter)
                : kind == "conduit"
                    ? FirstNonEmpty(p.diameter)
                    : (p.ductSize ?? "").Trim();
            var values = new List<string?>();
            for (var i = 0; i < segmentCount; i++)
            {
                var perSegment = p.segmentSizes != null && i < p.segmentSizes.Count ? p.segmentSizes[i] : null;
                values.Add(string.IsNullOrWhiteSpace(perSegment) ? fallback : perSegment);
            }
            return values;
        }

        private static string FirstNonEmpty(params string?[] values)
        {
            foreach (var value in values)
            {
                var trimmed = (value ?? "").Trim();
                if (trimmed.Length > 0) return trimmed;
            }
            return "";
        }

        private static object ToPointObject(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };

        private static Workset? ResolveRequestedWorkset(Document doc, long? worksetId, string? worksetName, out string? error)
        {
            error = null;
            var requestedName = (worksetName ?? "").Trim();
            var hasId = worksetId.HasValue && worksetId.Value > 0;
            var hasName = requestedName.Length > 0;
            if (!hasId && !hasName) return null;
            if (!doc.IsWorkshared)
            {
                error = "An explicit MEP route workset was requested, but the active document is not workshared.";
                return null;
            }

            var worksets = new FilteredWorksetCollector(doc)
                .OfKind(WorksetKind.UserWorkset)
                .ToWorksets()
                .ToList();
            var byId = hasId ? worksets.FirstOrDefault(x => x.Id.IntegerValue == worksetId!.Value) : null;
            var byName = hasName ? worksets.FirstOrDefault(x => string.Equals(x.Name, requestedName, StringComparison.OrdinalIgnoreCase)) : null;
            if (hasId && byId == null)
            {
                error = $"MEP route workset id {worksetId} was not found as a user workset.";
                return null;
            }
            if (hasName && byName == null)
            {
                error = $"MEP route workset '{requestedName}' was not found as a user workset.";
                return null;
            }
            if (byId != null && byName != null && byId.Id.IntegerValue != byName.Id.IntegerValue)
            {
                error = $"MEP route workset id {worksetId} does not match workset name '{requestedName}'.";
                return null;
            }
            return byId ?? byName;
        }

        private static bool IsUnusedElevationContextWarning(string warning)
        {
            var value = warning ?? "";
            return value.IndexOf("recommended elevation", StringComparison.OrdinalIgnoreCase) >= 0
                || value.IndexOf("using explicit level offset routing mode", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static object BuildChosenElevation(MepRoutingUtil.RoutingContext ctx, List<XYZ> resolvedPoints, bool usedFallback)
        {
            if (usedFallback)
            {
                return new
                {
                    zFt = (double?)ctx.RecommendedZ,
                    mode = ctx.RecommendedMode,
                    confidence = ctx.Confidence,
                    assumption = ctx.Assumption,
                    usedFallback = true
                };
            }

            var minimumZ = resolvedPoints.Min(point => point.Z);
            var maximumZ = resolvedPoints.Max(point => point.Z);
            var uniform = maximumZ - minimumZ <= 1e-6;
            return new
            {
                zFt = uniform ? (double?)minimumZ : null,
                mode = uniform ? "explicit_points" : "explicit_profile",
                confidence = "high",
                assumption = uniform
                    ? "All route points supplied the same explicit Z."
                    : "All route points supplied explicit Z values defining the route profile.",
                usedFallback = false
            };
        }

        private static object ApplyAndVerifyWorkset(Element element, Workset workset, bool verify)
        {
            var parameter = element.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM);
            if (parameter == null || parameter.IsReadOnly)
            {
                throw new InvalidOperationException($"Element {ElementIdCompat.GetValue(element.Id)} cannot be assigned to workset '{workset.Name}'.");
            }
            if (!parameter.Set(workset.Id.IntegerValue))
            {
                throw new InvalidOperationException($"Element {ElementIdCompat.GetValue(element.Id)} rejected workset '{workset.Name}'.");
            }
            var readbackId = parameter.AsInteger();
            var verified = readbackId == workset.Id.IntegerValue;
            if (verify && !verified)
            {
                throw new InvalidOperationException($"Element {ElementIdCompat.GetValue(element.Id)} workset readback {readbackId} did not match requested workset {workset.Id.IntegerValue}.");
            }
            return new
            {
                elementId = ElementIdCompat.GetValue(element.Id),
                requestedWorksetId = workset.Id.IntegerValue,
                requestedWorksetName = workset.Name,
                readbackWorksetId = readbackId,
                verified
            };
        }

        private static object? BuildNativeGeometryReadback(Element element)
        {
            var locationCurve = element.Location as LocationCurve;
            var curve = locationCurve?.Curve;
            if (curve == null) return null;
            var start = curve.GetEndPoint(0);
            var end = curve.GetEndPoint(1);
            return new
            {
                start = ToPointObject(start),
                end = ToPointObject(end),
                lengthFt = curve.Length
            };
        }
    }
}
