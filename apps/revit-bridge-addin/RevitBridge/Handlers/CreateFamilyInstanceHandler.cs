using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class CreateFamilyInstanceHandler : IRequestHandler
    {
        private sealed class CreatedInstance
        {
            public int index { get; set; }
            public long id { get; set; }
            public string? name { get; set; }
            public string? family { get; set; }
            public string? familyName { get; set; }
            public string? symbol { get; set; }
            public string? symbolName { get; set; }
            public string? typeName { get; set; }
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
        }

        private sealed class PlannedInstance
        {
            public int index { get; set; }
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
            public double rotationDegrees { get; set; }
        }

        public class Params
        {
            public string? familyName { get; set; }
            public string? symbolName { get; set; }
            public string? typeName { get; set; } // alias for symbolName
            public string? levelName { get; set; }
            public long? viewId { get; set; }
            public string? sheetNumber { get; set; }
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
            public int? count { get; set; }
            public double? spacingX { get; set; }
            public double? spacingY { get; set; }
            public double? spacingZ { get; set; }
            public double? rotationDegrees { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");

            var symbolName = (p.symbolName ?? p.typeName ?? "").Trim();
            if (symbolName.Length == 0)
                throw new InvalidOperationException("create-family-instance requires symbolName (or typeName).");

            var dryRun = p.dryRun ?? false;
            var requestedCount = p.count ?? 1;
            if (requestedCount < 1) requestedCount = 1;
            if (requestedCount > 200) requestedCount = 200;

            var targetView = ResolveTargetView(doc, p.viewId, p.sheetNumber);
            var level = ResolveLevel(doc, p.levelName, targetView);

            var symbol = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .FirstOrDefault(s =>
                    (string.IsNullOrWhiteSpace(p.familyName) || s.FamilyName.Equals(p.familyName, StringComparison.OrdinalIgnoreCase)) &&
                    s.Name.Equals(symbolName, StringComparison.OrdinalIgnoreCase));
            if (symbol == null)
            {
                throw new InvalidOperationException($"Could not find Family Symbol '{symbolName}' (Family: '{p.familyName ?? "Any"}'). Load it first.");
            }

            var dx = p.spacingX ?? 0.0;
            var dy = p.spacingY ?? 0.0;
            var dz = p.spacingZ ?? 0.0;
            var rotationDegrees = p.rotationDegrees ?? 0.0;

            var created = new List<CreatedInstance>();
            var planned = new List<PlannedInstance>();
            using (var trans = new Transaction(doc, "Create Family Instance"))
            {
                trans.Start();
                try
                {
                    if (!symbol.IsActive)
                    {
                        symbol.Activate();
                        doc.Regenerate();
                    }

                    for (int i = 0; i < requestedCount; i++)
                    {
                        var point = new XYZ(
                            p.x + (i * dx),
                            p.y + (i * dy),
                            p.z + (i * dz));

                        var instance = CreateInstanceAtPoint(doc, symbol, level, targetView, point);
                        if (Math.Abs(rotationDegrees) > 1e-9)
                        {
                            RotateAboutZ(doc, instance.Id, point, rotationDegrees);
                        }

                        if (dryRun)
                        {
                            planned.Add(new PlannedInstance
                            {
                                index = i,
                                x = point.X,
                                y = point.Y,
                                z = point.Z,
                                rotationDegrees = rotationDegrees
                            });
                        }
                        else
                        {
                            created.Add(new CreatedInstance
                            {
                                index = i,
                                id = RevitBridge.Common.ElementIdCompat.GetValue(instance.Id),
                                name = instance.Name,
                                family = instance.Symbol?.FamilyName,
                                familyName = instance.Symbol?.FamilyName,
                                symbol = instance.Symbol?.Name,
                                symbolName = instance.Symbol?.Name,
                                typeName = instance.Symbol?.Name,
                                x = point.X,
                                y = point.Y,
                                z = point.Z
                            });
                        }
                    }

                    if (dryRun)
                    {
                        trans.RollBack();
                        return Task.FromResult<object>(new
                        {
                            status = "Dry Run",
                            dryRun = true,
                            requestedCount,
                            familyName = symbol.FamilyName,
                            symbolName = symbol.Name,
                            levelName = level?.Name,
                            targetView = targetView == null ? null : new
                            {
                                id = RevitBridge.Common.ElementIdCompat.GetValue(targetView.Id),
                                name = targetView.Name
                            },
                            planned
                        });
                    }

                    trans.Commit();
                }
                catch
                {
                    trans.RollBack();
                    throw;
                }
            }

            var first = created.FirstOrDefault();
            var firstId = first?.id ?? 0;
            var firstName = first?.name;

            return Task.FromResult<object>(new
            {
                status = "Placed",
                dryRun = false,
                count = created.Count,
                id = firstId,
                name = firstName,
                family = symbol.FamilyName,
                familyName = symbol.FamilyName,
                symbol = symbol.Name,
                symbolName = symbol.Name,
                typeName = symbol.Name,
                levelName = level?.Name,
                targetView = targetView == null ? null : new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(targetView.Id),
                    name = targetView.Name
                },
                instances = created
            });
        }

        private static View? ResolveTargetView(Document doc, long? viewId, string? sheetNumber)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
            }

            var number = (sheetNumber ?? "").Trim();
            if (number.Length == 0) return null;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .FirstOrDefault(s => (s.SheetNumber ?? "").Trim().Equals(number, StringComparison.OrdinalIgnoreCase));
        }

        private static Level? ResolveLevel(Document doc, string? levelName, View? targetView)
        {
            var requestedLevelName = (levelName ?? "").Trim();
            if (requestedLevelName.Length > 0)
            {
                var byName = new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .FirstOrDefault(l => (l.Name ?? "").Trim().Equals(requestedLevelName, StringComparison.OrdinalIgnoreCase));
                if (byName == null)
                    throw new InvalidOperationException($"Level '{requestedLevelName}' not found.");
                return byName;
            }

            if (targetView?.GenLevel != null) return targetView.GenLevel;
            if (doc.ActiveView?.GenLevel != null) return doc.ActiveView.GenLevel;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .OrderBy(l => l.Elevation)
                .FirstOrDefault();
        }

        private static FamilyInstance CreateInstanceAtPoint(Document doc, FamilySymbol symbol, Level? level, View? targetView, XYZ point)
        {
            Exception? firstError = null;

            if (targetView != null)
            {
                try
                {
                    return doc.Create.NewFamilyInstance(point, symbol, targetView);
                }
                catch (Exception ex)
                {
                    firstError = ex;
                }
            }

            if (level != null)
            {
                try
                {
                    return doc.Create.NewFamilyInstance(point, symbol, level, StructuralType.NonStructural);
                }
                catch (Exception ex)
                {
                    firstError ??= ex;
                }
            }

            try
            {
                return doc.Create.NewFamilyInstance(point, symbol, StructuralType.NonStructural);
            }
            catch (Exception ex)
            {
                firstError ??= ex;
                throw new InvalidOperationException($"Failed to create family instance '{symbol.FamilyName} : {symbol.Name}'. {firstError?.Message}", ex);
            }
        }

        private static void RotateAboutZ(Document doc, ElementId elementId, XYZ origin, double rotationDegrees)
        {
            var radians = rotationDegrees * (Math.PI / 180.0);
            var axis = Line.CreateBound(origin, origin + XYZ.BasisZ);
            ElementTransformUtils.RotateElement(doc, elementId, axis, radians);
        }
    }
}
