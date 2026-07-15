using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.Drafting;

namespace RevitBridge.Logic.Handlers.MEP
{
    public static class MepRoutingUtil
    {
        public sealed class RoutePoint
        {
            public double? x { get; set; }
            public double? y { get; set; }
            public double? z { get; set; }
            public int? xPx { get; set; }
            public int? yPx { get; set; }
            public double[]? xyz { get; set; }
        }

        public class RoutingContextRequest
        {
            public long? viewId { get; set; }
            public string? roomNumber { get; set; }
            public string? levelName { get; set; }
            public long? levelId { get; set; }
            public string? systemKind { get; set; }
            public string? systemClassification { get; set; }
            public string? routingMode { get; set; }
            public double? defaultOffsetFt { get; set; }
            public double? ceilingOffsetFt { get; set; }
            public bool dryRun { get; set; } = true;
        }

        internal sealed class RoutingContext
        {
            public string SystemKind { get; set; } = "";
            public View? View { get; set; }
            public Level? Level { get; set; }
            public Element? RoomOrSpace { get; set; }
            public string SpatialKind { get; set; } = "";
            public double? BaseZ { get; set; }
            public double? TopZ { get; set; }
            public Ceiling? Ceiling { get; set; }
            public double? CeilingBottomZ { get; set; }
            public object? CeilingScore { get; set; }
            public Level? NextLevel { get; set; }
            public double RecommendedZ { get; set; }
            public string RecommendedMode { get; set; } = "";
            public string Confidence { get; set; } = "low";
            public string Assumption { get; set; } = "";
            public List<string> Warnings { get; } = new List<string>();

            public object ToResponse(string status)
            {
                return new
                {
                    status,
                    systemKind = SystemKind,
                    view = View == null ? null : new
                    {
                        id = ElementIdCompat.GetValue(View.Id),
                        name = View.Name,
                        type = View.ViewType.ToString(),
                        levelId = GetViewLevel(View) == null ? (long?)null : ElementIdCompat.GetValue(GetViewLevel(View)!.Id),
                        levelName = GetViewLevel(View)?.Name
                    },
                    room = RoomOrSpace == null ? null : new
                    {
                        id = ElementIdCompat.GetValue(RoomOrSpace.Id),
                        number = GetSpatialNumber(RoomOrSpace),
                        name = RoomOrSpace.Name,
                        kind = SpatialKind,
                        levelName = Level?.Name,
                        baseZ = BaseZ,
                        topZ = TopZ,
                        boundaryLoops = RoomOrSpace is Room room ? GetRoomBoundaryLoops(room) : null
                    },
                    level = Level == null ? null : new { id = ElementIdCompat.GetValue(Level.Id), name = Level.Name, elevation = Level.Elevation },
                    ceiling = new
                    {
                        found = Ceiling != null,
                        id = Ceiling == null ? (long?)null : ElementIdCompat.GetValue(Ceiling.Id),
                        bottomZ = CeilingBottomZ,
                        confidence = Ceiling == null ? null : "medium",
                        source = Ceiling == null ? null : "room-footprint-overlap",
                        score = CeilingScore
                    },
                    nextLevel = new
                    {
                        found = NextLevel != null,
                        id = NextLevel == null ? (long?)null : ElementIdCompat.GetValue(NextLevel.Id),
                        name = NextLevel?.Name,
                        elevation = NextLevel?.Elevation
                    },
                    recommendedElevation = new
                    {
                        zFt = RecommendedZ,
                        mode = RecommendedMode,
                        confidence = Confidence,
                        assumption = Assumption
                    },
                    warnings = Warnings
                };
            }
        }

        internal sealed class SizeChoice
        {
            public string RequestedText { get; set; } = "";
            public string AppliedText { get; set; } = "";
            public double? WidthFt { get; set; }
            public double? HeightFt { get; set; }
            public double? DiameterFt { get; set; }
            public bool UsedDefault { get; set; }
            public bool Missing { get; set; }
        }

