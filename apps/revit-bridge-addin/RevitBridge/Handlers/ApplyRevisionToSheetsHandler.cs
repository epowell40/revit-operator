using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class ApplyRevisionToSheetsHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long? revisionId { get; set; }
            public List<long>? sheetIds { get; set; }
            public List<string>? sheetNumbers { get; set; }
            public string? query { get; set; }
            public bool? exact { get; set; }
            public int? max { get; set; }
            public bool? all { get; set; }
            public string? mode { get; set; } // append (default) | replace
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");
            if (!p.revisionId.HasValue || p.revisionId.Value <= 0) throw new InvalidOperationException("apply-revision-to-sheets.revisionId is required.");

            var revision = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.revisionId.Value)) as Revision;
            if (revision == null) throw new InvalidOperationException($"Revision {p.revisionId.Value} not found.");

            var exact = p.exact ?? false;
            var max = p.max.HasValue && p.max.Value > 0 ? Math.Min(p.max.Value, 5000) : 500;
            var all = p.all ?? false;
            var dryRun = p.dryRun ?? false;
            var mode = (p.mode ?? "append").Trim().ToLowerInvariant();
            var replace = string.Equals(mode, "replace", StringComparison.OrdinalIgnoreCase);

            var sheets = SheetSelectionHelper.ResolveSheets(
                doc,
                p.sheetIds,
                p.sheetNumbers,
                p.query,
                exact,
                max,
                all);

            if (sheets.Count == 0)
            {
                throw new InvalidOperationException("No sheets resolved. Provide sheetIds, sheetNumbers, query, or all:true.");
            }

            var plan = new List<object>(sheets.Count);
            foreach (var sheet in sheets)
            {
                var existing = GetAdditionalRevisionIds(sheet);
                var next = BuildNextIds(existing, revision.Id, replace);
                plan.Add(new
                {
                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                    sheetNumber = sheet.SheetNumber,
                    sheetName = sheet.Name,
                    existingAdditionalRevisionIds = existing.Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x)).ToList(),
                    nextAdditionalRevisionIds = next.Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x)).ToList()
                });
            }

            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    revisionId = RevitBridge.Common.ElementIdCompat.GetValue(revision.Id),
                    mode = replace ? "replace" : "append",
                    selectedCount = sheets.Count,
                    plan
                });
            }

            using (var tx = new Transaction(doc, "Apply Revision To Sheets"))
            {
                tx.Start();
                foreach (var sheet in sheets)
                {
                    var existing = GetAdditionalRevisionIds(sheet);
                    var next = BuildNextIds(existing, revision.Id, replace);
                    SetAdditionalRevisionIds(sheet, next);
                }
                tx.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                revisionId = RevitBridge.Common.ElementIdCompat.GetValue(revision.Id),
                mode = replace ? "replace" : "append",
                appliedCount = sheets.Count,
                sheets = sheets.Select(s => new
                {
                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(s.Id),
                    sheetNumber = s.SheetNumber,
                    sheetName = s.Name
                }).ToList()
            });
        }

        private static List<ElementId> BuildNextIds(List<ElementId> existing, ElementId revisionId, bool replace)
        {
            if (replace)
            {
                return new List<ElementId> { revisionId };
            }

            var outIds = new List<ElementId>(existing.Count + 1);
            var seen = new HashSet<long>();
            foreach (var id in existing)
            {
                if (id == null || RevitBridge.Common.ElementIdCompat.GetValue(id) <= 0) continue;
                if (seen.Add(RevitBridge.Common.ElementIdCompat.GetValue(id))) outIds.Add(id);
            }

            if (seen.Add(RevitBridge.Common.ElementIdCompat.GetValue(revisionId)))
            {
                outIds.Add(revisionId);
            }

            return outIds;
        }

        private static List<ElementId> GetAdditionalRevisionIds(ViewSheet sheet)
        {
            var m = typeof(ViewSheet).GetMethod("GetAdditionalRevisionIds", BindingFlags.Instance | BindingFlags.Public);
            if (m == null) return new List<ElementId>();

            var raw = m.Invoke(sheet, null);
            if (raw == null) return new List<ElementId>();

            if (raw is ICollection<ElementId> direct)
            {
                return direct.Where(x => x != null && RevitBridge.Common.ElementIdCompat.GetValue(x) > 0).ToList();
            }

            if (raw is IEnumerable enumerable)
            {
                var outIds = new List<ElementId>();
                foreach (var item in enumerable)
                {
                    if (item is ElementId id && RevitBridge.Common.ElementIdCompat.GetValue(id) > 0) outIds.Add(id);
                }
                return outIds;
            }

            return new List<ElementId>();
        }

        private static void SetAdditionalRevisionIds(ViewSheet sheet, IList<ElementId> ids)
        {
            var m = typeof(ViewSheet).GetMethod(
                "SetAdditionalRevisionIds",
                BindingFlags.Instance | BindingFlags.Public,
                null,
                new[] { typeof(ICollection<ElementId>) },
                null);

            if (m != null)
            {
                m.Invoke(sheet, new object[] { ids.ToList() });
                return;
            }

            var fallback = typeof(ViewSheet).GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .FirstOrDefault(x => x.Name == "SetAdditionalRevisionIds" && x.GetParameters().Length == 1);
            if (fallback != null)
            {
                fallback.Invoke(sheet, new object[] { ids.ToList() });
                return;
            }

            throw new InvalidOperationException("Revit API does not expose SetAdditionalRevisionIds on this version.");
        }
    }
}
