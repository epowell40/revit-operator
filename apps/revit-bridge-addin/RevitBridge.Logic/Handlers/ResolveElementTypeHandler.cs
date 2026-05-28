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
    public class ResolveElementTypeHandler : IRequestHandler
    {
        public class Params
        {
            public string category { get; set; } = "";
            public List<string>? categories { get; set; }
            public string typeName { get; set; } = "";
            public string name { get; set; } = ""; // alias
            public string familyName { get; set; } = "";
            public bool exact { get; set; } = true;
            public int limit { get; set; } = 10;
            public List<string>? includeParameters { get; set; }
            public bool cacheBust { get; set; }
            public int cacheMaxAgeSeconds { get; set; } = 180;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            if (p == null) throw new ArgumentException("Invalid JSON payload.");

            if (string.IsNullOrWhiteSpace(p.category) && p.categories != null && p.categories.Count > 0)
                p.category = (p.categories[0] ?? "").Trim();
            p.category = (p.category ?? "").Trim();

            var tn = (p.typeName ?? "").Trim();
            if (tn.Length == 0) tn = (p.name ?? "").Trim();
            var family = (p.familyName ?? "").Trim();
            if (string.IsNullOrWhiteSpace(p.category)) throw new ArgumentException("Missing required parameter: category");
            if (string.IsNullOrWhiteSpace(tn)) throw new ArgumentException("Missing required parameter: typeName");

            if (!ElementTypeResolver.TryResolveBuiltInCategory(p.category, out var bic, out var canonical, out var suggestions))
            {
                var hint = suggestions.Count > 0 ? $" Did you mean {string.Join(", ", suggestions.Take(5).Select(s => $"'{s}'"))}?" : " Use BuiltInCategory names like 'OST_Walls'.";
                throw new ArgumentException($"Unknown BuiltInCategory '{p.category}'.{hint}");
            }

            var doc = app.ActiveUIDocument.Document;
            bool usedCache;
            var matches = ElementTypeResolver.SearchTypes(
                doc,
                bic,
                tn,
                familyName: string.IsNullOrWhiteSpace(family) ? null : family,
                exact: p.exact,
                limit: p.limit <= 0 ? 10 : p.limit,
                cacheBust: p.cacheBust,
                cacheMaxAgeSeconds: p.cacheMaxAgeSeconds,
                usedCache: out usedCache
            );

            var results = new List<object>();
            foreach (var m in matches.Take(Math.Max(1, Math.Min(50, p.limit <= 0 ? 10 : p.limit))))
            {
                Dictionary<string, string?>? parameters = null;
                if (p.includeParameters != null && p.includeParameters.Count > 0 && p.includeParameters.Count <= 5)
                {
                    var type = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(m.Id)) as ElementType;
                    if (type != null) parameters = ElementTypeResolver.ExtractTypeParameters(type, p.includeParameters);
                }

                results.Add(new
                {
                    id = m.Id,
                    name = m.Name,
                    familyName = m.FamilyName,
                    category = canonical,
                    parameters
                });
            }

            return Task.FromResult<object>(new
            {
                ok = true,
                category = canonical,
                query = new { typeName = tn, familyName = string.IsNullOrWhiteSpace(family) ? null : family, exact = p.exact },
                usedCache,
                matches = results,
                best = results.Count > 0 ? results[0] : null
            });
        }
    }
}