        internal static RoutingContext ResolveRoutingContext(Document doc, UIApplication app, RoutingContextRequest req)
        {
            var ctx = new RoutingContext { SystemKind = NormalizeKind(req.systemKind) };
            var defaultOffset = req.defaultOffsetFt.GetValueOrDefault(10.0);
            var ceilingOffset = req.ceilingOffsetFt.GetValueOrDefault(1.0);
            if (defaultOffset <= 0) defaultOffset = 10.0;
            if (ceilingOffset < 0) ceilingOffset = 1.0;

            ctx.View = ResolveView(doc, app, req.viewId);
            var viewLevel = ctx.View == null ? null : GetViewLevel(ctx.View);
            ctx.Level = ResolveLevel(doc, req.levelId, req.levelName) ?? viewLevel;

            if (!string.IsNullOrWhiteSpace(req.roomNumber))
            {
                ctx.RoomOrSpace = ResolveRoomOrSpace(doc, req.roomNumber!.Trim());
                if (ctx.RoomOrSpace == null)
                {
                    ctx.Warnings.Add($"No Room or Space matched number '{req.roomNumber}'.");
                }
                else
                {
                    ctx.SpatialKind = ctx.RoomOrSpace is Room ? "room" : "space";
                    ResolveSpatialVerticalContext(doc, ctx.RoomOrSpace, ref ctx);
                    if (ctx.Level == null) ctx.Level = ResolveLevelFromZ(doc, ctx.BaseZ);
                }
            }

            if (ctx.Level == null)
            {
                ctx.Level = CollectLevels(doc).OrderBy(l => l.Elevation).FirstOrDefault();
                if (ctx.Level != null) ctx.Warnings.Add($"No level was explicit or inferable from view/room; using first level '{ctx.Level.Name}'.");
            }

            if (ctx.Level == null)
            {
                ctx.RecommendedZ = defaultOffset;
                ctx.RecommendedMode = "unresolved";
                ctx.Confidence = "low";
                ctx.Assumption = $"No level was found; using absolute Z={defaultOffset.ToString("G6", CultureInfo.InvariantCulture)} ft.";
                ctx.Warnings.Add("No levels found in the model.");
                return ctx;
            }

            ctx.NextLevel = FindNextLevel(doc, ctx.Level);

            if (ctx.RoomOrSpace != null)
            {
                var ceilings = CollectCeilings(doc);
                if (TryFindPrimaryCeilingForSpatial(ctx.RoomOrSpace, ceilings, ctx.BaseZ ?? ctx.Level.Elevation, out var ceiling, out var bottomZ, out var score))
                {
                    ctx.Ceiling = ceiling;
                    ctx.CeilingBottomZ = bottomZ;
                    ctx.CeilingScore = score;
                }
                else
                {
                    ctx.Warnings.Add("No ceiling was found overlapping the requested room/space footprint.");
                }
            }

            var mode = (req.routingMode ?? "auto").Trim().ToLowerInvariant();
            if (ctx.CeilingBottomZ.HasValue && (mode == "auto" || mode == "above_ceiling"))
            {
                ctx.RecommendedZ = ctx.CeilingBottomZ.Value + ceilingOffset;
                ctx.RecommendedMode = "above_ceiling";
                ctx.Confidence = "high";
                ctx.Assumption = $"Using ceiling bottom + {ceilingOffset.ToString("G6", CultureInfo.InvariantCulture)} ft.";
            }
            else if (ctx.BaseZ.HasValue && ctx.TopZ.HasValue && (mode == "auto" || mode == "plenum_midpoint"))
            {
                var baseZ = ctx.BaseZ.Value;
                var topZ = ctx.TopZ.Value;
                if (topZ > baseZ + 2.0)
                {
                    ctx.RecommendedZ = (baseZ + topZ) * 0.5;
                    ctx.RecommendedMode = "plenum_midpoint";
                    ctx.Confidence = "medium";
                    ctx.Assumption = "No ceiling match; using midpoint between spatial base and top.";
                    ctx.Warnings.Add("Recommended elevation is a fallback because no ceiling elevation was available.");
                }
                else
                {
                    ctx.RecommendedZ = baseZ + defaultOffset;
                    ctx.RecommendedMode = "level_offset";
                    ctx.Confidence = "low";
                    ctx.Assumption = $"Room/space top was too close to base; using base + {defaultOffset.ToString("G6", CultureInfo.InvariantCulture)} ft.";
                    ctx.Warnings.Add("Recommended elevation is a low-confidence fallback.");
                }
            }
            else if (mode == "level_offset")
            {
                ctx.RecommendedZ = ctx.Level.Elevation + defaultOffset;
                ctx.RecommendedMode = "level_offset";
                ctx.Confidence = "medium";
                ctx.Assumption = $"Using level elevation + {defaultOffset.ToString("G6", CultureInfo.InvariantCulture)} ft.";
                ctx.Warnings.Add("Using explicit level offset routing mode.");
            }
            else if (ctx.NextLevel != null)
            {
                ctx.RecommendedZ = (ctx.Level.Elevation + ctx.NextLevel.Elevation) * 0.5;
                ctx.RecommendedMode = "between_levels_midpoint";
                ctx.Confidence = "low";
                ctx.Assumption = "No room/ceiling elevation was available; using midpoint between current and next level.";
                ctx.Warnings.Add("Recommended elevation is a fallback because room/ceiling context was incomplete.");
            }
            else
            {
                ctx.RecommendedZ = ctx.Level.Elevation + defaultOffset;
                ctx.RecommendedMode = "level_offset";
                ctx.Confidence = "low";
                ctx.Assumption = $"No next level or ceiling context was available; using level + {defaultOffset.ToString("G6", CultureInfo.InvariantCulture)} ft.";
                ctx.Warnings.Add("Recommended elevation is a low-confidence fallback.");
            }

            if (ctx.NextLevel != null && ctx.RecommendedZ >= ctx.NextLevel.Elevation - 0.25)
            {
                ctx.Warnings.Add("Recommended elevation is close to or above the next level; verify before applying route geometry.");
            }

            return ctx;
        }

