using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class CreateFamilyInstanceHandler : IRequestHandler
    {
        public class Params
        {
            public string familyName { get; set; }
            public string symbolName { get; set; }
            public string levelName { get; set; }
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            using (Transaction trans = new Transaction(doc, "Create Family Instance"))
            {
                trans.Start();

                // 1. Find Level
                Level level = null;
                if (!string.IsNullOrEmpty(p.levelName))
                {
                    level = new FilteredElementCollector(doc)
                        .OfClass(typeof(Level))
                        .Cast<Level>()
                        .FirstOrDefault(l => l.Name.Equals(p.levelName, StringComparison.OrdinalIgnoreCase));
                }
                if (level == null) level = doc.ActiveView.GenLevel;

                // 2. Find Family Symbol
                FamilySymbol symbol = new FilteredElementCollector(doc)
                    .OfClass(typeof(FamilySymbol))
                    .Cast<FamilySymbol>()
                    .FirstOrDefault(s => 
                        (string.IsNullOrEmpty(p.familyName) || s.FamilyName.Equals(p.familyName, StringComparison.OrdinalIgnoreCase)) &&
                        s.Name.Equals(p.symbolName, StringComparison.OrdinalIgnoreCase));

                if (symbol == null)
                    throw new Exception($"Could not find Family Symbol '{p.symbolName}' (Family: '{p.familyName ?? "Any"}'). Load it first.");

                if (!symbol.IsActive) symbol.Activate();

                // 3. Create
                XYZ point = new XYZ(p.x, p.y, p.z);
                FamilyInstance instance;
                
                // Some families require a host (Level/Face). Simplest is non-hosted or level-hosted.
                // We'll try standard creation.
                try 
                {
                    instance = doc.Create.NewFamilyInstance(point, symbol, level, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                }
                catch
                {
                    // Fallback for face-based or other complex families? 
                    // For now, simpler overload
                    instance = doc.Create.NewFamilyInstance(point, symbol, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                }

                trans.Commit();

                return Task.FromResult<object>(new 
                { 
                    id = RevitBridge.Common.ElementIdCompat.GetValue(instance.Id), 
                    name = instance.Name, 
                    family = instance.Symbol.FamilyName 
                });
            }
        }
    }
}

