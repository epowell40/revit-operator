using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class EnsureSpacesHandler : IRequestHandler
    {
        public class Params
        {
            public string levelName { get; set; }
        }

        public class Result
        {
            public int spacesCreated { get; set; }
            public int existingSpaces { get; set; }
            public List<string> errors { get; set; } = new List<string>();
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;
            var result = new Result();

            Level level = null;
            if (!string.IsNullOrEmpty(p.levelName))
            {
                level = new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .FirstOrDefault(x => x.Name.Equals(p.levelName, StringComparison.OrdinalIgnoreCase));
            }

            if (level == null)
            {
                result.errors.Add($"Level '{p.levelName}' not found.");
                return Task.FromResult<object>(result);
            }

            using (Transaction t = new Transaction(doc, "Ensure Spaces"))
            {
                t.Start();

                try
                {
                    // 1. Get existing spaces
                    var existingSpaces = new FilteredElementCollector(doc)
                        .OfCategory(BuiltInCategory.OST_MEPSpaces)
                        .WhereElementIsNotElementType()
                        .Where(e => e.LevelId == level.Id)
                        .Cast<Space>()
                        .ToList();
                    
                    result.existingSpaces = existingSpaces.Count;

                    // 2. Get Rooms without spaces
                    // Note: Create.NewSpaces2 is the modern method to create spaces for all rooms in a phase/level
                    // But here we might want granular control.
                    // Let's use the bulk creation method if available or iterate.
                    
                    // Simple approach: Use doc.Create.NewSpaces2(level, phase, view)
                    // We need a Phase. Usually the last phase.
                    Phase phase = doc.Phases.get_Item(doc.Phases.Size - 1);

                    // If NewSpaces2 is available (Revit 2017+), it creates spaces for all rooms/voids
                    // However, to be safe and report count, let's try to match 1:1 first or just call it and see count diff.
                    
                    // The API method creates spaces for all enclosed regions.
                    // doc.Create.NewSpaces2(level, phase, view);
                    
                    // Let's try finding rooms first to verify intent.
                    var rooms = new FilteredElementCollector(doc)
                        .OfCategory(BuiltInCategory.OST_Rooms)
                        .WhereElementIsNotElementType()
                        .Where(e => e.LevelId == level.Id)
                        .Cast<Room>()
                        .ToList();

                    // Naive check: if room has location, check if space exists there.
                    // Optimization: Just call NewSpaces2, it ignores existing.
                    
                    // Note: NewSpaces2 takes a View, not just a Level in some overloads, or Level+Phase.
                    // public ICollection<ElementId> NewSpaces2(Level level, Phase phase, View view);
                    
                    // We need a view for the level to ensure visibility/bound determination? 
                    // Actually, there is an overload: NewSpaces2(Level, Phase, View)
                    
                    // Let's find a plan view for this level
                    View planView = new FilteredElementCollector(doc)
                        .OfClass(typeof(ViewPlan))
                        .Cast<ViewPlan>()
                        .FirstOrDefault(v => v.GenLevel != null && v.GenLevel.Id == level.Id && !v.IsTemplate);

                    if (planView == null)
                    {
                        // Fallback: Create spaces manually per room? 
                        // Or just create a temp view?
                        // Let's try iterating rooms and creating NewSpace per room location.
                        
                        foreach (var room in rooms)
                        {
                            if (room.Location is LocationPoint lp)
                            {
                                // Check if space exists at point
                                Space s = doc.GetSpaceAtPoint(lp.Point, phase);
                                if (s == null)
                                {
                                    doc.Create.NewSpace(level, phase, new UV(lp.Point.X, lp.Point.Y));
                                    result.spacesCreated++;
                                }
                            }
                        }
                    }
                    else
                    {
                        // Bulk create
                         var createdIds = doc.Create.NewSpaces2(level, phase, planView);
                         result.spacesCreated = createdIds.Count;
                    }
                    
                    // Update count
                    result.existingSpaces += result.spacesCreated;

                    t.Commit();
                }
                catch (Exception ex)
                {
                    result.errors.Add(ex.Message);
                    t.RollBack();
                }
            }

            return Task.FromResult<object>(result);
        }
    }
}

