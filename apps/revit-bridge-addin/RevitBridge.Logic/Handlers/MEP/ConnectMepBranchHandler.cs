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
    public class ConnectMepBranchHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string kind { get; set; } = "duct";
            public long mainElementId { get; set; }
            public List<MepRoutingUtil.RoutePoint> branchPoints { get; set; } = new List<MepRoutingUtil.RoutePoint>();
            public string? branchSize { get; set; }
            public string? connectionMode { get; set; } = "auto";
            public string? frameId { get; set; }
            public long? viewId { get; set; }
            public string? roomNumber { get; set; }
            public string? levelName { get; set; }
            public long? levelId { get; set; }
            public bool dryRun { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();

            var warnings = new List<string>();
            if (p.mainElementId <= 0)
            {
                return Task.FromResult<object>(new { status = "Blocked", error = "mainElementId is required.", warnings });
            }
            if (p.branchPoints == null || p.branchPoints.Count < 2)
            {
                return Task.FromResult<object>(new { status = "Blocked", error = "At least two branchPoints are required.", warnings });
            }

            var doc = app.ActiveUIDocument.Document;
            var main = doc.GetElement(ElementIdCompat.Create(p.mainElementId));
            if (main == null)
            {
                return Task.FromResult<object>(new { status = "Blocked", error = $"Element {p.mainElementId} was not found.", warnings });
            }

            var kind = MepRoutingUtil.NormalizeKind(p.kind);
            var mainCategory = main.Category?.Name ?? "";
            var isMainKind =
                (kind == "duct" && main.Category != null && ElementIdCompat.GetValue(main.Category.Id) == (int)BuiltInCategory.OST_DuctCurves) ||
                (kind == "pipe" && main.Category != null && ElementIdCompat.GetValue(main.Category.Id) == (int)BuiltInCategory.OST_PipeCurves);
            if (!isMainKind)
            {
                warnings.Add($"mainElementId category is '{mainCategory}', not the expected {kind} curve category.");
            }

            var ctx = MepRoutingUtil.ResolveRoutingContext(doc, app, new MepRoutingUtil.RoutingContextRequest
            {
                viewId = p.viewId,
                roomNumber = p.roomNumber,
                levelName = p.levelName,
                levelId = p.levelId,
                systemKind = kind,
                dryRun = true
            });
            warnings.AddRange(ctx.Warnings);

            var branch = p.branchPoints.Select(x => MepRoutingUtil.ResolveRoutePoint(x, p.frameId, ctx.RecommendedZ, out _)).ToList();
            var branchStart = branch[0];

            var location = main.Location as LocationCurve;
            XYZ? nearestPoint = null;
            double? distanceToMain = null;
            double? normalizedParameter = null;
            if (location?.Curve != null)
            {
                try
                {
                    var projection = location.Curve.Project(branchStart);
                    if (projection != null)
                    {
                        nearestPoint = projection.XYZPoint;
                        distanceToMain = branchStart.DistanceTo(nearestPoint);
                        normalizedParameter = projection.Parameter;
                    }
                }
                catch (Exception ex)
                {
                    warnings.Add($"Could not project branch start to main curve: {ex.Message}");
                }
            }
            else
            {
                warnings.Add("Main element does not expose a LocationCurve; split/tee planning is not available for this element.");
            }

            var connectors = MepRoutingUtil.GetConnectors(main);
            var nearestConnector = MepRoutingUtil.FindClosestConnector(connectors, branchStart, 0.5);
            var nearestConnectorDistance = nearestConnector == null ? (double?)null : nearestConnector.Origin.DistanceTo(branchStart);
            var nearestConnectorOpen = false;
            if (nearestConnector != null)
            {
                try { nearestConnectorOpen = !nearestConnector.IsConnected; } catch { nearestConnectorOpen = false; }
            }

            var feasibleExistingConnector = nearestConnector != null && nearestConnectorOpen && nearestConnectorDistance.GetValueOrDefault(999) <= 0.25;
            var status = p.dryRun ? "Dry Run" : (feasibleExistingConnector ? "CreatedWithOpenConnectors" : "Blocked");
            var nextStep = feasibleExistingConnector
                ? "Safe apply path is available because the branch starts at an existing open main connector."
                : "Implement safe main splitting plus tee/tap fitting placement before apply mode for this branch.";

            if (!p.dryRun && !feasibleExistingConnector)
            {
                warnings.Add("Apply mode is guarded for this case: v1 does not split mains or place tee/tap fittings away from existing open connectors.");
            }

            var createdBranchIds = new List<long>();
            var createdFittingIds = new List<long>();
            var connectionAttempts = new List<object>();
            var openConnectorCount = (int?)null;
            var rolledBack = false;

            if (!p.dryRun && feasibleExistingConnector && nearestConnector != null)
            {
                using (var tx = new Transaction(doc, "Connect MEP Branch"))
                {
                    tx.Start();
                    try
                    {
                        var snapped = new List<XYZ>(branch);
                        snapped[0] = nearestConnector.Origin;

                        var sizeWarnings = new List<string>();
                        var size = MepRoutingUtil.ChooseSize(kind, p.branchSize, p.branchSize, p.branchSize, "use_default_with_warning", sizeWarnings);
                        warnings.AddRange(sizeWarnings);

                        var branchElements = new List<Element>();
                        for (var i = 0; i < snapped.Count - 1; i++)
                        {
                            var a = snapped[i];
                            var b = snapped[i + 1];
                            if (a.DistanceTo(b) <= 1e-6) throw new InvalidOperationException($"Branch segment {i + 1} has zero length after snapping to connector.");

                            Element curve;
                            object sizeApplied;
                            if (kind == "pipe")
                            {
                                var pipeTypeId = main is Pipe mainPipe ? mainPipe.PipeType.Id : (MepRoutingUtil.FindPipeType(doc, null)?.Id ?? ElementId.InvalidElementId);
                                var systemTypeId = ResolveMainSystemTypeId(doc, main, "pipe");
                                var levelId = ResolveLevelId(doc, main, ctx.Level, a.Z);
                                if (pipeTypeId == ElementId.InvalidElementId || systemTypeId == ElementId.InvalidElementId || levelId == ElementId.InvalidElementId)
                                    throw new InvalidOperationException("Could not resolve pipe branch system/type/level from the main element.");

                                var pipe = Pipe.Create(doc, systemTypeId, pipeTypeId, levelId, a, b);
                                MepRoutingUtil.TryApplyPipeSize(pipe, size, out sizeApplied);
                                curve = pipe;
                            }
                            else
                            {
                                var ductTypeId = main is Duct mainDuct ? mainDuct.DuctType.Id : (MepRoutingUtil.FindDuctType(doc, null)?.Id ?? ElementId.InvalidElementId);
                                var systemTypeId = ResolveMainSystemTypeId(doc, main, "duct");
                                var levelId = ResolveLevelId(doc, main, ctx.Level, a.Z);
                                if (ductTypeId == ElementId.InvalidElementId || systemTypeId == ElementId.InvalidElementId || levelId == ElementId.InvalidElementId)
                                    throw new InvalidOperationException("Could not resolve duct branch system/type/level from the main element.");

                                var duct = Duct.Create(doc, systemTypeId, ductTypeId, levelId, a, b);
                                MepRoutingUtil.TryApplyDuctSize(duct, size, out sizeApplied);
                                curve = duct;
                            }

                            branchElements.Add(curve);
                            createdBranchIds.Add(ElementIdCompat.GetValue(curve.Id));
                        }

                        doc.Regenerate();

                        if (branchElements.Count > 0)
                        {
                            var firstConnector = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[0]), snapped[0], 0.25);
                            var ok = MepRoutingUtil.TryCreateElbowOrConnect(doc, nearestConnector, firstConnector, out var fittingId, out var method, out var err);
                            if (fittingId.HasValue) createdFittingIds.Add(fittingId.Value);
                            connectionAttempts.Add(new
                            {
                                connection = "main_to_branch",
                                mainElementId = p.mainElementId,
                                branchElementId = createdBranchIds.FirstOrDefault(),
                                connected = ok,
                                method,
                                fittingId,
                                error = err
                            });
                        }

                        for (var i = 0; i < branchElements.Count - 1; i++)
                        {
                            var shared = snapped[i + 1];
                            var a = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[i]), shared, 0.25);
                            var b = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[i + 1]), shared, 0.25);
                            var ok = MepRoutingUtil.TryCreateElbowOrConnect(doc, a, b, out var fittingId, out var method, out var err);
                            if (fittingId.HasValue) createdFittingIds.Add(fittingId.Value);
                            connectionAttempts.Add(new
                            {
                                connection = "branch_internal",
                                fromSegment = i,
                                toSegment = i + 1,
                                connected = ok,
                                method,
                                fittingId,
                                error = err
                            });
                        }

                        doc.Regenerate();
                        openConnectorCount = MepRoutingUtil.CountOpenConnectors(branchElements.Concat(new[] { main }));
                        if (connectionAttempts.Any(x => !TryReadConnected(x)))
                        {
                            warnings.Add("One or more branch connector/fitting attempts failed; inspect connectionAttempts before relying on the branch.");
                        }
                        if (openConnectorCount.GetValueOrDefault(0) > 0)
                        {
                            warnings.Add($"Connector verification found {openConnectorCount} open connector(s) across the main and created branch elements.");
                        }

                        tx.Commit();
                    }
                    catch (Exception ex)
                    {
                        try { tx.RollBack(); } catch { }
                        rolledBack = true;
                        return Task.FromResult<object>(new
                        {
                            status = "Blocked",
                            dryRun = false,
                            scaffoldOnly = false,
                            error = ex.Message,
                            kind,
                            mainElementId = p.mainElementId,
                            createdBranchElementIds = new List<long>(),
                            createdFittingIds = new List<long>(),
                            connectionAttempts,
                            warnings,
                            rolledBack = true
                        });
                    }
                }
            }

            return Task.FromResult<object>(new
            {
                status,
                dryRun = p.dryRun,
                scaffoldOnly = p.dryRun || !feasibleExistingConnector,
                kind,
                main = new
                {
                    id = ElementIdCompat.GetValue(main.Id),
                    category = mainCategory,
                    name = main.Name,
                    connectorCount = connectors.Count
                },
                branchPlan = new
                {
                    points = branch.Select(ToPointObject).ToList(),
                    segmentCount = Math.Max(0, branch.Count - 1),
                    requestedSize = string.IsNullOrWhiteSpace(p.branchSize) ? null : p.branchSize,
                    connectionMode = string.IsNullOrWhiteSpace(p.connectionMode) ? "auto" : p.connectionMode
                },
                mainIntersection = new
                {
                    branchStart = ToPointObject(branchStart),
                    nearestPointOnMain = nearestPoint == null ? null : ToPointObject(nearestPoint),
                    distanceToMainFt = distanceToMain,
                    curveParameter = normalizedParameter
                },
                existingConnectorFeasibility = new
                {
                    nearestOpenConnectorFound = feasibleExistingConnector,
                    nearestConnectorDistanceFt = nearestConnectorDistance,
                    nearestConnectorOpen
                },
                createdBranchElementIds = createdBranchIds,
                createdFittingIds,
                connectionAttempts,
                openConnectorCount,
                applyStatus = p.dryRun ? "NotAppliedDryRun" : (feasibleExistingConnector ? "AppliedExistingOpenConnectorOnly" : "GuardedScaffoldOnly"),
                recommendedNextImplementationStep = nextStep,
                warnings,
                rolledBack
            });
        }

        private static ElementId ResolveMainSystemTypeId(Document doc, Element main, string kind)
        {
            try
            {
                ElementId? id = null;
                if (main is Duct duct) id = duct.MEPSystem?.GetTypeId();
                if (main is Pipe pipe) id = pipe.MEPSystem?.GetTypeId();
                if (id != null && id != ElementId.InvalidElementId) return id;
            }
            catch { }

            var fallback = MepRoutingUtil.FindSystemType(doc, null);
            return fallback?.Id ?? ElementId.InvalidElementId;
        }

        private static ElementId ResolveLevelId(Document doc, Element main, Level? contextLevel, double z)
        {
            try
            {
                if (main is MEPCurve curve && curve.ReferenceLevel != null) return curve.ReferenceLevel.Id;
            }
            catch { }

            if (contextLevel != null) return contextLevel.Id;
            return MepRoutingUtil.ResolveLevelFromZ(doc, z)?.Id ?? ElementId.InvalidElementId;
        }

        private static bool TryReadConnected(object value)
        {
            try
            {
                var prop = value.GetType().GetProperty("connected");
                return prop?.GetValue(value) is bool b && b;
            }
            catch
            {
                return false;
            }
        }

        private static object ToPointObject(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };
    }
}