        internal static XYZ ResolveRoutePoint(RoutePoint point, string? frameId, double fallbackZ, out bool usedFallbackZ)
        {
            usedFallbackZ = false;
            if (point == null) throw new InvalidOperationException("Route point cannot be null.");

            XYZ resolved;
            var hasExplicitZ = false;
            if (point.xyz != null && point.xyz.Length >= 2)
            {
                hasExplicitZ = point.xyz.Length >= 3;
                resolved = new XYZ(point.xyz[0], point.xyz[1], hasExplicitZ ? point.xyz[2] : 0.0);
            }
            else if (point.x.HasValue && point.y.HasValue)
            {
                hasExplicitZ = point.z.HasValue;
                resolved = new XYZ(point.x.Value, point.y.Value, point.z.GetValueOrDefault(0.0));
            }
            else if (point.xPx.HasValue && point.yPx.HasValue)
            {
                var dp = new DraftPoint { xPx = point.xPx, yPx = point.yPx };
                var projected = dp.Resolve(frameId);
                hasExplicitZ = point.z.HasValue;
                resolved = new XYZ(projected.X, projected.Y, point.z.GetValueOrDefault(0.0));
            }
            else
            {
                throw new InvalidOperationException("Each route point must provide x/y[/z], xyz, or xPx/yPx.");
            }

            if (!hasExplicitZ)
            {
                usedFallbackZ = true;
                resolved = new XYZ(resolved.X, resolved.Y, fallbackZ);
            }

            return resolved;
        }

        internal static Level? ResolveLevel(Document doc, long? levelId, string? levelName)
        {
            if (levelId.HasValue && levelId.Value > 0)
            {
                var e = doc.GetElement(ElementIdCompat.Create(levelId.Value)) as Level;
                if (e != null) return e;
            }

            var name = (levelName ?? "").Trim();
            var levels = CollectLevels(doc);
            if (name.Length > 0)
            {
                var exact = levels.FirstOrDefault(l => l.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
                if (exact != null) return exact;
                var contains = levels.FirstOrDefault(l => l.Name.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0);
                if (contains != null) return contains;
            }

            return null;
        }

        internal static List<Level> CollectLevels(Document doc)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .OrderBy(l => l.Elevation)
                .ToList();
        }

