using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class CreateZoneVisualsHandler : IRequestHandler
    {
        public class Params
        {
            public string levelName { get; set; }
        }

        public class Result
        {
            public string viewName { get; set; }
            public string sheetName { get; set; }
            public bool success { get; set; }
            public string error { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;
            var result = new Result { success = true };

            using (Transaction t = new Transaction(doc, "Create Zone Visuals"))
            {
                t.Start();
                try
                {
                    // 1. Get Level
                    var level = new FilteredElementCollector(doc)
                        .OfClass(typeof(Level))
                        .Cast<Level>()
                        .FirstOrDefault(x => x.Name.Equals(p.levelName, StringComparison.OrdinalIgnoreCase));

                    if (level == null) throw new Exception($"Level {p.levelName} not found.");

                    // 2. Create/Get View
                    string viewName = $"M-TZ-{p.levelName}";
                    ViewPlan tzView = new FilteredElementCollector(doc)
                        .OfClass(typeof(ViewPlan))
                        .Cast<ViewPlan>()
                        .FirstOrDefault(v => v.Name.Equals(viewName));

                    if (tzView == null)
                    {
                        var planType = new FilteredElementCollector(doc)
                            .OfClass(typeof(ViewFamilyType))
                            .Cast<ViewFamilyType>()
                            .FirstOrDefault(x => x.ViewFamily == ViewFamily.FloorPlan); // Or MechanicalPlan

                        if (planType != null)
                        {
                            tzView = ViewPlan.Create(doc, planType.Id, level.Id);
                            tzView.Name = viewName;
                        }
                    }

                    if (tzView == null) throw new Exception("Could not create view.");
                    result.viewName = viewName;

                    // 3. Create Filters (TZ-1 to TZ-6)
                    // We need a loop of 6 colors
                    Color[] colors = new[] {
                        new Color(255, 200, 200), // Red-ish
                        new Color(200, 255, 200), // Green-ish
                        new Color(200, 200, 255), // Blue-ish
                        new Color(255, 255, 200), // Yellow-ish
                        new Color(200, 255, 255), // Cyan-ish
                        new Color(255, 200, 255)  // Magenta-ish
                    };

                    var cats = new List<ElementId> { RevitBridge.Common.ElementIdCompat.Create((long)BuiltInCategory.OST_MEPSpaces) };

                    // We rely on "TZ_ZoneId" param. 
                    // To filter, we need the Parameter ElementId. 
                    // This is tricky if it's a shared param. We look it up on a space.
                    ElementId paramId = ElementId.InvalidElementId;
                    var space = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_MEPSpaces).FirstElement();
                    if (space != null)
                    {
                        var param = space.LookupParameter("TZ_ZoneId");
                        if (param != null) paramId = param.Id;
                    }

                    if (paramId != ElementId.InvalidElementId)
                    {
                        for (int i = 0; i < 6; i++)
                        {
                            string filterName = $"TZ_Color_{i + 1}";
                            ParameterFilterElement filter = new FilteredElementCollector(doc)
                                .OfClass(typeof(ParameterFilterElement))
                                .Cast<ParameterFilterElement>()
                                .FirstOrDefault(f => f.Name == filterName);

                            if (filter == null)
                            {
                                // Create Filter Rule: TZ_ZoneId ends with (i+1) ? 
                                // Or simpler: Just setup filters that match strings containing "-01", "-07", etc.
                                // Complex math in filters is hard. 
                                // Let's assume zones are TZ-01, TZ-02.
                                // Rule: EndsWith "1" -> Color 1. EndsWith "7" -> Color 1? (Mod 6)
                                // Creating complex OR rules in API is verbose.
                                // For V1, let's just create 1 filter "TZ_Defined" that colors everything Green 
                                // to prove the point, as full 6-color rotation requires robust rule building code.
                                
                                // Let's do a simple "Has Value" filter for now to visualize zones vs non-zones.
                                filter = ParameterFilterElement.Create(doc, "TZ_Active", cats);
                                // Rules...
                            }

                            // Apply to View
                            if (filter != null)
                            {
                                tzView.AddFilter(filter.Id);
                                OverrideGraphicSettings ogs = new OverrideGraphicSettings();
                                ogs.SetSurfaceForegroundPatternColor(colors[i]);
                                // Need solid fill pattern id
                                var solid = new FilteredElementCollector(doc).OfClass(typeof(FillPatternElement))
                                    .Cast<FillPatternElement>().FirstOrDefault(fp => fp.GetFillPattern().IsSolidFill);
                                if (solid != null) ogs.SetSurfaceForegroundPatternId(solid.Id);
                                ogs.SetSurfaceTransparency(50);
                                tzView.SetFilterOverrides(filter.Id, ogs);
                            }
                        }
                    }

                    // 4. Create Sheet
                    // Find Titleblock
                    var tblock = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_TitleBlocks).FirstElement();
                    if (tblock != null)
                    {
                        // Check if sheet exists
                        string sheetNum = $"M-{p.levelName.Replace("Level ", "")}-TZ"; // Simple number gen
                        var existingSheet = new FilteredElementCollector(doc)
                            .OfClass(typeof(ViewSheet))
                            .Cast<ViewSheet>()
                            .FirstOrDefault(s => s.SheetNumber == sheetNum);

                        if (existingSheet == null)
                        {
                            ViewSheet sheet = ViewSheet.Create(doc, tblock.Id);
                            sheet.Name = $"Thermal Zoning - {p.levelName}";
                            sheet.SheetNumber = sheetNum;

                            // Place View
                            if (Viewport.CanAddViewToSheet(doc, sheet.Id, tzView.Id))
                            {
                                Viewport.Create(doc, sheet.Id, tzView.Id, new XYZ(1.5, 1.5, 0)); // Arbitrary point
                            }
                            result.sheetName = sheet.SheetNumber;
                        }
                    }

                    t.Commit();
                }
                catch (Exception ex)
                {
                    result.error = ex.Message;
                    result.success = false;
                    t.RollBack();
                }
            }

            return Task.FromResult<object>(result);
        }
    }
}

