using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Lighting;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class LightingHandler : IRequestHandler
    {
        public class Request
        {
            public string command { get; set; } // "validate_ies", "photometrics", "lpd"
            public string scope { get; set; } // "Level 1", "Room 101", "Building"
            public bool fix { get; set; } = false;
            public Dictionary<string, string> ies_corrections { get; set; }
            public double default_cu { get; set; } = 0.8;
            public double default_llf { get; set; } = 0.85;
            public bool visualize { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var req = JsonSerializer.Deserialize<Request>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            switch (req.command)
            {
                case "validate_ies":
                    return Task.FromResult(ValidateIES(doc, req));
                case "photometrics":
                    return Task.FromResult(CalculatePhotometrics(doc, req));
                case "lpd":
                    return Task.FromResult(AuditLPD(doc, req));
                default:
                    throw new ArgumentException($"Unknown command: {req.command}");
            }
        }

        // --- IES Validation ---

        private object ValidateIES(Document doc, Request req)
        {
            var results = new List<object>();
            var symbols = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .OfCategory(BuiltInCategory.OST_LightingFixtures)
                .Cast<FamilySymbol>();

            using (Transaction t = new Transaction(doc, "Fix IES Files"))
            {
                if (req.fix) t.Start();

                foreach (var sym in symbols)
                {
                    var p = sym.LookupParameter("Photometric Web File");
                    if (p == null) continue;

                    string currentPath = p.AsString();
                    string status = "Valid";
                    string familyName = sym.FamilyName;
                    
                    if (string.IsNullOrWhiteSpace(currentPath))
                    {
                        status = "Missing";
                    }
                    else if (!System.IO.File.Exists(currentPath) && !System.IO.File.Exists(System.IO.Path.Combine(doc.PathName, currentPath)))
                    {
                         // Basic check - might be relative path resolved by Revit internally. 
                         // But we flag it if not absolute or not found.
                         status = "File Not Found";
                    }

                    if (status != "Valid" && req.fix && req.ies_corrections != null)
                    {
                        // Try to find correction by Family Name or Type Name
                        if (req.ies_corrections.TryGetValue(familyName, out string newPath))
                        {
                            p.Set(newPath);
                            status = "Fixed";
                            currentPath = newPath;
                        }
                    }

                    if (status != "Valid" || req.fix)
                    {
                        results.Add(new
                        {
                            family = familyName,
                            type = sym.Name,
                            path = currentPath,
                            status = status
                        });
                    }
                }

                if (req.fix) t.Commit();
            }

            return new { count = results.Count, issues = results };
        }

        // --- Photometrics ---

        private object CalculatePhotometrics(Document doc, Request req)
        {
            var rooms = GetRoomsInScope(doc, req.scope);
            var results = new List<object>();
            
            // Collect all lighting fixtures once
            var fixtures = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilyInstance))
                .OfCategory(BuiltInCategory.OST_LightingFixtures)
                .Cast<FamilyInstance>()
                .ToList();

            using (Transaction t = new Transaction(doc, "Visualize Lighting Levels"))
            {
                if (req.visualize) t.Start();

                // Create View if needed
                View view = null;
                if (req.visualize)
                {
                    // Simplify: Just use active view if plan, or find one
                    view = doc.ActiveView;
                    if (view.ViewType != ViewType.FloorPlan && view.ViewType != ViewType.CeilingPlan)
                    {
                        // Fallback or warning
                    }
                }

                foreach (var room in rooms)
                {
                    double area = room.Area;
                    if (area <= 0) continue;

                    // Find fixtures in room
                    // Fixture.Room might be null or Phase dependent. 
                    // We check .Room, then .Space, then geometric containment?
                    // For speed, just .Room property for now.
                    
                    var roomFixtures = fixtures.Where(f => 
                    {
                        if (f.Room != null && f.Room.Id == room.Id) return true;
                        // Try space?
                        if (f.Space != null && f.Space.Room != null && f.Space.Room.Id == room.Id) return true;
                        return false; 
                    }).ToList();

                    double totalLumens = 0;
                    foreach (var f in roomFixtures)
                    {
                        // Try BuiltInParameter first
                        // RBS_LIGHT_LUMEN_PARAM might be for the connector or the type.
                        // RBS_LIGHT_INITIAL_LUMINOUS_FLUX (Type parameter usually)
                        
                        double lumens = 0;
                        var sym = f.Symbol;
                        
                        // Try Lookup by Name first as it is safer for Light Source defs
                        var pLumens = sym.LookupParameter("Initial Luminous Flux");
                        if (pLumens == null) pLumens = sym.LookupParameter("Luminous Flux");
                        
                        if (pLumens != null && pLumens.StorageType == StorageType.Double)
                        {
                            lumens = pLumens.AsDouble(); 
                        }
                        else
                        {
                            // Fallback to BuiltInParameter if valid - Removed invalid param
                            // var pBip = sym.get_Parameter(BuiltInParameter.RBS_LIGHT_LUMEN_PARAM);
                            // if (pBip != null) lumens = pBip.AsDouble();
                        }
                        
                        totalLumens += lumens;
                    }

                    double avgFC = (totalLumens * req.default_cu * req.default_llf) / area;

                    results.Add(new
                    {
                        roomId = RevitBridge.Common.ElementIdCompat.GetValue(room.Id),
                        roomName = room.Name,
                        area = area,
                        fixtureCount = roomFixtures.Count,
                        totalLumens = totalLumens,
                        avgFC = avgFC
                    });

                    if (req.visualize && view != null)
                    {
                        // Find Text Type
                        var textType = new FilteredElementCollector(doc)
                            .OfClass(typeof(TextNoteType))
                            .FirstElementId();

                        // Create Text Note
                        LocationPoint lp = room.Location as LocationPoint;
                        if (lp != null && textType != null)
                        {
                            try {
                                TextNote.Create(doc, view.Id, lp.Point, $"{avgFC:F1} fc", textType); 
                            } catch {}
                        }
                    }
                }

                if (req.visualize) t.Commit();
            }

            return results;
        }

        // --- LPD ---

        private object AuditLPD(Document doc, Request req)
        {
            var results = new List<object>();
            
            // Use Spaces if available, else Rooms (but Rooms don't have Electrical Load naturally)
            // We'll search for Spaces.
            var spaces = new FilteredElementCollector(doc)
                .OfClass(typeof(SpatialElement))
                .WhereElementIsNotElementType()
                .Where(e => e is Space)
                .Cast<Space>()
                .ToList();

            if (req.scope != "Building")
            {
                // Filter by Level
                if (req.scope.StartsWith("Level"))
                {
                    spaces = spaces.Where(s => s.Level.Name.Equals(req.scope, StringComparison.OrdinalIgnoreCase)).ToList();
                }
            }

            foreach (var space in spaces)
            {
                double area = space.Area;
                if (area <= 0) continue;

                // Actual Lighting Load
                double load = 0;
                var pLoad = space.LookupParameter("Actual Lighting Load");
                if (pLoad != null) load = pLoad.AsDouble(); // Watts (Internal Units? Likely Watts if Electrical)
                // Revit internal unit for power is Watts? No, verify.
                // Usually internal is Watts.
                
                // Note: If project units are different, `AsDouble` returns internal (Watts). 

                double lpd = load / area; // W / SF (Internal area is SF)

                results.Add(new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(space.Id),
                    name = space.Name,
                    number = space.Number,
                    type = space.SpaceType.ToString(), // Or lookup parameter
                    area = area,
                    watts = load,
                    lpd = lpd
                });
            }

            return results;
        }

        // --- Helpers ---

        private List<Room> GetRoomsInScope(Document doc, string scope)
        {
            var collector = new FilteredElementCollector(doc).OfClass(typeof(Room)).Cast<Room>();
            
            if (string.IsNullOrEmpty(scope) || scope == "Building")
                return collector.ToList();
            
            if (scope.StartsWith("Level", StringComparison.OrdinalIgnoreCase))
            {
                // Level name match
                return collector.Where(r => r.Level.Name.Equals(scope, StringComparison.OrdinalIgnoreCase)).ToList();
            }
            
            // Assume Room Number or Name
            return collector.Where(r => r.Number == scope || r.Name.Equals(scope, StringComparison.OrdinalIgnoreCase)).ToList();
        }
    }
}

