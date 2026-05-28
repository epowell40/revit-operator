using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class WorksetsHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? action { get; set; } // list (default) | create | set_active
            public string? name { get; set; } // create
            public long? worksetId { get; set; } // set_active
            public string? worksetName { get; set; } // set_active
            public bool? activateAfterCreate { get; set; } // create
            public int? max { get; set; } // list cap
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var action = NormalizeAction(p.action);
            if (!doc.IsWorkshared)
            {
                return Task.FromResult<object>(new
                {
                    status = "Skipped",
                    action,
                    message = "Model is not workshared."
                });
            }

            return action switch
            {
                "list" => Task.FromResult<object>(ListWorksets(doc, p)),
                "create" => Task.FromResult<object>(CreateWorkset(doc, p)),
                "set_active" => Task.FromResult<object>(SetActiveWorkset(doc, p)),
                _ => throw new InvalidOperationException("worksets.action must be list, create, or set_active.")
            };
        }

        private static object ListWorksets(Document doc, Params p)
        {
            var max = p.max.GetValueOrDefault(500);
            if (max < 1) max = 1;
            if (max > 5000) max = 5000;

            var worksets = GetUserWorksets(doc)
                .OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
                .Take(max)
                .ToList();

            var activeId = doc.GetWorksetTable().GetActiveWorksetId();
            return new
            {
                status = "Ok",
                action = "list",
                count = worksets.Count,
                max,
                activeWorkset = worksets
                    .Where(x => x.Id == activeId)
                    .Select(x => new { id = x.Id.IntegerValue, name = x.Name })
                    .FirstOrDefault(),
                items = worksets.Select(x => new
                {
                    id = x.Id.IntegerValue,
                    name = x.Name,
                    isOpen = x.IsOpen,
                    isDefault = x.IsDefaultWorkset
                }).ToList()
            };
        }

        private static object CreateWorkset(Document doc, Params p)
        {
            var requested = (p.name ?? "").Trim();
            if (string.IsNullOrWhiteSpace(requested))
                throw new InvalidOperationException("worksets.create requires name.");

            var activateAfterCreate = p.activateAfterCreate ?? false;
            var existing = GetUserWorksets(doc)
                .FirstOrDefault(x => string.Equals(x.Name, requested, StringComparison.OrdinalIgnoreCase));

            if (existing != null)
            {
                return new
                {
                    status = "AlreadyExists",
                    action = "create",
                    workset = new { id = existing.Id.IntegerValue, name = existing.Name },
                    activateAfterCreate
                };
            }

            if (p.dryRun ?? false)
            {
                return new
                {
                    status = "Dry Run",
                    action = "create",
                    dryRun = true,
                    plan = new
                    {
                        name = requested,
                        activateAfterCreate
                    }
                };
            }

            Workset created;
            using (var tx = new Transaction(doc, "Create Workset"))
            {
                tx.Start();
                created = Workset.Create(doc, requested);
                if (activateAfterCreate)
                {
                    doc.GetWorksetTable().SetActiveWorksetId(created.Id);
                }
                tx.Commit();
            }

            var active = doc.GetWorksetTable().GetActiveWorksetId();
            return new
            {
                status = "Success",
                action = "create",
                workset = new { id = created.Id.IntegerValue, name = created.Name },
                activeWorksetId = active.IntegerValue
            };
        }

        private static object SetActiveWorkset(Document doc, Params p)
        {
            var target = ResolveWorkset(doc, p.worksetId, p.worksetName);
            if (target == null)
                throw new InvalidOperationException("worksets.set_active requires worksetId or worksetName.");

            if (p.dryRun ?? false)
            {
                return new
                {
                    status = "Dry Run",
                    action = "set_active",
                    dryRun = true,
                    target = new { id = target.Id.IntegerValue, name = target.Name }
                };
            }

            using (var tx = new Transaction(doc, "Set Active Workset"))
            {
                tx.Start();
                doc.GetWorksetTable().SetActiveWorksetId(target.Id);
                tx.Commit();
            }

            var active = doc.GetWorksetTable().GetActiveWorksetId();
            return new
            {
                status = "Success",
                action = "set_active",
                activeWorkset = new { id = active.IntegerValue, name = doc.GetWorksetTable().GetWorkset(active)?.Name }
            };
        }

        private static string NormalizeAction(string? action)
        {
            var value = (action ?? "list").Trim().ToLowerInvariant();
            return value switch
            {
                "list" => "list",
                "create" => "create",
                "setactive" => "set_active",
                "set_active" => "set_active",
                _ => value
            };
        }

        private static List<Workset> GetUserWorksets(Document doc)
        {
            return new FilteredWorksetCollector(doc)
                .OfKind(WorksetKind.UserWorkset)
                .ToWorksets()
                .Where(x => x != null)
                .ToList();
        }

        private static Workset? ResolveWorkset(Document doc, long? worksetId, string? worksetName)
        {
            var worksets = GetUserWorksets(doc);

            if (worksetId.HasValue && worksetId.Value > 0)
            {
                return worksets.FirstOrDefault(x => x.Id.IntegerValue == (int)worksetId.Value);
            }

            var name = (worksetName ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(name))
            {
                return worksets.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
            }

            return null;
        }
    }
}