        internal static Level? ResolveLevelFromZ(Document doc, double? z)
        {
            if (!z.HasValue) return null;
            return CollectLevels(doc)
                .OrderBy(l => Math.Abs(l.Elevation - z.Value))
                .FirstOrDefault();
        }

        internal static Level? FindNextLevel(Document doc, Level level)
        {
            return CollectLevels(doc)
                .Where(l => l.Elevation > level.Elevation + 1e-6)
                .OrderBy(l => l.Elevation)
                .FirstOrDefault();
        }

        internal static MEPSystemType? FindSystemType(Document doc, string? name, string? kind = null)
        {
            var q = (name ?? "").Trim();
            var normalizedKind = NormalizeKind(kind);
            var all = new FilteredElementCollector(doc)
                .OfClass(typeof(MEPSystemType))
                .Cast<MEPSystemType>()
                .ToList();
            var matchingKind = all.Where(x => SystemTypeMatchesKind(x, normalizedKind)).ToList();
            var candidates = matchingKind.Count > 0 ? matchingKind : all;
            if (q.Length > 0)
            {
                var exact = candidates.FirstOrDefault(x => x.Name.Equals(q, StringComparison.OrdinalIgnoreCase));
                if (exact != null) return exact;
                var contains = candidates.FirstOrDefault(x => x.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0);
                if (contains != null) return contains;
            }
            return candidates.FirstOrDefault();
        }

        private static bool SystemTypeMatchesKind(MEPSystemType systemType, string kind)
        {
            try
            {
                var catId = ElementIdCompat.GetValue(systemType.Category?.Id);
                if (kind == "pipe") return catId == (int)BuiltInCategory.OST_PipingSystem;
                if (kind == "duct") return catId == (int)BuiltInCategory.OST_DuctSystem;
            }
            catch { }
            return false;
        }

        internal static DuctType? FindDuctType(Document doc, string? name)
        {
            var q = (name ?? "").Trim();
            var all = new FilteredElementCollector(doc).OfClass(typeof(DuctType)).Cast<DuctType>().ToList();
            if (q.Length > 0)
            {
                var exact = all.FirstOrDefault(x => x.Name.Equals(q, StringComparison.OrdinalIgnoreCase));
                if (exact != null) return exact;
                var exactFamily = all.FirstOrDefault(x => x.FamilyName.Equals(q, StringComparison.OrdinalIgnoreCase));
                if (exactFamily != null) return exactFamily;
                var contains = all.FirstOrDefault(x => x.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0);
                if (contains != null) return contains;
                var familyContains = all.FirstOrDefault(x => x.FamilyName.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0);
                if (familyContains != null) return familyContains;
            }
            return all.FirstOrDefault();
        }

        internal static PipeType? FindPipeType(Document doc, string? name)
        {
            var q = (name ?? "").Trim();
            var all = new FilteredElementCollector(doc).OfClass(typeof(PipeType)).Cast<PipeType>().ToList();
            if (q.Length > 0)
            {
                var exact = all.FirstOrDefault(x => x.Name.Equals(q, StringComparison.OrdinalIgnoreCase));
                if (exact != null) return exact;
                var contains = all.FirstOrDefault(x => x.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0);
                if (contains != null) return contains;
            }
            return all.FirstOrDefault();
        }

