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

namespace RevitBridge.Logic.Handlers.MEP
{
    public class EditMepRouteElementsHandler : IRequestHandler
    {
        public sealed class Params
        {
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
            if (!changesSize && !changesElevation) throw new ArgumentException("Request must include a size change or elevation change.");
            if (p.deltaZFt.HasValue && p.targetCenterlineZFt.HasValue) throw new ArgumentException("Specify either deltaZFt or targetCenterlineZFt, not both.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

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
    }
}
