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
    public class GetLightingDataHandler : IRequestHandler
    {
        public class Params
        {
            public long? elementId { get; set; } // Specific instance
            public string familyName { get; set; } // Scan all types in family
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;
            var results = new List<object>();

            if (p.elementId.HasValue)
            {
                var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.elementId.Value)) as FamilyInstance;
                if (elem != null) results.Add(ExtractData(elem));
            }
            else if (!string.IsNullOrEmpty(p.familyName))
            {
                // Scan symbols
                var symbols = new FilteredElementCollector(doc)
                    .OfClass(typeof(FamilySymbol))
                    .Cast<FamilySymbol>()
                    .Where(s => s.FamilyName.Equals(p.familyName, StringComparison.OrdinalIgnoreCase));
                
                foreach (var s in symbols) results.Add(ExtractData(s));
            }
            else
            {
                // Scan all Lighting Fixtures
                 var fixtures = new FilteredElementCollector(doc)
                    .OfCategory(BuiltInCategory.OST_LightingFixtures)
                    .WhereElementIsElementType()
                    .Cast<FamilySymbol>()
                    .Take(50); // Limit
                
                 foreach (var f in fixtures) results.Add(ExtractData(f));
            }

            return Task.FromResult<object>(results);
        }

        private object ExtractData(Element e)
        {
            // Try to find Photometric Web File
            // BuiltInParameter.FBX_LIGHT_PHOTOMETRIC_FILE ? Or shared param? 
            // Usually "Photometric Web File" type parameter.
            
            string iesFile = "";
            Parameter param = e.LookupParameter("Photometric Web File");
            if (param != null && param.StorageType == StorageType.String)
                iesFile = param.AsString();
            
            // Also check type if instance
            if (string.IsNullOrEmpty(iesFile) && e is FamilyInstance fi)
            {
                param = fi.Symbol.LookupParameter("Photometric Web File");
                if (param != null) iesFile = param.AsString();
            }

            return new 
            { 
                id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id), 
                name = e.Name, 
                family = (e as FamilySymbol)?.FamilyName ?? (e as FamilyInstance)?.Symbol.FamilyName,
                iesFile = iesFile,
                // Add manufacturer if available
                manufacturer = e.LookupParameter("Manufacturer")?.AsString() ?? ""
            };
        }
    }
}