        internal static SizeChoice ChooseSize(string kind, string? ductSize, string? diameter, string? pipeSize, string? sizePolicy, List<string> warnings)
        {
            var k = NormalizeKind(kind);
            var explicitRequired = string.Equals((sizePolicy ?? "").Trim(), "explicit_required", StringComparison.OrdinalIgnoreCase);
            var choice = new SizeChoice();
            if (k == "pipe")
            {
                var requested = FirstNonEmpty(diameter, pipeSize);
                choice.RequestedText = requested;
                if (requested.Length == 0)
                {
                    choice.Missing = true;
                    if (explicitRequired) return choice;
                    choice.AppliedText = "1";
                    choice.DiameterFt = 1.0 / 12.0;
                    choice.UsedDefault = true;
                    warnings.Add("Pipe size was missing; using conservative placeholder 1 inch diameter.");
                    return choice;
                }
                choice.AppliedText = requested;
                choice.DiameterFt = ParseLengthFeet(requested);
                if (!choice.DiameterFt.HasValue) warnings.Add($"Could not parse pipe size '{requested}'.");
                return choice;
            }

            var duct = (ductSize ?? "").Trim().Replace("X", "x").Replace("×", "x");
            choice.RequestedText = duct;
            if (duct.Length == 0)
            {
                choice.Missing = true;
                if (explicitRequired) return choice;
                choice.AppliedText = "8x8";
                choice.WidthFt = 8.0 / 12.0;
                choice.HeightFt = 8.0 / 12.0;
                choice.UsedDefault = true;
                warnings.Add("Duct size was missing; using conservative placeholder 8x8 inch rectangular duct.");
                return choice;
            }

            choice.AppliedText = duct;
            if (duct.Contains("x"))
            {
                var parts = duct.Split(new[] { 'x' }, StringSplitOptions.RemoveEmptyEntries).Select(x => x.Trim()).ToArray();
                if (parts.Length == 2)
                {
                    choice.WidthFt = ParseLengthFeet(parts[0]);
                    choice.HeightFt = ParseLengthFeet(parts[1]);
                }
                if (!choice.WidthFt.HasValue || !choice.HeightFt.HasValue) warnings.Add($"Could not parse rectangular duct size '{duct}'.");
            }
            else
            {
                choice.DiameterFt = ParseLengthFeet(duct);
                if (!choice.DiameterFt.HasValue) warnings.Add($"Could not parse round duct size '{duct}'.");
            }
            return choice;
        }

        internal static double? ParseLengthFeet(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;
            if (!EngineeringLengthText.TryParseLengthToFeet(raw, unitlessIsInches: true, out var feet)) return null;
            return double.IsNaN(feet) || double.IsInfinity(feet) || feet <= 0 ? (double?)null : feet;
        }

        internal static bool TryApplyDuctSize(Duct duct, SizeChoice size, out object result)
        {
            var width = size.WidthFt.HasValue && TrySetBuiltinOrNamedDouble(duct, BuiltInParameter.RBS_CURVE_WIDTH_PARAM, new[] { "Width", "Duct Width", "W" }, size.WidthFt.Value);
            var height = size.HeightFt.HasValue && TrySetBuiltinOrNamedDouble(duct, BuiltInParameter.RBS_CURVE_HEIGHT_PARAM, new[] { "Height", "Duct Height", "H" }, size.HeightFt.Value);
            var diameter = size.DiameterFt.HasValue && TrySetBuiltinOrNamedDouble(duct, BuiltInParameter.RBS_CURVE_DIAMETER_PARAM, new[] { "Diameter", "Duct Diameter", "Size" }, size.DiameterFt.Value);
            result = new { width, height, diameter };
            return width || height || diameter;
        }

        internal static bool TryApplyPipeSize(Pipe pipe, SizeChoice size, out object result)
        {
            var diameter = size.DiameterFt.HasValue && TrySetBuiltinOrNamedDouble(pipe, BuiltInParameter.RBS_PIPE_DIAMETER_PARAM, new[] { "Diameter", "Pipe Diameter", "Size" }, size.DiameterFt.Value);
            result = new { diameter };
            return diameter;
        }

        internal static List<Connector> GetConnectors(Element e)
        {
            return MepSystemUtil.GetConnectors(e).Where(c => c != null).ToList();
        }

