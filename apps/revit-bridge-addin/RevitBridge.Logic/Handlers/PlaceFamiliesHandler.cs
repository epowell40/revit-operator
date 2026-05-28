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

namespace RevitBridge.Logic.Handlers
{
    public class PlaceFamiliesHandler : IRequestHandler
    {
        public class PlacementRequest
        {
            public string? levelName { get; set; }
            public string? familyName { get; set; }
            public string symbolName { get; set; } = "";
            public List<InstanceData> instances { get; set; } = new List<InstanceData>();

            public bool dryRun { get; set; } = false;
            public IdempotencyOptions? idempotency { get; set; }
            public string? behavior { get; set; } // allOrNothing | bestEffort
        }

        public class IdempotencyOptions
        {
            public bool enabled { get; set; } = true;
            public double toleranceFt { get; set; } = 0.01;
        }

        public class InstanceData
        {
            public string? levelName { get; set; } // optional per-instance override
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
            public double? rotationDegrees { get; set; }
            public long? hostElementId { get; set; }
            public Dictionary<string, string>? parameters { get; set; }
        }

        public class InstanceResult
        {
            public int index { get; set; }
            public string status { get; set; } = ""; // created | skipped | failed | planned
            public long? elementId { get; set; }
            public string? reason { get; set; }
            public List<string> warnings { get; set; } = new List<string>();
        }

        public class PlacementResult
        {
            public string status { get; set; } = "Unknown";
            public int placedCount { get; set; }
            public int skippedCount { get; set; }
            public int failedCount { get; set; }
            public List<long> elementIds { get; set; } = new List<long>();
            public List<InstanceResult> results { get; set; } = new List<InstanceResult>();
            public List<string> warnings { get; set; } = new List<string>();
            public string? error { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<PlacementRequest>(jsonData) ?? throw new Exception("Invalid request body.");
            var doc = app.ActiveUIDocument.Document;
            var result = new PlacementResult();

            using (Transaction t = new Transaction(doc, "Batch Place Families"))
            {
                t.Start();
                try
                {
                    bool bestEffort = string.Equals(p.behavior, "bestEffort", StringComparison.OrdinalIgnoreCase);
                    bool useIdempotency = p.idempotency?.enabled ?? false;
                    double toleranceFt = Math.Max(0.0, p.idempotency?.toleranceFt ?? 0.0);

                    var levels = new FilteredElementCollector(doc)
                        .OfClass(typeof(Level))
                        .Cast<Level>()
                        .ToList();

                    var defaultLevel = levels
                        .FirstOrDefault(l => l.Name.Equals(p.levelName ?? "", StringComparison.OrdinalIgnoreCase));
                    if (defaultLevel == null) throw new Exception($"Level {p.levelName} not found.");

                    var levelByName = levels
                        .GroupBy(l => l.Name ?? "", StringComparer.OrdinalIgnoreCase)
                        .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

                    FamilySymbol symbol = new FilteredElementCollector(doc)
                        .OfClass(typeof(FamilySymbol))
                        .Cast<FamilySymbol>()
                        .FirstOrDefault(s =>
                            (string.IsNullOrEmpty(p.familyName) || s.FamilyName.Equals(p.familyName, StringComparison.OrdinalIgnoreCase)) &&
                            s.Name.Equals(p.symbolName, StringComparison.OrdinalIgnoreCase));

                    if (symbol == null) throw new Exception($"Symbol {p.symbolName} not found.");
                    if (!symbol.IsActive)
                    {
                        symbol.Activate();
                        doc.Regenerate();
                    }

                    List<(long id, XYZ point)> existingPoints = new List<(long id, XYZ point)>();
                    if (useIdempotency && toleranceFt > 0.0)
                    {
                        existingPoints = new FilteredElementCollector(doc)
                            .OfClass(typeof(FamilyInstance))
                            .Cast<FamilyInstance>()
                            .Where(fi => fi.Symbol != null && fi.Symbol.Id == symbol.Id)
                            .Select(fi => (id: RevitBridge.Common.ElementIdCompat.GetValue(fi.Id), point: TryGetLocationPoint(fi)))
                            .Where(x => x.point != null)
                            .Select(x => (x.id, x.point!))
                            .ToList();
                    }

                    List<XYZ> plannedOrCreatedPoints = new List<XYZ>();

                    for (int i = 0; i < (p.instances?.Count ?? 0); i++)
                    {
                        var instData = p.instances[i];
                        var instResult = new InstanceResult { index = i };

                        XYZ point = new XYZ(instData.x, instData.y, instData.z);
                        var instanceLevel = defaultLevel;
                        if (!string.IsNullOrWhiteSpace(instData.levelName))
                        {
                            if (!levelByName.TryGetValue(instData.levelName.Trim(), out instanceLevel))
                            {
                                throw new Exception($"Level {instData.levelName} not found.");
                            }
                        }

                        try
                        {
                            if (useIdempotency && toleranceFt > 0.0)
                            {
                                var match = FindEquivalent(existingPoints, plannedOrCreatedPoints, point, toleranceFt);
                                if (match.found)
                                {
                                    instResult.status = "skipped";
                                    instResult.elementId = match.existingElementId;
                                    instResult.reason = "idempotent: matching instance exists within tolerance";
                                    result.skippedCount++;
                                    result.results.Add(instResult);
                                    continue;
                                }
                            }

                            FamilyInstance fi = null;
                            if (instData.hostElementId.HasValue)
                            {
                                Element host = doc.GetElement(ToElementId(instData.hostElementId.Value));
                                if (host == null) throw new Exception($"Host element {instData.hostElementId.Value} not found.");
                                if (host is ElementType) throw new Exception($"Host element {instData.hostElementId.Value} is an element type; expected an instance element.");

                                try
                                {
                                    fi = doc.Create.NewFamilyInstance(point, symbol, host, instanceLevel, StructuralType.NonStructural);
                                }
                                catch (Exception ex)
                                {
                                    instResult.warnings.Add($"Host placement failed; falling back to non-hosted/level-hosted. {ex.Message}");
                                }
                            }

                            if (fi == null)
                            {
                                try
                                {
                                    fi = doc.Create.NewFamilyInstance(point, symbol, instanceLevel, StructuralType.NonStructural);
                                }
                                catch
                                {
                                    fi = doc.Create.NewFamilyInstance(point, symbol, StructuralType.NonStructural);
                                }
                            }

                            if (fi == null) throw new Exception("Failed to create family instance.");

                            if (instData.rotationDegrees.HasValue && Math.Abs(instData.rotationDegrees.Value) > 1e-9)
                            {
                                RotateAboutZ(doc, fi.Id, point, instData.rotationDegrees.Value);
                            }

                            if (instData.parameters != null)
                            {
                                foreach (var kvp in instData.parameters)
                                {
                                    SetParameter(fi, kvp.Key, kvp.Value);
                                }
                            }

                            SetParameter(fi, "ROS_AutoGenerated", "1");
                            plannedOrCreatedPoints.Add(point);

                            if (p.dryRun)
                            {
                                instResult.status = "planned";
                                instResult.reason = "dryRun: rolled back";
                            }
                            else
                            {
                                instResult.status = "created";
                                instResult.elementId = RevitBridge.Common.ElementIdCompat.GetValue(fi.Id);
                                result.elementIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(fi.Id));
                                result.placedCount++;
                            }

                            result.results.Add(instResult);
                        }
                        catch (Exception ex)
                        {
                            instResult.status = "failed";
                            instResult.reason = ex.Message;
                            result.failedCount++;
                            result.results.Add(instResult);

                            if (!bestEffort)
                                throw new Exception($"Failed to place family instance at index {i}: {ex.Message}", ex);
                        }
                    }

                    if (p.dryRun)
                    {
                        result.status = result.failedCount > 0 ? "PlannedWithErrors" : "Planned";
                        t.RollBack();
                    }
                    else
                    {
                        result.status = result.failedCount > 0 ? "PlacedWithErrors" : "Placed";
                        t.Commit();
                    }
                }
                catch (Exception ex)
                {
                    result.status = "Failed";
                    result.error = ex.Message;
                    t.RollBack();
                }
            }

