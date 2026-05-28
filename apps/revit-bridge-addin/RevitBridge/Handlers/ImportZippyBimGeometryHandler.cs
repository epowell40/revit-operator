using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class ImportZippyBimGeometryHandler : IRequestHandler
    {
        private const double InchesPerFoot = 12.0;
        private const double WallTypeToleranceFeet = 0.25 / InchesPerFoot;
        private const double DefaultDoorHostDistanceFeet = 4.0;
        private const double GridSnapToleranceFeet = 0.20;
        private const double MergeGapToleranceFeet = 0.25;
        private const double CornerExtendToleranceFeet = 0.50;
        private const double WallJoinEndpointToleranceFeet = 0.20;
        private const string ImportedWallsWorksetName = "Operator Import - Walls";
        private const string ImportedVectorsWorksetName = "Operator Import - Vectors";
        private const string VectorUnderlayLineStyleName = "Operator - Floor Plan Underlay";

        public sealed class Metadata
        {
            public string? source { get; set; }
            public string? units { get; set; }
            public double? scale { get; set; }
            public string? notes { get; set; }
        }

        public sealed class ElementDefinition
        {
            public string? id { get; set; }
            public string? element { get; set; }
            public List<List<double>>? path { get; set; }
            public double? thickness { get; set; }
            public double? height { get; set; }
            public List<double>? position { get; set; }
            public double? width { get; set; }
        }

        public sealed class GeometryData
        {
            public Metadata? metadata { get; set; }
            public List<ElementDefinition>? elements { get; set; }
            public object? debug { get; set; }
        }

        public sealed class Params
        {
            public GeometryData? geometry { get; set; }
            public Metadata? metadata { get; set; }
            public List<ElementDefinition>? elements { get; set; }
            public string? sourcePath { get; set; }
            public long? levelId { get; set; }
            public string? levelName { get; set; }
            public double? defaultWallHeightFeet { get; set; }
            public double? minWallLengthFeet { get; set; }
            public bool? importWalls { get; set; }
            public bool? importVectorUnderlay { get; set; }
            public bool? disableWallJoins { get; set; }
            public bool? importDoors { get; set; }
            public bool? dryRun { get; set; }
            public Dictionary<string, string>? wallTypeOverrides { get; set; }
        }

        private sealed class CreatedWallInfo
        {
            public Wall Wall { get; set; } = null!;
            public XYZ Start { get; set; } = XYZ.Zero;
            public XYZ End { get; set; } = XYZ.Zero;
        }

        private sealed class PreparedWallSegment
        {
            public string Id { get; set; } = "";
            public bool IsVertical { get; set; }
            public double ConstCoord { get; set; }
            public double StartCoord { get; set; }
            public double EndCoord { get; set; }
            public double? Thickness { get; set; }
            public double? Height { get; set; }

            public UV StartPoint()
                => IsVertical ? new UV(ConstCoord, StartCoord) : new UV(StartCoord, ConstCoord);

            public UV EndPoint()
                => IsVertical ? new UV(ConstCoord, EndCoord) : new UV(EndCoord, ConstCoord);

            public PreparedWallSegment Clone()
            {
                return new PreparedWallSegment
                {
                    Id = Id,
                    IsVertical = IsVertical,
                    ConstCoord = ConstCoord,
                    StartCoord = StartCoord,
                    EndCoord = EndCoord,
                    Thickness = Thickness,
                    Height = Height
                };
            }
        }

        private sealed class CleanupSummary
        {
            public int InputWallCount { get; set; }
            public int OutputWallCount { get; set; }
            public int WallsMerged { get; set; }
            public int EndpointsExtended { get; set; }
            public int GridSnaps { get; set; }
        }

        private sealed class JoinSummary
        {
            public int EndsEnabled { get; set; }
            public int WallPairsJoined { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new Params());

            var geometry = p.geometry ?? new GeometryData
            {
                metadata = p.metadata,
                elements = p.elements
            };

            var elements = (geometry.elements ?? new List<ElementDefinition>())
                .Where(e => e != null && !string.IsNullOrWhiteSpace(e.element))
                .ToList();
            if (elements.Count == 0)
                throw new InvalidOperationException("import-zippybim-geometry requires geometry.elements.");
            var importWalls = p.importWalls ?? true;
            var importVectorUnderlay = p.importVectorUnderlay ?? false;
            if (!importWalls && !importVectorUnderlay)
                throw new InvalidOperationException("import-zippybim-geometry requires importWalls or importVectorUnderlay.");

            var cleanupSummary = new CleanupSummary();
            var normalizedWallElements = importWalls
                ? NormalizeWallElements(elements, out cleanupSummary)
                : new List<ElementDefinition>();

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active Revit document.");
            var doc = uidoc.Document;
            var dryRun = p.dryRun ?? false;
            var defaultHeight = p.defaultWallHeightFeet.GetValueOrDefault(10.0);
            if (defaultHeight <= 0) defaultHeight = 10.0;
            var minWallLength = p.minWallLengthFeet.GetValueOrDefault(0.5);
            if (minWallLength < 0) minWallLength = 0.0;

            var level = ResolveLevel(doc, uidoc.ActiveView, p.levelId, p.levelName)
                ?? throw new InvalidOperationException("Unable to resolve a target level for wall creation.");

            var wallTypes = new FilteredElementCollector(doc)
                .OfClass(typeof(WallType))
                .Cast<WallType>()
                .Where(t => t.Kind != WallKind.Curtain && t.Kind != WallKind.Stacked)
                .OrderBy(t => t.Width)
                .ToList();
            if (wallTypes.Count == 0)
                throw new InvalidOperationException("No suitable wall types were found in the active document.");

            var preferredDefault = wallTypes.FirstOrDefault(t => (t.Name ?? "").IndexOf("Generic", StringComparison.OrdinalIgnoreCase) >= 0);
            var defaultWallType = preferredDefault ?? wallTypes.First();

            var warnings = new List<string>();
            var overrideWarnings = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var typeWarnings = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var wallTypeAssignments = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var createdWalls = new List<CreatedWallInfo>();
            var createdWallRows = new List<object>();
            var createdDoorRows = new List<object>();
            var createdUnderlayRows = new List<object>();
            var skippedWalls = 0;
            var skippedDoors = 0;
            var skippedUnderlay = 0;
            if (cleanupSummary.WallsMerged > 0 || cleanupSummary.EndpointsExtended > 0 || cleanupSummary.GridSnaps > 0)
            {
                warnings.Add(
                    $"Geometry cleanup: merged {cleanupSummary.WallsMerged} wall fragments, extended {cleanupSummary.EndpointsExtended} tee endpoints, snapped {cleanupSummary.GridSnaps} coordinates to the inferred grid.");
            }

            using (var tx = new Transaction(doc, dryRun ? "Import ZippyBIM Geometry (Dry Run)" : "Import ZippyBIM Geometry"))
            {
                tx.Start();
                var wallWorksetId = importWalls ? EnsureImportWorkset(doc, ImportedWallsWorksetName, warnings) : null;
                var vectorWorksetId = importVectorUnderlay ? EnsureImportWorkset(doc, ImportedVectorsWorksetName, warnings) : null;
                var vectorLineStyle = importVectorUnderlay ? EnsureVectorLineStyle(doc, warnings) : null;

                foreach (var element in normalizedWallElements)
                {
                    if (!TryReadPath(element.path, out var start2d, out var end2d))
                    {
                        skippedWalls++;
                        continue;
                    }

                    var start = new XYZ(start2d.U, start2d.V, level.Elevation);
                    var end = new XYZ(end2d.U, end2d.V, level.Elevation);
                    var length = start.DistanceTo(end);
                    if (length < minWallLength - 1e-6)
                    {
                        skippedWalls++;
                        continue;
                    }

                    var wallType = ResolveWallTypeForThickness(
                        wallTypes,
                        defaultWallType,
                        p.wallTypeOverrides,
                        element.thickness,
                        warnings,
                        overrideWarnings,
                        typeWarnings);

                    var height = element.height.HasValue && element.height.Value > 0 ? element.height.Value : defaultHeight;
                    var wall = Wall.Create(doc, Line.CreateBound(start, end), wallType.Id, level.Id, height, 0.0, false, false);
                    TryAssignToWorkset(wall, wallWorksetId);
                    if (p.disableWallJoins ?? true)
                    {
                        TryDisableJoin(wall, 0);
                        TryDisableJoin(wall, 1);
                    }

                    createdWalls.Add(new CreatedWallInfo { Wall = wall, Start = start, End = end });
                    createdWallRows.Add(new
                    {
                        id = ElementIdCompat.GetValue(wall.Id),
                        start = new[] { start.X, start.Y, start.Z },
                        end = new[] { end.X, end.Y, end.Z },
                        wallType = wallType.Name,
                        thickness = element.thickness,
                        workset = wallWorksetId?.IntegerValue
                    });

                    if (!wallTypeAssignments.ContainsKey(wallType.Name)) wallTypeAssignments[wallType.Name] = 0;
                    wallTypeAssignments[wallType.Name]++;
                }

                if (!(p.disableWallJoins ?? false) && createdWalls.Count > 1)
                {
                    doc.Regenerate();
                    var joinSummary = TryJoinCreatedWalls(doc, createdWalls, WallJoinEndpointToleranceFeet);
                    if (joinSummary.EndsEnabled > 0 || joinSummary.WallPairsJoined > 0)
                    {
                        warnings.Add(
                            $"Wall joins: enabled {joinSummary.EndsEnabled} wall ends and joined {joinSummary.WallPairsJoined} nearby wall pairs.");
                    }
                }

                if (importVectorUnderlay)
                {
                    var underlayResult = ImportVectorUnderlay(doc, uidoc.ActiveView, level, elements, warnings, vectorLineStyle, vectorWorksetId);
                    skippedUnderlay = underlayResult.Skipped;
                    createdUnderlayRows.AddRange(underlayResult.CreatedRows);
                }

                if ((p.importDoors ?? false) && createdWalls.Count > 0)
                {
                    var doorResult = ImportDoors(doc, level, createdWalls, elements, warnings);
                    skippedDoors = doorResult.Skipped;
                    createdDoorRows.AddRange(doorResult.CreatedRows);
                }
                else if ((p.importDoors ?? false) && createdWalls.Count == 0)
                {
                    warnings.Add("Door import requested but no host walls were created.");
                }

                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = dryRun ? "Dry Run" : "Applied",
                dryRun,
                sourcePath = p.sourcePath,
                level = new { id = ElementIdCompat.GetValue(level.Id), name = level.Name, elevation = level.Elevation },
                summary = new
                {
                    wallsCreated = createdWallRows.Count,
                    wallsSkipped = skippedWalls,
                    vectorUnderlayCreated = createdUnderlayRows.Count,
                    vectorUnderlaySkipped = skippedUnderlay,
                    doorsCreated = createdDoorRows.Count,
                    doorsSkipped = skippedDoors,
                    cleanup = cleanupSummary
                },
                wallTypeAssignments,
                warnings,
                walls = createdWallRows,
                vectorUnderlay = createdUnderlayRows,
                doors = createdDoorRows
            });
        }

        private static (int Skipped, List<object> CreatedRows) ImportVectorUnderlay(
            Document doc,
            View activeView,
            Level level,
            List<ElementDefinition> elements,
            List<string> warnings,
            GraphicsStyle? lineStyle,
            WorksetId? worksetId)
        {
            var rawSegments = elements
                .Where(e => string.Equals((e.element ?? "").Trim(), "raw_segment", StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (rawSegments.Count == 0)
            {
                warnings.Add("Vector underlay skipped: no raw_segment geometry was returned by the extractor.");
                return (0, new List<object>());
            }

            var createdRows = new List<object>();
            var skipped = 0;
            var canUseDetailCurves = CanCreateDetailCurves(activeView);
            SketchPlane? sketchPlane = null;
            if (!canUseDetailCurves)
            {
                var plane = Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, level.Elevation));
                sketchPlane = SketchPlane.Create(doc, plane);
                warnings.Add($"Vector underlay used model curves because active view type '{activeView.ViewType}' does not support detail curves.");
            }

            foreach (var element in rawSegments)
            {
                if (!TryReadPath(element.path, out var start2d, out var end2d))
                {
                    skipped++;
                    continue;
                }

                var start = new XYZ(start2d.U, start2d.V, level.Elevation);
                var end = new XYZ(end2d.U, end2d.V, level.Elevation);
                if (start.DistanceTo(end) < 1e-6)
                {
                    skipped++;
                    continue;
                }

                var line = Line.CreateBound(start, end);
                Element? curveElement = null;
                if (canUseDetailCurves)
                    curveElement = doc.Create.NewDetailCurve(activeView, line);
                else if (sketchPlane != null)
                    curveElement = doc.Create.NewModelCurve(line, sketchPlane);

                if (curveElement == null)
                {
                    skipped++;
                    continue;
                }

                if (curveElement is CurveElement curve && lineStyle != null)
                {
                    try { curve.LineStyle = lineStyle; } catch { }
                }
                TryAssignToWorkset(curveElement, worksetId);
                try { curveElement.Pinned = true; } catch { }
                createdRows.Add(new
                {
                    id = ElementIdCompat.GetValue(curveElement.Id),
                    kind = canUseDetailCurves ? "detail_curve" : "model_curve",
                    start = new[] { start.X, start.Y, start.Z },
                    end = new[] { end.X, end.Y, end.Z },
                    lineStyle = lineStyle?.GraphicsStyleCategory?.Name,
                    workset = worksetId?.IntegerValue
                });
            }

            if (createdRows.Count == 0)
                warnings.Add("Vector underlay skipped: no valid raw segments could be drawn.");

            return (skipped, createdRows);
        }

        private static (int Skipped, List<object> CreatedRows) ImportDoors(
            Document doc,
            Level level,
            List<CreatedWallInfo> createdWalls,
            List<ElementDefinition> elements,
            List<string> warnings)
        {
            var doorElements = elements
                .Where(e => string.Equals((e.element ?? "").Trim(), "door", StringComparison.OrdinalIgnoreCase) && e.position != null && e.position.Count >= 2)
                .ToList();
            if (doorElements.Count == 0) return (0, new List<object>());

            var symbols = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_Doors)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .OrderBy(s => s.Family.Name)
                .ThenBy(s => s.Name)
                .ToList();
            if (symbols.Count == 0)
            {
                warnings.Add("No door family symbols were found in the active document.");
                return (doorElements.Count, new List<object>());
            }

            var createdRows = new List<object>();
            var skipped = 0;
            var activated = new HashSet<long>();

            foreach (var element in doorElements)
            {
                if (!TryReadPosition(element.position, out var position2d))
                {
                    skipped++;
                    continue;
                }

                var requestedWidth = element.width;
                var rawPoint = new XYZ(position2d.U, position2d.V, level.Elevation);
                if (!TryFindNearestWallHost(createdWalls, rawPoint, DefaultDoorHostDistanceFeet, out var hostWall, out var hostPoint))
                {
                    skipped++;
                    continue;
                }

                var symbol = ResolveDoorSymbolForWidth(symbols, requestedWidth) ?? symbols.First();
                if (!symbol.IsActive && !activated.Contains(ElementIdCompat.GetValue(symbol.Id)))
                {
                    symbol.Activate();
                    activated.Add(ElementIdCompat.GetValue(symbol.Id));
                    doc.Regenerate();
                }

                var door = doc.Create.NewFamilyInstance(hostPoint, symbol, hostWall, level, StructuralType.NonStructural);
                createdRows.Add(new
                {
                    id = ElementIdCompat.GetValue(door.Id),
                    hostWallId = ElementIdCompat.GetValue(hostWall.Id),
                    symbol = $"{symbol.Family.Name} : {symbol.Name}",
                    position = new[] { hostPoint.X, hostPoint.Y, hostPoint.Z },
                    requestedWidth
                });
            }

            return (skipped, createdRows);
        }

        private static bool TryFindNearestWallHost(
            IEnumerable<CreatedWallInfo> createdWalls,
            XYZ rawPoint,
            double maxDistanceFeet,
            out Wall hostWall,
            out XYZ hostPoint)
        {
            hostWall = null!;
            hostPoint = XYZ.Zero;
            var bestDistance = double.MaxValue;

            foreach (var info in createdWalls)
            {
                var curve = (info.Wall.Location as LocationCurve)?.Curve;
                if (curve == null) continue;

                IntersectionResult? projection = null;
                try { projection = curve.Project(rawPoint); } catch { projection = null; }
                if (projection == null) continue;

                var distance = projection.Distance;
                if (distance > maxDistanceFeet || distance >= bestDistance) continue;

                bestDistance = distance;
                hostWall = info.Wall;
                hostPoint = projection.XYZPoint;
            }

            return hostWall != null;
        }

        private static FamilySymbol? ResolveDoorSymbolForWidth(IEnumerable<FamilySymbol> symbols, double? widthFeet)
        {
            if (!widthFeet.HasValue || widthFeet.Value <= 0) return symbols.FirstOrDefault();

            FamilySymbol? best = null;
            var bestDiff = double.MaxValue;
            foreach (var symbol in symbols)
            {
                var measuredWidth = ReadDoorWidthFeet(symbol);
                if (!measuredWidth.HasValue) continue;
                var diff = Math.Abs(measuredWidth.Value - widthFeet.Value);
                if (diff < bestDiff)
                {
                    best = symbol;
                    bestDiff = diff;
                }
            }

            return best ?? symbols.FirstOrDefault();
        }

        private static double? ReadDoorWidthFeet(FamilySymbol symbol)
        {
            try
            {
                var builtIn = symbol.get_Parameter(BuiltInParameter.DOOR_WIDTH);
                if (builtIn != null && builtIn.StorageType == StorageType.Double)
                    return builtIn.AsDouble();
            }
            catch
            {
                // ignore
            }

            var widthParam = symbol.LookupParameter("Width");
            if (widthParam != null && widthParam.StorageType == StorageType.Double)
                return widthParam.AsDouble();

            return null;
        }

        private static WallType ResolveWallTypeForThickness(
            List<WallType> wallTypes,
            WallType defaultWallType,
            Dictionary<string, string>? wallTypeOverrides,
            double? thicknessFeet,
            List<string> warnings,
            HashSet<string> overrideWarnings,
            HashSet<string> typeWarnings)
        {
            if (!thicknessFeet.HasValue || thicknessFeet.Value <= 0)
                return defaultWallType;

            var requestedThickness = thicknessFeet.Value;
            var requestedInches = requestedThickness * InchesPerFoot;

            if (wallTypeOverrides != null && wallTypeOverrides.Count > 0)
            {
                foreach (var kvp in wallTypeOverrides)
                {
                    if (!double.TryParse(kvp.Key, NumberStyles.Float, CultureInfo.InvariantCulture, out var overrideInches))
                        continue;
                    if (Math.Abs(overrideInches - requestedInches) > 0.25) continue;

                    var overrideType = wallTypes.FirstOrDefault(t =>
                        string.Equals(t.Name, kvp.Value, StringComparison.OrdinalIgnoreCase) ||
                        (t.Name ?? "").IndexOf(kvp.Value ?? "", StringComparison.OrdinalIgnoreCase) >= 0);
                    if (overrideType != null) return overrideType;

                    var warnKey = $"override:{kvp.Key}:{kvp.Value}";
                    if (overrideWarnings.Add(warnKey))
                        warnings.Add($"Configured wall type override '{kvp.Value}' was not found for {requestedInches:0.###}\" walls.");
                }
            }

            var closest = wallTypes
                .OrderBy(t => Math.Abs(t.Width - requestedThickness))
                .FirstOrDefault() ?? defaultWallType;

            var diff = Math.Abs(closest.Width - requestedThickness);
            if (diff > WallTypeToleranceFeet)
            {
                var warnKey = requestedInches.ToString("0.###", CultureInfo.InvariantCulture);
                if (typeWarnings.Add(warnKey))
                {
                    warnings.Add(
                        $"No wall type matched {requestedInches:0.###}\" within 1/4\". Using '{closest.Name}' ({closest.Width * InchesPerFoot:0.###}\").");
                }
            }

            return closest;
        }

        private static Level? ResolveLevel(Document doc, View activeView, long? levelId, string? levelName)
        {
            if (levelId.HasValue && levelId.Value > 0)
            {
                var explicitLevel = doc.GetElement(ElementIdCompat.Create(levelId.Value)) as Level;
                if (explicitLevel != null) return explicitLevel;
            }

            if (!string.IsNullOrWhiteSpace(levelName))
            {
                var byName = new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .FirstOrDefault(l => string.Equals(l.Name, levelName.Trim(), StringComparison.OrdinalIgnoreCase));
                if (byName != null) return byName;
            }

            if (activeView is ViewPlan plan && plan.GenLevel != null)
                return plan.GenLevel;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .OrderBy(l => l.Elevation)
                .FirstOrDefault();
        }

        private static bool TryReadPath(List<List<double>>? path, out UV start, out UV end)
        {
            start = new UV(0, 0);
            end = new UV(0, 0);
            if (path == null || path.Count != 2) return false;
            if (path[0] == null || path[1] == null || path[0].Count < 2 || path[1].Count < 2) return false;

            var x1 = path[0][0];
            var y1 = path[0][1];
            var x2 = path[1][0];
            var y2 = path[1][1];
            if (!new[] { x1, y1, x2, y2 }.All(IsFinite)) return false;

            start = new UV(x1, y1);
            end = new UV(x2, y2);
            return true;
        }

        private static bool TryReadPosition(List<double>? position, out UV point)
        {
            point = new UV(0, 0);
            if (position == null || position.Count < 2) return false;
            var x = position[0];
            var y = position[1];
            if (!IsFinite(x) || !IsFinite(y)) return false;
            point = new UV(x, y);
            return true;
        }

        private static void TryDisableJoin(Wall wall, int endIndex)
        {
            try { WallUtils.DisallowWallJoinAtEnd(wall, endIndex); } catch { }
        }

        private static WorksetId? EnsureImportWorkset(Document doc, string name, List<string> warnings)
        {
            if (!doc.IsWorkshared) return null;
            try
            {
                var existing = new FilteredWorksetCollector(doc)
                    .OfKind(WorksetKind.UserWorkset)
                    .ToWorksets()
                    .FirstOrDefault(x => x != null && string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
                if (existing != null) return existing.Id;

                var created = Workset.Create(doc, name);
                return created?.Id;
            }
            catch (Exception ex)
            {
                warnings.Add($"Imported elements could not be isolated on workset '{name}': {ex.Message}");
                return null;
            }
        }

        private static GraphicsStyle? EnsureVectorLineStyle(Document doc, List<string> warnings)
        {
            try
            {
                var existing = ResolveLineStyle(doc, VectorUnderlayLineStyleName);
                if (existing != null) return existing;

                var linesCat = doc.Settings.Categories.get_Item(BuiltInCategory.OST_Lines);
                if (linesCat == null) return null;

                var subCategory = doc.Settings.Categories.NewSubcategory(linesCat, VectorUnderlayLineStyleName);
                subCategory.SetLineWeight(2, GraphicsStyleType.Projection);
                subCategory.LineColor = new Color(150, 75, 36);
                return subCategory.GetGraphicsStyle(GraphicsStyleType.Projection);
            }
            catch (Exception ex)
            {
                warnings.Add($"Vector underlay line style '{VectorUnderlayLineStyleName}' could not be created: {ex.Message}");
                return null;
            }
        }

        private static GraphicsStyle? ResolveLineStyle(Document doc, string lineStyleName)
        {
            if (string.IsNullOrWhiteSpace(lineStyleName)) return null;
            try
            {
                var linesCat = doc.Settings.Categories.get_Item(BuiltInCategory.OST_Lines);
                if (linesCat == null) return null;
                foreach (Category sub in linesCat.SubCategories)
                {
                    if (sub == null) continue;
                    if (!string.Equals(sub.Name, lineStyleName, StringComparison.OrdinalIgnoreCase)) continue;
                    return sub.GetGraphicsStyle(GraphicsStyleType.Projection);
                }
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private static void TryAssignToWorkset(Element element, WorksetId? worksetId)
        {
            if (element == null || worksetId == null) return;
            try
            {
                var parameter = element.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM);
                if (parameter != null && !parameter.IsReadOnly)
                    parameter.Set(worksetId.IntegerValue);
            }
            catch
            {
                // ignore non-worksettable elements
            }
        }

        private static void TryEnableJoin(Wall wall, int endIndex)
        {
            try { WallUtils.AllowWallJoinAtEnd(wall, endIndex); } catch { }
        }

        private static JoinSummary TryJoinCreatedWalls(Document doc, List<CreatedWallInfo> createdWalls, double endpointToleranceFeet)
        {
            var summary = new JoinSummary();
            foreach (var info in createdWalls)
            {
                TryEnableJoin(info.Wall, 0);
                TryEnableJoin(info.Wall, 1);
                summary.EndsEnabled += 2;
            }

            for (var i = 0; i < createdWalls.Count; i++)
            {
                var wallA = createdWalls[i].Wall;
                var curveA = (wallA.Location as LocationCurve)?.Curve;
                if (curveA == null) continue;

                for (var j = i + 1; j < createdWalls.Count; j++)
                {
                    var wallB = createdWalls[j].Wall;
                    var curveB = (wallB.Location as LocationCurve)?.Curve;
                    if (curveB == null) continue;
                    if (JoinGeometryUtils.AreElementsJoined(doc, wallA, wallB)) continue;
                    if (!ShouldJoinWalls(curveA, curveB, endpointToleranceFeet)) continue;

                    try
                    {
                        JoinGeometryUtils.JoinGeometry(doc, wallA, wallB);
                        if (JoinGeometryUtils.AreElementsJoined(doc, wallA, wallB))
                            summary.WallPairsJoined++;
                    }
                    catch
                    {
                        // ignore walls Revit refuses to join
                    }
                }
            }

            return summary;
        }

        private static bool ShouldJoinWalls(Curve curveA, Curve curveB, double endpointToleranceFeet)
        {
            var endpointsA = new[] { curveA.GetEndPoint(0), curveA.GetEndPoint(1) };
            var endpointsB = new[] { curveB.GetEndPoint(0), curveB.GetEndPoint(1) };

            foreach (var point in endpointsA)
            {
                if (DistanceToCurve(curveB, point) <= endpointToleranceFeet) return true;
            }

            foreach (var point in endpointsB)
            {
                if (DistanceToCurve(curveA, point) <= endpointToleranceFeet) return true;
            }

            return false;
        }

        private static double DistanceToCurve(Curve curve, XYZ point)
        {
            try
            {
                var projection = curve.Project(point);
                if (projection != null) return projection.Distance;
            }
            catch
            {
                // ignore
            }

            return double.MaxValue;
        }

        private static bool CanCreateDetailCurves(View view)
        {
            if (view == null || view.IsTemplate) return false;
            return view.ViewType != ViewType.ThreeD &&
                   view.ViewType != ViewType.Schedule &&
                   view.ViewType != ViewType.DrawingSheet &&
                   view.ViewType != ViewType.ProjectBrowser &&
                   view.ViewType != ViewType.SystemBrowser &&
                   view.ViewType != ViewType.Internal;
        }

        private static bool IsFinite(double value)
        {
            return !(double.IsNaN(value) || double.IsInfinity(value));
        }

        private static List<ElementDefinition> NormalizeWallElements(List<ElementDefinition> elements, out CleanupSummary summary)
        {
            var wallSegments = new List<PreparedWallSegment>();
            foreach (var element in elements.Where(e => string.Equals((e.element ?? "").Trim(), "wall", StringComparison.OrdinalIgnoreCase)))
            {
                if (!TryReadPath(element.path, out var start, out var end)) continue;
                var dx = end.U - start.U;
                var dy = end.V - start.V;
                if (Math.Abs(dx) < 1e-6 && Math.Abs(dy) < 1e-6) continue;

                var isVertical = Math.Abs(dy) > Math.Abs(dx);
                var segment = new PreparedWallSegment
                {
                    Id = (element.id ?? "").Trim(),
                    IsVertical = isVertical,
                    Thickness = element.thickness,
                    Height = element.height
                };

                if (isVertical)
                {
                    segment.ConstCoord = (start.U + end.U) * 0.5;
                    segment.StartCoord = Math.Min(start.V, end.V);
                    segment.EndCoord = Math.Max(start.V, end.V);
                }
                else
                {
                    segment.ConstCoord = (start.V + end.V) * 0.5;
                    segment.StartCoord = Math.Min(start.U, end.U);
                    segment.EndCoord = Math.Max(start.U, end.U);
                }

                if (segment.EndCoord - segment.StartCoord < 1e-6) continue;
                wallSegments.Add(segment);
            }

            var snaps = SnapSegmentsToGrid(wallSegments, GridSnapToleranceFeet);
            var mergedBefore = wallSegments.Count;
            var merged = MergeCollinearSegments(wallSegments, MergeGapToleranceFeet);
            var wallsMerged = Math.Max(0, mergedBefore - merged.Count);
            var endpointExtensions = ExtendCorners(merged, CornerExtendToleranceFeet);
            var finalSegments = MergeCollinearSegments(merged, MergeGapToleranceFeet);

            summary = new CleanupSummary
            {
                InputWallCount = wallSegments.Count,
                OutputWallCount = finalSegments.Count,
                WallsMerged = wallsMerged,
                EndpointsExtended = endpointExtensions,
                GridSnaps = snaps
            };

            return finalSegments.Select((segment, index) => new ElementDefinition
            {
                id = string.IsNullOrWhiteSpace(segment.Id) ? $"wall_clean_{index + 1}" : segment.Id,
                element = "wall",
                thickness = segment.Thickness,
                height = segment.Height,
                path = new List<List<double>>
                {
                    new List<double> { segment.StartPoint().U, segment.StartPoint().V },
                    new List<double> { segment.EndPoint().U, segment.EndPoint().V }
                }
            }).ToList();
        }

        private static int SnapSegmentsToGrid(List<PreparedWallSegment> segments, double toleranceFeet)
        {
            var xClusters = BuildClusterCenters(segments.Where(s => s.IsVertical).Select(s => s.ConstCoord).ToList(), toleranceFeet);
            var yClusters = BuildClusterCenters(segments.Where(s => !s.IsVertical).Select(s => s.ConstCoord).ToList(), toleranceFeet);
            var snaps = 0;

            foreach (var segment in segments)
            {
                if (segment.IsVertical)
                {
                    var snapped = SnapToNearest(segment.ConstCoord, xClusters, toleranceFeet);
                    if (Math.Abs(snapped - segment.ConstCoord) > 1e-6) snaps++;
                    segment.ConstCoord = snapped;
                }
                else
                {
                    var snapped = SnapToNearest(segment.ConstCoord, yClusters, toleranceFeet);
                    if (Math.Abs(snapped - segment.ConstCoord) > 1e-6) snaps++;
                    segment.ConstCoord = snapped;
                }
            }

            return snaps;
        }

        private static List<double> BuildClusterCenters(List<double> values, double toleranceFeet)
        {
            var sorted = values.Where(IsFinite).OrderBy(v => v).ToList();
            var centers = new List<double>();
            if (sorted.Count == 0) return centers;

            var cluster = new List<double> { sorted[0] };
            for (var i = 1; i < sorted.Count; i++)
            {
                if (Math.Abs(sorted[i] - cluster[cluster.Count - 1]) <= toleranceFeet)
                {
                    cluster.Add(sorted[i]);
                    continue;
                }

                centers.Add(cluster.Average());
                cluster = new List<double> { sorted[i] };
            }

            centers.Add(cluster.Average());
            return centers;
        }

        private static double SnapToNearest(double value, List<double> centers, double toleranceFeet)
        {
            if (centers.Count == 0) return value;
            var nearest = value;
            var best = double.MaxValue;
            foreach (var center in centers)
            {
                var diff = Math.Abs(center - value);
                if (diff >= best) continue;
                best = diff;
                nearest = center;
            }

            return best <= toleranceFeet ? nearest : value;
        }

        private static List<PreparedWallSegment> MergeCollinearSegments(List<PreparedWallSegment> segments, double gapToleranceFeet)
        {
            var result = new List<PreparedWallSegment>();
            foreach (var group in segments
                .GroupBy(s => new
                {
                    s.IsVertical,
                    ConstKey = Math.Round(s.ConstCoord, 4),
                    ThicknessKey = Math.Round((s.Thickness ?? 0.0) * 12.0, 3),
                    HeightKey = Math.Round(s.Height ?? 0.0, 3)
                }))
            {
                var ordered = group
                    .Select(s => s.Clone())
                    .OrderBy(s => s.StartCoord)
                    .ThenBy(s => s.EndCoord)
                    .ToList();
                if (ordered.Count == 0) continue;

                var current = ordered[0];
                for (var i = 1; i < ordered.Count; i++)
                {
                    var next = ordered[i];
                    if (next.StartCoord - current.EndCoord <= gapToleranceFeet)
                    {
                        current.EndCoord = Math.Max(current.EndCoord, next.EndCoord);
                        if (string.IsNullOrWhiteSpace(current.Id)) current.Id = next.Id;
                        continue;
                    }

                    result.Add(current);
                    current = next;
                }

                result.Add(current);
            }

            return result;
        }

        private static int ExtendCorners(List<PreparedWallSegment> segments, double toleranceFeet)
        {
            var extensions = 0;
            for (var i = 0; i < segments.Count; i++)
            {
                var segment = segments[i];
                for (var endpointIndex = 0; endpointIndex < 2; endpointIndex++)
                {
                    var axis = endpointIndex == 0 ? segment.StartCoord : segment.EndCoord;
                    var bestDistance = toleranceFeet;
                    double? snappedAxis = null;

                    foreach (var candidate in segments)
                    {
                        if (ReferenceEquals(candidate, segment) || candidate.IsVertical == segment.IsVertical) continue;
                        if (candidate.StartCoord - toleranceFeet > segment.ConstCoord || candidate.EndCoord + toleranceFeet < segment.ConstCoord) continue;

                        var distance = Math.Abs(candidate.ConstCoord - axis);
                        if (distance > bestDistance) continue;
                        bestDistance = distance;
                        snappedAxis = candidate.ConstCoord;
                    }

                    if (!snappedAxis.HasValue) continue;
                    if (endpointIndex == 0) segment.StartCoord = snappedAxis.Value;
                    else segment.EndCoord = snappedAxis.Value;
                    extensions++;
                }

                if (segment.EndCoord < segment.StartCoord)
                {
                    var tmp = segment.StartCoord;
                    segment.StartCoord = segment.EndCoord;
                    segment.EndCoord = tmp;
                }
            }

            return extensions;
        }
    }
}
