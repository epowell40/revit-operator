using System;
using System.Linq;
using System.Collections.Generic;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using System.Text.Json;

namespace RevitBridge.Logic.Handlers
{
    public class ResolveHandler : IRequestHandler
    {
        public class ResolveRequest
        {
            public string type { get; set; } // "level", "view", "sheet"
            public string query { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var doc = app.ActiveUIDocument.Document;
            var req = JsonSerializer.Deserialize<ResolveRequest>(jsonData, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            if (req == null || string.IsNullOrWhiteSpace(req.type))
            {
                throw new ArgumentException("Invalid request: 'type' is required.");
            }

            object result = null;

            switch (req.type.ToLower())
            {
                case "level":
                    result = ResolveLevel(doc, req.query);
                    break;
                case "view":
                    result = ResolveView(doc, req.query);
                    break;
                case "sheet":
                    result = ResolveSheet(doc, req.query);
                    break;
                default:
                    throw new ArgumentException($"Unknown resolution type: {req.type}");
            }

            return Task.FromResult(result);
        }

        private object ResolveLevel(Document doc, string nameQuery)
        {
            var levels = new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .ToList();

            Level match = null;

            // 1. Exact match
            match = levels.FirstOrDefault(l => l.Name.Equals(nameQuery, StringComparison.OrdinalIgnoreCase));

            // 2. Contains match
            if (match == null && !string.IsNullOrWhiteSpace(nameQuery))
            {
                match = levels.FirstOrDefault(l => l.Name.IndexOf(nameQuery, StringComparison.OrdinalIgnoreCase) >= 0);
            }

            // 3. If "Level 1" matches "Level 01" or similar common variations (basic normalization)
            if (match == null && !string.IsNullOrWhiteSpace(nameQuery))
            {
                 // Simple strategy: remove spaces and compare
                 var normalizedQuery = nameQuery.Replace(" ", "");
                 match = levels.FirstOrDefault(l => l.Name.Replace(" ", "").Equals(normalizedQuery, StringComparison.OrdinalIgnoreCase));
            }

            if (match == null) return null;

            return new
            {
                id = RevitBridge.Common.ElementIdCompat.GetValue(match.Id),
                name = match.Name,
                elevation = match.Elevation
            };
        }

        private object ResolveView(Document doc, string nameQuery)
        {
            var views = new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Where(v => !v.IsTemplate)
                .ToList();

            View match = null;

            // 1. Exact match
            match = views.FirstOrDefault(v => v.Name.Equals(nameQuery, StringComparison.OrdinalIgnoreCase));

            // 2. Contains match
            if (match == null && !string.IsNullOrWhiteSpace(nameQuery))
            {
                match = views.FirstOrDefault(v => v.Name.IndexOf(nameQuery, StringComparison.OrdinalIgnoreCase) >= 0);
            }

            if (match == null) return null;

            return new
            {
                id = RevitBridge.Common.ElementIdCompat.GetValue(match.Id),
                name = match.Name,
                type = match.ViewType.ToString()
            };
        }

        private object ResolveSheet(Document doc, string query)
        {
            var sheets = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .ToList();

            ViewSheet match = null;

            // 1. Exact Sheet Number
            match = sheets.FirstOrDefault(s => s.SheetNumber.Equals(query, StringComparison.OrdinalIgnoreCase));

            // 2. Exact Sheet Name
            if (match == null)
            {
                match = sheets.FirstOrDefault(s => s.Name.Equals(query, StringComparison.OrdinalIgnoreCase));
            }

            // 3. Contains Sheet Name
            if (match == null && !string.IsNullOrWhiteSpace(query))
            {
                 match = sheets.FirstOrDefault(s => s.Name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0);
            }

            if (match == null) return null;

            return new
            {
                id = RevitBridge.Common.ElementIdCompat.GetValue(match.Id),
                sheetNumber = match.SheetNumber,
                name = match.Name
            };
        }
    }
}