            return Task.FromResult<object>(result);
        }

        private static (bool found, long? existingElementId) FindEquivalent(List<(long id, XYZ point)> existing, List<XYZ> plannedOrCreated, XYZ target, double toleranceFt)
        {
            foreach (var e in existing)
            {
                if (e.point.DistanceTo(target) <= toleranceFt) return (true, e.id);
            }
            foreach (var p in plannedOrCreated)
            {
                if (p.DistanceTo(target) <= toleranceFt) return (true, null);
            }
            return (false, null);
        }

        private static XYZ? TryGetLocationPoint(FamilyInstance fi)
        {
            if (fi.Location is LocationPoint lp) return lp.Point;
            return null;
        }

        private static void RotateAboutZ(Document doc, ElementId elementId, XYZ origin, double rotationDegrees)
        {
            double radians = rotationDegrees * (Math.PI / 180.0);
            Line axis = Line.CreateBound(origin, origin + XYZ.BasisZ);
            ElementTransformUtils.RotateElement(doc, elementId, axis, radians);
        }

        private static ElementId ToElementId(long id)
        {
            if (id < int.MinValue || id > int.MaxValue) throw new Exception($"ElementId {id} is outside 32-bit range.");
            return RevitBridge.Common.ElementIdCompat.Create((int)id);
        }

        private void SetParameter(Element e, string name, string value)
        {
            Parameter param = e.LookupParameter(name);
            if (param == null) return;
            if (param.IsReadOnly) return;

            if (param.StorageType == StorageType.String)
            {
                param.Set(value);
            }
            else if (param.StorageType == StorageType.Double)
            {
                if (double.TryParse(value, NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out double d)) param.Set(d);
            }
            else if (param.StorageType == StorageType.Integer)
            {
                if (int.TryParse(value, out int i)) param.Set(i);
            }
            else if (param.StorageType == StorageType.ElementId)
            {
                if (long.TryParse(value, out long id) && id >= int.MinValue && id <= int.MaxValue)
                    param.Set(RevitBridge.Common.ElementIdCompat.Create((int)id));
            }
        }
    }
}