        internal static Connector? FindClosestConnector(IEnumerable<Connector> connectors, XYZ point, double maxDistanceFt = double.MaxValue)
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
                catch { }
            }
            return bestDist <= maxDistanceFt ? best : null;
        }

        internal static bool TryConnect(Connector? a, Connector? b, out string? error)
        {
            error = null;
            if (a == null || b == null)
            {
                error = "Connector not found near shared point.";
                return false;
            }
            try
            {
                if (a.IsConnectedTo(b)) return true;
            }
            catch { }

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

        internal static bool IsPhysicallyConnected(Connector? connector)
        {
            if (connector == null) return false;
            try
            {
                var ownerId = connector.Owner == null ? 0 : ElementIdCompat.GetValue(connector.Owner.Id);
                foreach (Connector reference in connector.AllRefs)
                {
                    if (reference == null || reference.Owner == null) continue;
                    if (reference.Owner is MEPSystem) continue;
                    if (ElementIdCompat.GetValue(reference.Owner.Id) == ownerId) continue;
                    return true;
                }
            }
            catch { }
            return false;
        }

        internal static Connector? FindClosestCompatibleOpenConnector(
            Document doc,
            Connector source,
            ISet<long> excludedOwnerIds,
            double maxDistanceFt,
            out double distanceFt)
        {
            Connector? best = null;
            distanceFt = double.MaxValue;
            var bestOwnerId = long.MaxValue;
            foreach (var element in new FilteredElementCollector(doc).WhereElementIsNotElementType().ToElements())
            {
                if (element == null || element is MEPSystem) continue;
                var ownerId = ElementIdCompat.GetValue(element.Id);
                if (excludedOwnerIds.Contains(ownerId)) continue;

                foreach (var candidate in GetConnectors(element))
                {
                    if (candidate == null || IsPhysicallyConnected(candidate) || !AreConnectorsCompatible(source, candidate)) continue;
                    double distance;
                    try { distance = source.Origin.DistanceTo(candidate.Origin); }
                    catch { continue; }
                    if (distance > maxDistanceFt) continue;
                    if (distance < distanceFt - 1e-9 || (Math.Abs(distance - distanceFt) <= 1e-9 && ownerId < bestOwnerId))
                    {
                        best = candidate;
                        distanceFt = distance;
                        bestOwnerId = ownerId;
                    }
                }
            }
            return best;
        }

        internal static bool AreConnectorsCompatible(Connector a, Connector b)
        {
            try
            {
                if (a.Domain != b.Domain || a.Shape != b.Shape) return false;
                const double toleranceFt = 1.0 / 192.0; // 1/16 inch
                if (a.Shape == ConnectorProfileType.Round)
                    return Math.Abs(a.Radius - b.Radius) <= toleranceFt;
                var direct = Math.Abs(a.Width - b.Width) <= toleranceFt && Math.Abs(a.Height - b.Height) <= toleranceFt;
                var rotated = Math.Abs(a.Width - b.Height) <= toleranceFt && Math.Abs(a.Height - b.Width) <= toleranceFt;
                return direct || rotated;
            }
            catch
            {
                return false;
            }
        }

        internal static bool TryCreateElbowOrConnect(Document doc, Connector? a, Connector? b, out long? fittingId, out string method, out string? error)
        {
            fittingId = null;
            method = "none";
            error = null;
            if (a == null || b == null)
            {
                error = "Connector not found near shared point.";
                return false;
            }

            try
            {
                if (a.IsConnectedTo(b))
                {
                    method = "already_connected";
                    return true;
                }
            }
            catch { }

            try
            {
                var fitting = doc.Create.NewElbowFitting(a, b);
                if (fitting != null)
                {
                    fittingId = ElementIdCompat.GetValue(fitting.Id);
                    method = "new_elbow_fitting";
                    return true;
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
            }

            if (TryConnect(a, b, out var connectError))
            {
                method = "connector_connect_to";
                error = null;
                return true;
            }

            method = "failed";
            if (!string.IsNullOrWhiteSpace(connectError))
            {
                error = string.IsNullOrWhiteSpace(error) ? connectError : $"{error}; ConnectTo fallback: {connectError}";
            }
            return false;
        }

        internal static bool TryCreateTransitionElbowOrConnect(Document doc, Connector? a, Connector? b, bool preferTransition, out long? fittingId, out string method, out string? error)
        {
            fittingId = null;
            method = "none";
            error = null;
            if (a == null || b == null)
            {
                error = "Connector not found near shared point.";
                return false;
            }

            try
            {
                if (a.IsConnectedTo(b))
                {
                    method = "already_connected";
                    return true;
                }
            }
            catch { }

            if (preferTransition)
            {
                try
                {
                    var fitting = doc.Create.NewTransitionFitting(a, b);
                    if (fitting != null)
                    {
                        fittingId = ElementIdCompat.GetValue(fitting.Id);
                        method = "new_transition_fitting";
                        return true;
                    }
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                }

                method = "transition_required_failed";
                error = string.IsNullOrWhiteSpace(error)
                    ? "A transition fitting was required because adjacent segment sizes differ, but Revit did not create one."
                    : $"A transition fitting was required because adjacent segment sizes differ, but Revit did not create one: {error}";
                return false;
            }

            if (TryCreateElbowOrConnect(doc, a, b, out fittingId, out method, out var elbowError))
            {
                error = null;
                return true;
            }

            if (!string.IsNullOrWhiteSpace(elbowError))
            {
                error = string.IsNullOrWhiteSpace(error) ? elbowError : $"{error}; Elbow/connect fallback: {elbowError}";
            }
            return false;
        }

        internal static int CountOpenConnectors(IEnumerable<Element> elements)
        {
            var count = 0;
            foreach (var e in elements ?? Enumerable.Empty<Element>())
            {
                foreach (var c in GetConnectors(e))
                {
                    try
                    {
                        if (!IsPhysicallyConnected(c)) count++;
                    }
                    catch
                    {
                        count++;
                    }
                }
            }
            return count;
        }

        internal static string NormalizeKind(string? kind)
        {
            var k = (kind ?? "").Trim().ToLowerInvariant();
            if (k == "pipe" || k == "piping") return "pipe";
            return "duct";
        }

        private static string FirstNonEmpty(params string?[] values)
        {
            foreach (var v in values)
            {
                var s = (v ?? "").Trim();
                if (s.Length > 0) return s;
            }
            return "";
        }

        private static bool TrySetBuiltinOrNamedDouble(Element e, BuiltInParameter bip, string[] names, double value)
        {
            try
            {
                var p = e.get_Parameter(bip);
                if (p != null && !p.IsReadOnly && p.StorageType == StorageType.Double && p.Set(value)) return true;
            }
            catch { }

            foreach (var n in names)
            {
                try
                {
                    var p = e.LookupParameter(n);
                    if (p != null && !p.IsReadOnly && p.StorageType == StorageType.Double && p.Set(value)) return true;
                }
                catch { }
            }
            return false;
        }

        private static View? ResolveView(Document doc, UIApplication app, long? viewId)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                var v = doc.GetElement(ElementIdCompat.Create(viewId.Value)) as View;
                if (v != null) return v;
            }
            try { return app.ActiveUIDocument?.ActiveView; } catch { return null; }
        }

        private static Level? GetViewLevel(View view)
        {
            try
            {
                if (view is ViewPlan vp) return vp.GenLevel;
            }
            catch { }
            return null;
        }

        private static Element? ResolveRoomOrSpace(Document doc, string roomNumber)
        {
            var normalized = NormalizeRoomNumber(roomNumber);
            var room = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_Rooms)
                .WhereElementIsNotElementType()
                .OfType<Room>()
                .FirstOrDefault(r => NormalizeRoomNumber(r.Number ?? "") == normalized);
            if (room != null) return room;

            try
            {
                return new FilteredElementCollector(doc)
                    .OfCategory(BuiltInCategory.OST_MEPSpaces)
                    .WhereElementIsNotElementType()
                    .FirstOrDefault(e => NormalizeRoomNumber(GetSpatialNumber(e)) == normalized);
            }
            catch
            {
                return null;
            }
        }

        private static void ResolveSpatialVerticalContext(Document doc, Element spatial, ref RoutingContext ctx)
        {
            if (spatial is Room room)
            {
                try
                {
                    ctx.Level = room.Level ?? ctx.Level;
                    if (room.Level != null) ctx.BaseZ = room.Level.Elevation + room.BaseOffset;
                    if (room.UpperLimit != null) ctx.TopZ = room.UpperLimit.Elevation + room.LimitOffset;
                    else ctx.TopZ = ctx.BaseZ + room.UnboundedHeight;
                    return;
                }
                catch { }
            }

            try
            {
                var bb = spatial.get_BoundingBox(null);
                if (bb != null)
                {
                    ctx.BaseZ = bb.Min.Z;
                    ctx.TopZ = bb.Max.Z;
                }
            }
            catch { }
        }

        private static List<Ceiling> CollectCeilings(Document doc)
        {
            try
            {
                return new FilteredElementCollector(doc)
                    .OfCategory(BuiltInCategory.OST_Ceilings)
                    .WhereElementIsNotElementType()
                    .OfType<Ceiling>()
                    .ToList();
            }
            catch
            {
                return new List<Ceiling>();
            }
        }

        private static bool TryFindPrimaryCeilingForSpatial(Element spatial, List<Ceiling> ceilings, double baseZ, out Ceiling? ceiling, out double ceilingBottomZ, out object score)
        {
            ceiling = null;
            ceilingBottomZ = 0.0;
            score = new { };
            if (ceilings.Count == 0) return false;

            BoundingBoxXYZ? spatialBb = null;
            try { spatialBb = spatial.get_BoundingBox(null); } catch { }
            if (spatialBb == null) return false;

            var candidates = new List<(Ceiling c, double bottomZ, double area, double centerX, double centerY)>();
            foreach (var c in ceilings)
            {
                BoundingBoxXYZ? bb = null;
                try { bb = c.get_BoundingBox(null); } catch { }
                if (bb == null) continue;
                if (bb.Max.X < spatialBb.Min.X - 0.5 || bb.Min.X > spatialBb.Max.X + 0.5) continue;
                if (bb.Max.Y < spatialBb.Min.Y - 0.5 || bb.Min.Y > spatialBb.Max.Y + 0.5) continue;

                var center = (bb.Min + bb.Max) * 0.5;
                var inFootprint = true;
                if (spatial is Room room)
                {
                    try { inFootprint = room.IsPointInRoom(new XYZ(center.X, center.Y, baseZ + 0.1)); }
                    catch { inFootprint = false; }
                }
                if (!inFootprint) continue;

                candidates.Add((c, bb.Min.Z, TryGetCeilingArea(c), center.X, center.Y));
            }

            if (candidates.Count == 0) return false;
            var best = candidates.OrderByDescending(x => x.area).ThenBy(x => x.bottomZ).First();
            ceiling = best.c;
            ceilingBottomZ = best.bottomZ;
            score = new { areaSqft = best.area, bottomZ = best.bottomZ, centerX = best.centerX, centerY = best.centerY };
            return true;
        }

        private static double TryGetCeilingArea(Ceiling c)
        {
            try
            {
                var p = c.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED);
                if (p != null && p.StorageType == StorageType.Double) return Math.Max(0.0, p.AsDouble());
            }
            catch { }
            return 0.0;
        }

        private static string GetSpatialNumber(Element e)
        {
            try
            {
                if (e is Room room) return room.Number ?? "";
                var p = e.LookupParameter("Number") ?? e.LookupParameter("Space Number");
                var s = p?.AsString() ?? p?.AsValueString();
                return (s ?? "").Trim();
            }
            catch { return ""; }
        }

        private static List<object>? GetRoomBoundaryLoops(Room room)
        {
            try
            {
                var opts = new SpatialElementBoundaryOptions();
                var loops = room.GetBoundarySegments(opts);
                if (loops == null) return null;
                var outLoops = new List<object>();
                foreach (var loop in loops)
                {
                    var pts = new List<object>();
                    foreach (var seg in loop)
                    {
                        var c = seg.GetCurve();
                        if (c == null) continue;
                        var p0 = c.GetEndPoint(0);
                        var p1 = c.GetEndPoint(1);
                        pts.Add(new { start = new[] { p0.X, p0.Y, p0.Z }, end = new[] { p1.X, p1.Y, p1.Z } });
                    }
                    outLoops.Add(pts);
                }
                return outLoops;
            }
            catch
            {
                return null;
            }
        }

        private static string NormalizeRoomNumber(string s)
        {
            var t = (s ?? "").Trim();
            if (t.Length == 0) return "";
            for (var i = 0; i < t.Length; i++)
            {
                if (!char.IsDigit(t[i])) return t;
            }
            var trimmed = t.TrimStart('0');
            return trimmed.Length == 0 ? "0" : trimmed;
        }
    }
}
