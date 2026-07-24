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
        private const double StrictLevelElevationToleranceFeet = 1.0 / (16.0 * InchesPerFoot);
        private const double StrictOpeningChainageToleranceFeet = 1.0 / (8.0 * InchesPerFoot);
        private const double StrictOpeningDimensionToleranceFeet = 1.0 / (16.0 * InchesPerFoot);
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
            public string? typeName { get; set; }
            public string? familyName { get; set; }
            public string? hostWallId { get; set; }
            public double? sillHeight { get; set; }
            public double? chainageFt { get; set; }
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
            public bool? importWindows { get; set; }
            public bool? normalizeWallGeometry { get; set; }
            public bool? requireExactWallTypes { get; set; }
            public bool? requireExactOpeningTypes { get; set; }
            public bool? requireSourceWallHosts { get; set; }
            public bool? requireAllElements { get; set; }
            public int? maximumCreatedElements { get; set; }
            public double? maximumOpeningHostDistanceFeet { get; set; }
            public double? levelElevationFt { get; set; }
            public bool? dryRun { get; set; }
            public Dictionary<string, string>? wallTypeOverrides { get; set; }
        }

        private sealed class CreatedWallInfo
        {
            public Wall Wall { get; set; } = null!;
            public XYZ Start { get; set; } = XYZ.Zero;
            public XYZ End { get; set; } = XYZ.Zero;
            public string SourceObservationId { get; set; } = "";
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
            var importDoors = p.importDoors ?? false;
            var importWindows = p.importWindows ?? false;
            var requireAllElements = p.requireAllElements ?? false;
            var maximumCreatedElements = p.maximumCreatedElements.GetValueOrDefault(10000);
            if (maximumCreatedElements <= 0)
                throw new InvalidOperationException("maximumCreatedElements must be a positive integer.");
            if (!importWalls && !importVectorUnderlay)
                throw new InvalidOperationException("import-zippybim-geometry requires importWalls or importVectorUnderlay.");

            var requestedModelElements = elements.Count(e =>
                (importWalls && IsElementKind(e, "wall")) ||
                (importDoors && IsElementKind(e, "door")) ||
                (importWindows && IsElementKind(e, "window")) ||
                (importVectorUnderlay && IsElementKind(e, "raw_segment")));
            if (requestedModelElements > maximumCreatedElements)
                throw new InvalidOperationException($"Requested {requestedModelElements} created elements exceeds maximumCreatedElements {maximumCreatedElements}.");

            var cleanupSummary = new CleanupSummary();
            var normalizedWallElements = importWalls
                ? ((p.normalizeWallGeometry ?? true)
                    ? NormalizeWallElements(elements, out cleanupSummary)
                    : PreserveWallElements(elements, out cleanupSummary))
                : new List<ElementDefinition>();
            if (p.requireSourceWallHosts ?? false)
            {
                var sourceWallIds = normalizedWallElements.Select(e => (e.id ?? "").Trim()).ToList();
                if (sourceWallIds.Any(string.IsNullOrWhiteSpace))
                    throw new InvalidOperationException("requireSourceWallHosts requires a non-empty id on every wall.");
                if (sourceWallIds.Distinct(StringComparer.OrdinalIgnoreCase).Count() != sourceWallIds.Count)
                    throw new InvalidOperationException("requireSourceWallHosts requires unique wall ids.");
            }

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active Revit document.");
            var doc = uidoc.Document;
            var dryRun = p.dryRun ?? false;
            var defaultHeight = p.defaultWallHeightFeet.GetValueOrDefault(10.0);
            if (defaultHeight <= 0) defaultHeight = 10.0;
            var minWallLength = p.minWallLengthFeet.GetValueOrDefault(0.5);
            if (minWallLength < 0) minWallLength = 0.0;

            var level = ResolveLevel(doc, uidoc.ActiveView, p.levelId, p.levelName)
                ?? throw new InvalidOperationException("Unable to resolve a target level for wall creation.");
            if (p.levelElevationFt.HasValue && Math.Abs(level.Elevation - p.levelElevationFt.Value) > StrictLevelElevationToleranceFeet)
                throw new InvalidOperationException(
                    $"Resolved level '{level.Name}' elevation {level.Elevation:0.######} ft does not match requested levelElevationFt {p.levelElevationFt.Value:0.######} ft.");

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
            var createdWindowRows = new List<object>();
            var createdUnderlayRows = new List<object>();
            var skippedWalls = 0;
            var skippedDoors = 0;
            var skippedWindows = 0;
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

                    var wallType = (p.requireExactWallTypes ?? false)
                        ? ResolveExactWallType(wallTypes, element)
                        : ResolveWallTypeForThickness(
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

                    createdWalls.Add(new CreatedWallInfo
                    {
                        Wall = wall,
                        Start = start,
                        End = end,
                        SourceObservationId = (element.id ?? "").Trim()
                    });
                    createdWallRows.Add(new
                    {
                        id = ElementIdCompat.GetValue(wall.Id),
                        sourceObservationId = (element.id ?? "").Trim(),
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

                if (importDoors && createdWalls.Count > 0)
                {
                    var doorResult = ImportOpenings(
                        doc, level, createdWalls, elements, warnings, "door", BuiltInCategory.OST_Doors,
                        p.requireExactOpeningTypes ?? false,
                        p.requireSourceWallHosts ?? false,
                        p.maximumOpeningHostDistanceFeet.GetValueOrDefault(
                            (p.requireSourceWallHosts ?? false) ? 0.5 : DefaultDoorHostDistanceFeet));
                    skippedDoors = doorResult.Skipped;
                    createdDoorRows.AddRange(doorResult.CreatedRows);
                }
                else if (importDoors && createdWalls.Count == 0)
                {
                    if (requireAllElements) throw new InvalidOperationException("Door import requested but no host walls were created.");
                    warnings.Add("Door import requested but no host walls were created.");
                }

                if (importWindows && createdWalls.Count > 0)
                {
                    var windowResult = ImportOpenings(
                        doc, level, createdWalls, elements, warnings, "window", BuiltInCategory.OST_Windows,
                        p.requireExactOpeningTypes ?? false,
                        p.requireSourceWallHosts ?? false,
                        p.maximumOpeningHostDistanceFeet.GetValueOrDefault(
                            (p.requireSourceWallHosts ?? false) ? 0.5 : DefaultDoorHostDistanceFeet));
                    skippedWindows = windowResult.Skipped;
                    createdWindowRows.AddRange(windowResult.CreatedRows);
                }
                else if (importWindows && createdWalls.Count == 0)
                {
                    if (requireAllElements) throw new InvalidOperationException("Window import requested but no host walls were created.");
                    warnings.Add("Window import requested but no host walls were created.");
                }

                var totalCreated = createdWallRows.Count + createdDoorRows.Count + createdWindowRows.Count + createdUnderlayRows.Count;
                if (totalCreated > maximumCreatedElements)
                    throw new InvalidOperationException($"Created {totalCreated} elements exceeds maximumCreatedElements {maximumCreatedElements}.");
                if (requireAllElements &&
                    (skippedWalls > 0 || skippedDoors > 0 || skippedWindows > 0 || skippedUnderlay > 0 || totalCreated != requestedModelElements))
                {
                    throw new InvalidOperationException(
                        $"requireAllElements failed: requested={requestedModelElements}, created={totalCreated}, skippedWalls={skippedWalls}, skippedDoors={skippedDoors}, skippedWindows={skippedWindows}, skippedUnderlay={skippedUnderlay}.");
                }

                if (dryRun)
                {
                    tx.RollBack();
                }
                else
                {
                    var commitStatus = tx.Commit();
                    if (commitStatus != TransactionStatus.Committed)
                        throw new InvalidOperationException(
                            $"Geometry import transaction did not commit (status: {commitStatus}). No applied receipt was emitted.");
                }
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
                    windowsCreated = createdWindowRows.Count,
                    windowsSkipped = skippedWindows,
                    cleanup = cleanupSummary
                },
                wallTypeAssignments,
                warnings,
                walls = createdWallRows,
                vectorUnderlay = createdUnderlayRows,
                doors = createdDoorRows,
                windows = createdWindowRows
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

        private static (int Skipped, List<object> CreatedRows) ImportOpenings(
            Document doc,
            Level level,
            List<CreatedWallInfo> createdWalls,
            List<ElementDefinition> elements,
            List<string> warnings,
            string openingKind,
            BuiltInCategory category,
            bool requireExactType,
            bool requireSourceWallHost,
            double maximumHostDistanceFeet)
        {
            var openingElements = elements
                .Where(e => IsElementKind(e, openingKind) && e.position != null && e.position.Count >= 2)
                .ToList();
            if (openingElements.Count == 0) return (0, new List<object>());

            var symbols = new FilteredElementCollector(doc)
                .OfCategory(category)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .OrderBy(s => s.Family.Name)
                .ThenBy(s => s.Name)
                .ToList();
            if (symbols.Count == 0)
            {
                var message = $"No {openingKind} family symbols were found in the active document.";
                if (requireExactType) throw new InvalidOperationException(message);
                warnings.Add(message);
                return (openingElements.Count, new List<object>());
            }

            var createdRows = new List<object>();
            var skipped = 0;
            var activated = new HashSet<long>();

            foreach (var element in openingElements)
            {
                if (!TryReadPosition(element.position, out var position2d))
                {
                    if (requireExactType || requireSourceWallHost)
                        throw new InvalidOperationException($"{openingKind} '{element.id}' has an invalid position.");
                    skipped++;
                    continue;
                }

                var requestedWidth = element.width;
                var rawPoint = new XYZ(position2d.U, position2d.V, level.Elevation);
                Wall hostWall;
                XYZ hostPoint;
                double chainageFeet;
                if (requireSourceWallHost)
                {
                    var sourceHostId = (element.hostWallId ?? "").Trim();
                    if (string.IsNullOrWhiteSpace(sourceHostId))
                        throw new InvalidOperationException($"{openingKind} '{element.id}' requires hostWallId.");
                    var sourceHost = createdWalls.SingleOrDefault(info =>
                        string.Equals(info.SourceObservationId, sourceHostId, StringComparison.OrdinalIgnoreCase));
                    if (sourceHost == null)
                        throw new InvalidOperationException($"{openingKind} '{element.id}' references unknown created source wall '{sourceHostId}'.");
                    if (!TryProjectToWallHost(sourceHost, rawPoint, maximumHostDistanceFeet, out hostWall, out hostPoint, out chainageFeet))
                        throw new InvalidOperationException($"{openingKind} '{element.id}' is not on source wall '{sourceHostId}' within {maximumHostDistanceFeet:0.###} ft.");
                }
                else if (!TryFindNearestWallHost(createdWalls, rawPoint, maximumHostDistanceFeet, out hostWall, out hostPoint, out chainageFeet))
                {
                    skipped++;
                    continue;
                }

                var hostCurve = (hostWall.Location as LocationCurve)?.Curve
                    ?? throw new InvalidOperationException($"Host wall for {openingKind} '{element.id}' has no location curve.");
                var hostLength = hostCurve.Length;
                if (requestedWidth.HasValue && requestedWidth.Value > 0 &&
                    (chainageFeet < requestedWidth.Value / 2.0 - 1e-6 || chainageFeet > hostLength - requestedWidth.Value / 2.0 + 1e-6))
                {
                    if (requireSourceWallHost)
                        throw new InvalidOperationException($"{openingKind} '{element.id}' does not fit within source wall '{element.hostWallId}'.");
                    skipped++;
                    continue;
                }
                if (requireSourceWallHost && element.chainageFt.HasValue &&
                    Math.Abs(chainageFeet - element.chainageFt.Value) > StrictOpeningChainageToleranceFeet)
                {
                    throw new InvalidOperationException(
                        $"{openingKind} '{element.id}' chainage {chainageFeet:0.######} ft does not match requested chainageFt {element.chainageFt.Value:0.######} ft.");
                }

                var symbol = requireExactType
                    ? ResolveExactOpeningSymbol(symbols, element, openingKind)
                    : (ResolveDoorSymbolForWidth(symbols, requestedWidth) ?? symbols.First());
                if (!symbol.IsActive && !activated.Contains(ElementIdCompat.GetValue(symbol.Id)))
                {
                    symbol.Activate();
                    activated.Add(ElementIdCompat.GetValue(symbol.Id));
                    doc.Regenerate();
                }

                var instance = doc.Create.NewFamilyInstance(hostPoint, symbol, hostWall, level, StructuralType.NonStructural);
                double? actualWidthFeet = null;
                double? actualHeightFeet = null;
                if (requireExactType)
                {
                    actualWidthFeet = EnsureExactOpeningInstanceDimension(
                        instance, element.width, "Width", openingKind, element.id, warnings);
                    actualHeightFeet = EnsureExactOpeningInstanceDimension(
                        instance, element.height, "Height", openingKind, element.id, warnings);
                }
                if (string.Equals(openingKind, "window", StringComparison.OrdinalIgnoreCase) && element.sillHeight.HasValue)
                {
                    var sill = instance.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM);
                    if (sill == null || sill.IsReadOnly || !sill.Set(element.sillHeight.Value))
                        throw new InvalidOperationException($"Window '{element.id}' sill height could not be set to {element.sillHeight.Value:0.###} ft.");
                }
                if (requireSourceWallHost && (instance.Host == null || instance.Host.Id != hostWall.Id))
                    throw new InvalidOperationException($"{openingKind} '{element.id}' was not created on the required source wall.");
                if (requireExactType && instance.Symbol.Id != symbol.Id)
                    throw new InvalidOperationException($"{openingKind} '{element.id}' was not created with the required exact symbol.");
                createdRows.Add(new
                {
                    id = ElementIdCompat.GetValue(instance.Id),
                    sourceObservationId = (element.id ?? "").Trim(),
                    kind = openingKind,
                    hostWallId = ElementIdCompat.GetValue(hostWall.Id),
                    sourceHostWallId = (element.hostWallId ?? "").Trim(),
                    symbol = $"{symbol.Family.Name} : {symbol.Name}",
                    position = new[] { hostPoint.X, hostPoint.Y, hostPoint.Z },
                    requestedWidth,
                    actualWidthFeet,
                    actualHeightFeet,
                    chainageFt = chainageFeet,
                    sillHeightFt = string.Equals(openingKind, "window", StringComparison.OrdinalIgnoreCase) ? element.sillHeight : null
                });
            }

            return (skipped, createdRows);
        }

        private static bool TryFindNearestWallHost(
            IEnumerable<CreatedWallInfo> createdWalls,
            XYZ rawPoint,
            double maxDistanceFeet,
            out Wall hostWall,
            out XYZ hostPoint,
            out double chainageFeet)
        {
            hostWall = null!;
            hostPoint = XYZ.Zero;
            chainageFeet = 0.0;
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
                chainageFeet = curve.GetEndPoint(0).DistanceTo(hostPoint);
            }

            return hostWall != null;
        }

        private static bool TryProjectToWallHost(
            CreatedWallInfo info,
            XYZ rawPoint,
            double maxDistanceFeet,
            out Wall hostWall,
            out XYZ hostPoint,
            out double chainageFeet)
        {
            hostWall = info.Wall;
            hostPoint = XYZ.Zero;
            chainageFeet = 0.0;
            var curve = (info.Wall.Location as LocationCurve)?.Curve;
            if (curve == null) return false;
            IntersectionResult? projection = null;
            try { projection = curve.Project(rawPoint); } catch { projection = null; }
            if (projection == null || projection.Distance > maxDistanceFeet) return false;
            hostPoint = projection.XYZPoint;
            chainageFeet = curve.GetEndPoint(0).DistanceTo(hostPoint);
            return true;
        }

        private static FamilySymbol ResolveExactOpeningSymbol(
            IEnumerable<FamilySymbol> symbols,
            ElementDefinition element,
            string openingKind)
        {
            var familyName = (element.familyName ?? "").Trim();
            var typeName = (element.typeName ?? "").Trim();
            if (string.IsNullOrWhiteSpace(familyName) || string.IsNullOrWhiteSpace(typeName))
                throw new InvalidOperationException($"{openingKind} '{element.id}' requires exact familyName and typeName.");
            var symbol = symbols.FirstOrDefault(candidate =>
                string.Equals(candidate.Family.Name, familyName, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(candidate.Name, typeName, StringComparison.OrdinalIgnoreCase));
            if (symbol == null)
                throw new InvalidOperationException($"Exact {openingKind} type '{familyName} : {typeName}' was not found.");
            ValidateExactOpeningTypeDimension(symbol, element.width, "Width", openingKind, element.id);
            ValidateExactOpeningTypeDimension(symbol, element.height, "Height", openingKind, element.id);
            return symbol;
        }

        private static void ValidateExactOpeningTypeDimension(
            FamilySymbol symbol,
            double? requestedFeet,
            string parameterName,
            string openingKind,
            string? sourceId)
        {
            if (!requestedFeet.HasValue || requestedFeet.Value <= 0)
                throw new InvalidOperationException($"{openingKind} '{sourceId}' requires a positive {parameterName.ToLowerInvariant()}.");
            BuiltInParameter builtIn;
            if (string.Equals(openingKind, "window", StringComparison.OrdinalIgnoreCase))
                builtIn = string.Equals(parameterName, "Width", StringComparison.OrdinalIgnoreCase)
                    ? BuiltInParameter.WINDOW_WIDTH
                    : BuiltInParameter.WINDOW_HEIGHT;
            else
                builtIn = string.Equals(parameterName, "Width", StringComparison.OrdinalIgnoreCase)
                    ? BuiltInParameter.DOOR_WIDTH
                    : BuiltInParameter.DOOR_HEIGHT;
            var parameter = symbol.get_Parameter(builtIn) ?? symbol.LookupParameter(parameterName);
            if (parameter == null || parameter.StorageType != StorageType.Double) return;
            var actualFeet = parameter.AsDouble();
            // Some hosted opening families expose zero-valued type parameters and
            // drive their real dimensions from writable instance parameters. Those
            // are validated and set immediately after instance creation below.
            if (actualFeet <= StrictOpeningDimensionToleranceFeet) return;
            if (Math.Abs(actualFeet - requestedFeet.Value) > StrictOpeningDimensionToleranceFeet)
                throw new InvalidOperationException(
                    $"Exact {openingKind} type '{symbol.Family.Name} : {symbol.Name}' {parameterName.ToLowerInvariant()} {actualFeet:0.######} ft does not match requested {requestedFeet.Value:0.######} ft.");
        }

        private static double EnsureExactOpeningInstanceDimension(
            FamilyInstance instance,
            double? requestedFeet,
            string parameterName,
            string openingKind,
            string? sourceId,
            List<string> warnings)
        {
            if (!requestedFeet.HasValue || requestedFeet.Value <= 0)
                throw new InvalidOperationException($"{openingKind} '{sourceId}' requires a positive {parameterName.ToLowerInvariant()}.");

            BuiltInParameter builtIn;
            if (string.Equals(openingKind, "window", StringComparison.OrdinalIgnoreCase))
                builtIn = string.Equals(parameterName, "Width", StringComparison.OrdinalIgnoreCase)
                    ? BuiltInParameter.WINDOW_WIDTH
                    : BuiltInParameter.WINDOW_HEIGHT;
            else
                builtIn = string.Equals(parameterName, "Width", StringComparison.OrdinalIgnoreCase)
                    ? BuiltInParameter.DOOR_WIDTH
                    : BuiltInParameter.DOOR_HEIGHT;

            var candidates = new[]
            {
                instance.get_Parameter(builtIn),
                instance.LookupParameter(parameterName)
            }
            .Where(parameter => parameter != null && parameter.StorageType == StorageType.Double)
            .Cast<Parameter>()
            .ToList();
            if (candidates.Count == 0)
                throw new InvalidOperationException(
                    $"Exact {openingKind} instance '{sourceId}' has no readable {parameterName} parameter.");

            var matching = candidates.FirstOrDefault(parameter =>
                Math.Abs(parameter.AsDouble() - requestedFeet.Value) <= StrictOpeningDimensionToleranceFeet);
            if (matching != null) return matching.AsDouble();

            var writable = candidates.FirstOrDefault(parameter => !parameter.IsReadOnly);
            if (writable == null)
            {
                var actualFeet = candidates[0].AsDouble();
                if (candidates.All(parameter => Math.Abs(parameter.AsDouble()) <= StrictOpeningDimensionToleranceFeet))
                {
                    warnings.Add(
                        $"Exact {openingKind} type '{instance.Symbol.Family.Name} : {instance.Symbol.Name}' exposes no non-zero or writable {parameterName} parameter; accepted the exact requested family/type and could not independently measure its numeric {parameterName.ToLowerInvariant()}.");
                    return requestedFeet.Value;
                }
                throw new InvalidOperationException(
                    $"Exact {openingKind} instance '{sourceId}' {parameterName.ToLowerInvariant()} {actualFeet:0.######} ft does not match requested {requestedFeet.Value:0.######} ft and cannot be set.");
            }
            if (!writable.Set(requestedFeet.Value))
            {
                if (candidates.All(parameter => Math.Abs(parameter.AsDouble()) <= StrictOpeningDimensionToleranceFeet))
                {
                    warnings.Add(
                        $"Exact {openingKind} type '{instance.Symbol.Family.Name} : {instance.Symbol.Name}' exposes only zero-valued {parameterName} parameters and rejected an instance set; accepted the exact requested family/type and could not independently measure its numeric {parameterName.ToLowerInvariant()}.");
                    return requestedFeet.Value;
                }
                throw new InvalidOperationException(
                    $"Exact {openingKind} instance '{sourceId}' {parameterName.ToLowerInvariant()} could not be set to requested {requestedFeet.Value:0.######} ft.");
            }

            instance.Document.Regenerate();
            var appliedFeet = writable.AsDouble();
            if (Math.Abs(appliedFeet - requestedFeet.Value) > StrictOpeningDimensionToleranceFeet)
                throw new InvalidOperationException(
                    $"Exact {openingKind} instance '{sourceId}' {parameterName.ToLowerInvariant()} {appliedFeet:0.######} ft does not match requested {requestedFeet.Value:0.######} ft after setting.");
            return appliedFeet;
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

        private static WallType ResolveExactWallType(List<WallType> wallTypes, ElementDefinition element)
        {
            var requestedName = (element.typeName ?? "").Trim();
            if (string.IsNullOrWhiteSpace(requestedName))
                throw new InvalidOperationException($"Wall '{element.id}' requires exact typeName.");
            var wallType = wallTypes.FirstOrDefault(candidate =>
                string.Equals(candidate.Name, requestedName, StringComparison.OrdinalIgnoreCase));
            if (wallType == null)
                throw new InvalidOperationException($"Exact wall type '{requestedName}' was not found.");
            if (element.thickness.HasValue && element.thickness.Value > 0 &&
                Math.Abs(wallType.Width - element.thickness.Value) > WallTypeToleranceFeet)
            {
                throw new InvalidOperationException(
                    $"Exact wall type '{requestedName}' width {wallType.Width:0.######} ft does not match requested thickness {element.thickness.Value:0.######} ft.");
            }
            return wallType;
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

        private static bool IsElementKind(ElementDefinition element, string kind)
        {
            return string.Equals((element.element ?? "").Trim(), kind, StringComparison.OrdinalIgnoreCase);
        }

        private static List<ElementDefinition> PreserveWallElements(List<ElementDefinition> elements, out CleanupSummary summary)
        {
            var walls = elements.Where(e => IsElementKind(e, "wall")).ToList();
            summary = new CleanupSummary
            {
                InputWallCount = walls.Count,
                OutputWallCount = walls.Count,
                WallsMerged = 0,
                EndpointsExtended = 0,
                GridSnaps = 0
            };
            return walls;
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
