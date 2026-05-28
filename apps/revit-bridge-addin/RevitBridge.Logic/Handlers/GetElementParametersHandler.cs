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
    public class GetElementParametersHandler : IRequestHandler
    {
        public class Params
        {
            public long elementId { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.elementId));
            if (elem == null) throw new Exception("Element not found");

            var paramsDict = new Dictionary<string, string>();
            
            foreach (Parameter param in elem.Parameters)
            {
                if (param.Definition == null) continue;
                
                string val = "";
                switch (param.StorageType)
                {
                    case StorageType.String: val = param.AsString(); break;
                    case StorageType.Integer: val = param.AsInteger().ToString(); break;
                    case StorageType.Double: val = param.AsDouble().ToString(); break; // Could format this
                    case StorageType.ElementId: val = RevitBridge.Common.ElementIdCompat.GetValue(param.AsElementId()).ToString(); break;
                }
                
                // Use Name as key, duplicate names handled by appending ID if needed or just overwriting
                if (!paramsDict.ContainsKey(param.Definition.Name))
                    paramsDict.Add(param.Definition.Name, val ?? "");
            }

            return Task.FromResult<object>(new 
            { 
                id = RevitBridge.Common.ElementIdCompat.GetValue(elem.Id), 
                name = elem.Name, 
                category = elem.Category?.Name,
                parameters = paramsDict 
            });
        }
    }
}

