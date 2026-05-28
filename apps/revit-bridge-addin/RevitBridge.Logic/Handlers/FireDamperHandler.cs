using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class FireDamperHandler : IRequestHandler
    {
        public class Request
        {
            public string command { get; set; } // "audit" or "fix"
            public Config config { get; set; }
            public List<FixInstruction> fixes { get; set; }
        }

        public class Config
        {
            public string fireDamperFamily { get; set; } = "Fire Damper";
            public string smokeDamperFamily { get; set; } = "Smoke Damper";
            public string comboDamperFamily { get; set; } = "Fire Smoke Damper";
            public double minDuctWidthInches { get; set; } = 14.0;
        }

        public class FixInstruction
        {
            public long ductId { get; set; }
            public string damperType { get; set; } // "Fire", "Smoke", "Combo"
            public double? newWidthInches { get; set; }
            public LocationData location { get; set; }
        }

        public class LocationData
        {
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
        }

        public class AuditResult
        {
            public int wallsChecked { get; set; }
            public int ductsChecked { get; set; }
            public List<Penetration> penetrations { get; set; } = new List<Penetration>();
        }

        public class Penetration
        {
            public long ductId { get; set; }
            public long wallId { get; set; }
            public string wallRating { get; set; } // "Fire", "Smoke", "Combo"
            public LocationData location { get; set; }
            public double ductWidthInches { get; set; }
            public double ductHeightInches { get; set; }
            public bool hasDamper { get; set; }
            public string status { get; set; } // "OK", "Missing Damper", "Undersized"
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var req = JsonSerializer.Deserialize<Request>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            if (req.command == "audit")
            {
                return Task.FromResult<object>(PerformAudit(doc, req.config));
            }
            else if (req.command == "fix")
            {
                return Task.FromResult<object>(PerformFix(doc, req));
            }
            else
            {
                throw new ArgumentException($"Unknown command: {req.command}");
            }
        }

        private AuditResult PerformAudit(Document doc, Config config)
        {
            var result = new AuditResult();
            
            // 1. Get Rated Walls
            // Finding rated walls: Check "Fire Rating" param (BuiltInParameter.FIRE_RATING)
            // Smoke is trickier, often a shared parameter or type name. We'll check "Fire Rating" and assume Smoke if strictly needed or if param exists.
            // For this implementation, we focus on Fire Rating parameter having any value.
            
            var walls = new FilteredElementCollector(doc)
                .OfClass(typeof(Wall))
                .WhereElementIsNotElementType()
                .Cast<Wall>()
                .Where(w => IsRated(w))
                .ToList();

            result.wallsChecked = walls.Count;

            if (walls.Count == 0) return result;

            // 2. Get Ducts
            var ducts = new FilteredElementCollector(doc)
                .OfClass(typeof(Duct))
                .WhereElementIsNotElementType()
                .Cast<Duct>()
                .ToList();

            result.ductsChecked = ducts.Count;

            // 3. Get Existing Dampers
            var dampers = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilyInstance))
                .WhereElementIsNotElementType()
                .Cast<FamilyInstance>()
                .Where(fi => IsDamper(fi))
                .ToList();

            // 4. Intersections
            foreach (var wall in walls)
            {
                // Create a filter for this wall
                // Using ElementIntersectsElementFilter with the Wall itself is fast
                ElementIntersectsElementFilter intersectionFilter = new ElementIntersectsElementFilter(wall);
                
                var intersectingDucts = ducts.Where(d => intersectionFilter.PassesFilter(d)).ToList();

                foreach (var duct in intersectingDucts)
                {
                    // Calculate precise intersection point
                    XYZ intersectionPoint = GetIntersectionPoint(duct, wall);
                    if (intersectionPoint == null) continue; // Just touching bounding box?

                    // Check for existing damper near intersection
                    bool hasDamper = dampers.Any(d => 
                    {
                        LocationPoint lp = d.Location as LocationPoint;
                        if (lp == null) return false;
                        return lp.Point.DistanceTo(intersectionPoint) < 1.0; // 1 ft tolerance
                    });

                    // Get Duct Dimensions
                    double width = 0;
                    double height = 0;
                    
                    // Try to get Width/Height or Diameter
                    var wParam = duct.get_Parameter(BuiltInParameter.RBS_CURVE_WIDTH_PARAM);
                    var hParam = duct.get_Parameter(BuiltInParameter.RBS_CURVE_HEIGHT_PARAM);
                    var dParam = duct.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);

                    if (wParam != null && wParam.HasValue) width = wParam.AsDouble() * 12.0;
                    else if (dParam != null && dParam.HasValue) width = dParam.AsDouble() * 12.0;

                    if (hParam != null && hParam.HasValue) height = hParam.AsDouble() * 12.0;
                    else if (dParam != null && dParam.HasValue) height = dParam.AsDouble() * 12.0;

                    string ratingType = GetWallRatingType(wall);
                    string status = "OK";

                    if (!hasDamper) status = "Missing Damper";
                    else if (width < config.minDuctWidthInches) status = "Undersized";

                    if (width < config.minDuctWidthInches && !hasDamper) status = "Missing Damper & Undersized";

                    result.penetrations.Add(new Penetration
                    {
                        ductId = RevitBridge.Common.ElementIdCompat.GetValue(duct.Id),
                        wallId = RevitBridge.Common.ElementIdCompat.GetValue(wall.Id),
                        wallRating = ratingType,
                        location = new LocationData { x = intersectionPoint.X, y = intersectionPoint.Y, z = intersectionPoint.Z },
                        ductWidthInches = width,
                        ductHeightInches = height,
                        hasDamper = hasDamper,
                        status = status
                    });
                }
            }

            return result;
        }

        private object PerformFix(Document doc, Request req)
        {
            var results = new List<string>();

            using (Transaction t = new Transaction(doc, "Fix Fire Dampers"))
            {
                t.Start();

                // Load Symbols
                FamilySymbol fireSymbol = FindSymbol(doc, req.config.fireDamperFamily);
                FamilySymbol smokeSymbol = FindSymbol(doc, req.config.smokeDamperFamily);
                FamilySymbol comboSymbol = FindSymbol(doc, req.config.comboDamperFamily);

                // Activate
                if (fireSymbol != null && !fireSymbol.IsActive) fireSymbol.Activate();
                if (smokeSymbol != null && !smokeSymbol.IsActive) smokeSymbol.Activate();
                if (comboSymbol != null && !comboSymbol.IsActive) comboSymbol.Activate();

                foreach (var fix in req.fixes)
                {
                    try
                    {
                        Duct duct = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(fix.ductId)) as Duct;
                        if (duct == null) continue;

                        // 1. Resize
                        if (fix.newWidthInches.HasValue)
                        {
                            var wParam = duct.get_Parameter(BuiltInParameter.RBS_CURVE_WIDTH_PARAM);
                            if (wParam != null)
                            {
                                wParam.Set(fix.newWidthInches.Value / 12.0);
                            }
                            // If round, maybe diameter?
                            var dParam = duct.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
                            if (dParam != null)
                            {
                                dParam.Set(fix.newWidthInches.Value / 12.0);
                            }
                        }

                        // 2. Place Damper
                        FamilySymbol symbolToUse = null;
                        if (fix.damperType == "Fire") symbolToUse = fireSymbol;
                        else if (fix.damperType == "Smoke") symbolToUse = smokeSymbol;
                        else symbolToUse = comboSymbol;

                        if (symbolToUse != null && fix.location != null)
                        {
                            XYZ point = new XYZ(fix.location.x, fix.location.y, fix.location.z);
                            
                            // Using NewFamilyInstance(location, symbol, host, structuralType)
                            // Duct is the host.
                            doc.Create.NewFamilyInstance(point, symbolToUse, duct, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                            
                            results.Add($"Fixed Duct {fix.ductId}");
                        }
                        else
                        {
                            results.Add($"Skipped Placement for {fix.ductId}: Symbol not found or location missing.");
                        }
                    }
                    catch (Exception ex)
                    {
                        results.Add($"Error on {fix.ductId}: {ex.Message}");
                    }
                }

                t.Commit();
            }

            return new { fixes_applied = results };
        }

        // Helpers

        private bool IsRated(Wall w)
        {
            var p = w.get_Parameter(BuiltInParameter.FIRE_RATING);
            if (p != null && p.HasValue && !string.IsNullOrEmpty(p.AsString())) return true;
            // Add Check for Smoke Param if needed
            return false;
        }

        private string GetWallRatingType(Wall w)
        {
            // Simplified logic
            var p = w.get_Parameter(BuiltInParameter.FIRE_RATING);
            string rating = p?.AsString() ?? "";
            
            // Check for smoke
            // Ideally check Type Name or specific Project Parameter
            // For now, assume Fire unless "Smoke" is in rating string
            if (rating.IndexOf("Smoke", StringComparison.OrdinalIgnoreCase) >= 0) return "Combo";
            return "Fire";
        }

        private bool IsDamper(FamilyInstance fi)
        {
            return RevitBridge.Common.ElementIdCompat.GetValue(fi.Category.Id) == (long)BuiltInCategory.OST_DuctAccessory ||
                   RevitBridge.Common.ElementIdCompat.GetValue(fi.Category.Id) == (long)BuiltInCategory.OST_MechanicalEquipment;
                   // Add name check if needed
        }

        private XYZ GetIntersectionPoint(Duct duct, Wall wall)
        {
            Curve curve = (duct.Location as LocationCurve).Curve;
            
            // Wall Geometry
            Options opt = new Options();
            GeometryElement geom = wall.get_Geometry(opt);
            
            foreach (GeometryObject obj in geom)
            {
                if (obj is Solid solid)
                {
                    SolidCurveIntersection intersect = solid.IntersectWithCurve(curve, new SolidCurveIntersectionOptions());
                    if (intersect.SegmentCount > 0)
                    {
                        // Return midpoint of first segment
                        return intersect.GetCurveSegment(0).Evaluate(0.5, true);
                    }
                }
            }
            return null;
        }

        private FamilySymbol FindSymbol(Document doc, string familyName)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .FirstOrDefault(s => s.FamilyName.Equals(familyName, StringComparison.OrdinalIgnoreCase));
        }
    }
}

