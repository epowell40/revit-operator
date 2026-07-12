using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class ListViewsHandler : IRequestHandler
    {
        private sealed class QueryRequest
        {
            public string? action { get; set; }
            public long[]? viewIds { get; set; }
            public string[]? levelNames { get; set; }
            public string[]? viewTypes { get; set; }
            public string[]? disciplines { get; set; }
            public string[]? viewNames { get; set; }
            public string[]? nameContainsAny { get; set; }
            public string[]? semanticGroups { get; set; }
            public bool? includeTemplates { get; set; }
            public int? offset { get; set; }
            public int? limit { get; set; }
            [JsonExtensionData]
            public Dictionary<string, JsonElement>? unknownFields { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var doc = app.ActiveUIDocument.Document;
            var rawViews = new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .ToList();

            // Preserve the legacy GET response exactly: an unwrapped array of all non-template views.
            if (string.IsNullOrWhiteSpace(jsonData))
            {
                var legacy = rawViews.Where(v => !v.IsTemplate).Select(v => new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(v.Id),
                    name = v.Name,
                    type = v.ViewType.ToString(),
                    isAssembly = v.IsAssemblyView
                }).ToList();
                return Task.FromResult<object>(legacy);
            }

            QueryRequest request;
            try
            {
                request = JsonSerializer.Deserialize<QueryRequest>(jsonData, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new QueryRequest();
            }
            catch (Exception ex)
            {
                throw new ArgumentException("Invalid view query JSON.", ex);
            }
            if (request.unknownFields != null && request.unknownFields.Count > 0)
                throw new ArgumentException($"Unsupported view query field(s): {string.Join(", ", request.unknownFields.Keys.OrderBy(key => key, StringComparer.OrdinalIgnoreCase))}.");
            var action = (request.action ?? "list").Trim().ToLowerInvariant();
            if (action != "list" && action != "count") throw new ArgumentException("views.action must be 'list' or 'count'.");

            var candidates = rawViews.Select(v =>
            {
                var plan = v as ViewPlan;
                var level = plan?.GenLevel;
                var discipline = v.get_Parameter(BuiltInParameter.VIEW_DISCIPLINE)?.AsValueString();
                return new ViewQueryCandidate
                {
                    Id = ElementIdCompat.GetValue(v.Id),
                    Name = v.Name ?? "",
                    ViewType = v.ViewType.ToString(),
                    LevelName = level?.Name,
                    Discipline = discipline,
                    IsTemplate = v.IsTemplate
                };
            }).ToList();
            var page = ViewQueryPolicy.Apply(candidates, new ViewQueryFilter
            {
                ViewIds = request.viewIds ?? Array.Empty<long>(),
                LevelNames = request.levelNames ?? Array.Empty<string>(),
                ViewTypes = request.viewTypes ?? Array.Empty<string>(),
                Disciplines = request.disciplines ?? Array.Empty<string>(),
                ViewNames = request.viewNames ?? Array.Empty<string>(),
                NameContainsAny = request.nameContainsAny ?? Array.Empty<string>(),
                SemanticGroups = request.semanticGroups ?? Array.Empty<string>(),
                IncludeTemplates = request.includeTemplates ?? false,
                Offset = request.offset ?? 0,
                Limit = request.limit ?? 100
            });
            var byId = rawViews.ToDictionary(v => ElementIdCompat.GetValue(v.Id));
            var rows = page.Views.Select(candidate =>
            {
                var view = byId[candidate.Id];
                var templateId = ElementIdCompat.GetValue(view.ViewTemplateId);
                var template = templateId > 0 ? doc.GetElement(view.ViewTemplateId) : null;
                return new
                {
                    id = candidate.Id,
                    name = candidate.Name,
                    type = candidate.ViewType,
                    isAssembly = view.IsAssemblyView,
                    isTemplate = candidate.IsTemplate,
                    levelId = (view as ViewPlan)?.GenLevel == null ? (long?)null : ElementIdCompat.GetValue((view as ViewPlan)!.GenLevel.Id),
                    levelName = candidate.LevelName,
                    discipline = candidate.Discipline,
                    viewTemplateId = templateId > 0 ? (long?)templateId : null,
                    viewTemplateName = template?.Name,
                    canBePrinted = view.CanBePrinted
                };
            }).ToList();

            return Task.FromResult<object>(new
            {
                status = "ok",
                action,
                count = page.Total,
                returned = action == "count" ? 0 : rows.Count,
                offset = page.Offset,
                limit = page.Limit,
                truncated = page.Truncated,
                appliedFilters = page.AppliedFilters,
                views = action == "count" ? new List<object>() : rows.Cast<object>().ToList()
            });
        }
    }
}
