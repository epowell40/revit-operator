using System;
using System.Collections.Generic;
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
            public string? systemType { get; set; }
            public string? ductType { get; set; }
            public string? pipeType { get; set; }
            public string? ductSize { get; set; }
            public string? diameter { get; set; }
            public string? pipeSize { get; set; }
            public string? sizePolicy { get; set; } = "use_default_with_warning";
            public string? elevationPolicy { get; set; } = "resolve_context_default";
            public string? routingMode { get; set; } = "polyline";
            public bool connectSegments { get; set; } = true;
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

            var doc = app.ActiveUIDocument.Document;
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

            var size = MepRoutingUtil.ChooseSize(kind, p.ductSize, p.diameter, p.pipeSize, p.sizePolicy, warnings);
            if (size.Missing && string.Equals((p.sizePolicy ?? "").Trim(), "explicit_required", StringComparison.OrdinalIgnoreCase))
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    error = "Size is required by sizePolicy=explicit_required.",
                    plannedRoute = BuildPlanOnly(p.points, p.frameId, ctx.RecommendedZ, warnings),
                    selected = BuildSelected(ctx, null, null, null),
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

            MEPSystemType? sysType = MepRoutingUtil.FindSystemType(doc, p.systemType);
            DuctType? dType = kind == "duct" ? MepRoutingUtil.FindDuctType(doc, p.ductType) : null;
            PipeType? pType = kind == "pipe" ? MepRoutingUtil.FindPipeType(doc, p.pipeType) : null;
            if (sysType == null || (kind == "duct" && dType == null) || (kind == "pipe" && pType == null))
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    error = "Could not find required Revit MEP definitions for level/system/type.",
                    selected = BuildSelected(ctx, sysType, dType, pType),
                    warnings
                });
            }

            var created = new List<Element>();
            var createdIds = new List<long>();
            var segmentResults = new List<object>();
            var connectionAttempts = new List<object>();
            var fittingIds = new List<long>();

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
                        if (kind == "pipe")
                        {
                            var pipe = Pipe.Create(doc, sysType.Id, pType!.Id, ctx.Level.Id, a, b);
                            MepRoutingUtil.TryApplyPipeSize(pipe, size, out sizeApplied);
                            curve = pipe;
                        }
                        else
                        {
                            var duct = Duct.Create(doc, sysType.Id, dType!.Id, ctx.Level.Id, a, b);
                            MepRoutingUtil.TryApplyDuctSize(duct, size, out sizeApplied);
                            curve = duct;
                        }

                        created.Add(curve);
                        createdIds.Add(ElementIdCompat.GetValue(curve.Id));
                        segmentResults.Add(new
                        {
                            index = i,
                            id = ElementIdCompat.GetValue(curve.Id),
                            start = ToPointObject(a),
                            end = ToPointObject(b),
                            lengthFt = a.DistanceTo(b),
                            sizeApplied
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
                            var ok = MepRoutingUtil.TryCreateElbowOrConnect(doc, a, b, out var fittingId, out var method, out var err);
                            if (fittingId.HasValue) fittingIds.Add(fittingId.Value);
                            connectionAttempts.Add(new
                            {
                                fromSegment = i,
                                toSegment = i + 1,
                                sharedPoint = ToPointObject(shared),
                                connected = ok,
                                method,
                                fittingId,
                                error = err
                            });
                        }
                        doc.Regenerate();
                    }

                    var openConnectorCount = p.verify ? MepRoutingUtil.CountOpenConnectors(created) : (int?)null;
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
                        selected = BuildSelected(ctx, sysType, dType, pType),
                        chosenSize = new
                        {
                            requested = size.RequestedText.Length == 0 ? null : size.RequestedText,
                            applied = size.AppliedText,
                            usedDefault = size.UsedDefault,
                            widthFt = size.WidthFt,
                            heightFt = size.HeightFt,
                            diameterFt = size.DiameterFt
                        },
                        chosenElevation = new { zFt = ctx.RecommendedZ, mode = ctx.RecommendedMode, confidence = ctx.Confidence, assumption = ctx.Assumption, usedFallback = usedElevationFallback },
                        createdElementIds = p.dryRun ? new List<long>() : createdIds,
                        createdFittingIds = p.dryRun ? new List<long>() : fittingIds,
                        dryRunElementIds = p.dryRun ? createdIds : new List<long>(),
                        dryRunFittingIds = p.dryRun ? fittingIds : new List<long>(),
                        segments = segmentResults,
                        connectionAttempts,
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

        private static object BuildPlan(List<XYZ> points)
        {
            return new
            {
                points = points.Select(ToPointObject).ToList(),
                segmentCount = Math.Max(0, points.Count - 1),
                totalLengthFt = points.Count < 2 ? 0.0 : Enumerable.Range(0, points.Count - 1).Sum(i => points[i].DistanceTo(points[i + 1]))
            };
        }

        private static object BuildSelected(MepRoutingUtil.RoutingContext ctx, MEPSystemType? sysType, DuctType? dType, PipeType? pType)
        {
            return new
            {
                level = ctx.Level == null ? null : new { id = ElementIdCompat.GetValue(ctx.Level.Id), name = ctx.Level.Name, elevation = ctx.Level.Elevation },
                systemType = sysType == null ? null : new { id = ElementIdCompat.GetValue(sysType.Id), name = sysType.Name },
                ductType = dType == null ? null : new { id = ElementIdCompat.GetValue(dType.Id), name = dType.Name },
                pipeType = pType == null ? null : new { id = ElementIdCompat.GetValue(pType.Id), name = pType.Name }
            };
        }

        private static object ToPointObject(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };
    }
}
