using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class SetParameterHandler : IRequestHandler
    {
        public class SetParamEntry
        {
            public long elementId { get; set; }
            public string parameterName { get; set; }
            public string value { get; set; }
        }

        public class Params
        {
            public List<SetParamEntry> changes { get; set; }
            public bool apply { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;
            var results = new List<object>();

            if (p.apply)
            {
                using (Transaction trans = new Transaction(doc, "Set Parameters"))
                {
                    trans.Start();
                    foreach (var entry in p.changes)
                    {
                        var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(entry.elementId));
                        if (elem == null)
                        {
                            results.Add(new { elementId = entry.elementId, status = "Error: Element not found" });
                            continue;
                        }

                        var param = elem.LookupParameter(entry.parameterName);
                        if (param == null || param.IsReadOnly)
                        {
                            results.Add(new { elementId = entry.elementId, status = $"Error: Parameter '{entry.parameterName}' not found or read-only" });
                            continue;
                        }

                        bool success = false;
                        switch (param.StorageType)
                        {
                            case StorageType.String:
                                success = param.Set(RevitTextCasePolicy.NormalizeParameterValue(elem, param, entry.parameterName, entry.value));
                                break;
                            case StorageType.Integer:
                                success = param.Set(int.Parse(entry.value));
                                break;
                            case StorageType.Double:
                                success = param.Set(double.Parse(entry.value));
                                break;
                            case StorageType.ElementId:
                                success = param.Set(RevitBridge.Common.ElementIdCompat.Create(long.Parse(entry.value)));
                                break;
                        }
                        results.Add(new { elementId = entry.elementId, parameter = entry.parameterName, success });
                    }
                    trans.Commit();
                }
            }
            else
            {
                // Dry run
                foreach (var entry in p.changes)
                {
                    var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(entry.elementId));
                    results.Add(new { elementId = entry.elementId, parameter = entry.parameterName, canChange = elem != null && elem.LookupParameter(entry.parameterName) != null });
                }
            }

            return Task.FromResult<object>(results);
        }
    }
}

