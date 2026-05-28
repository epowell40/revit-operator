using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Operator;

namespace RevitBridge.Handlers
{
    public sealed class SelfTestHandler : IRequestHandler
    {
        private sealed class Params
        {
            public bool? include_export_image { get; set; }
            public bool? include_rooms { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData, OperatorUiProtocol.JsonOptions) ?? new Params());
            var includeExport = p.include_export_image ?? true;
            var includeRooms = p.include_rooms ?? true;

            var checks = new List<object>();
            var okAll = true;

            void Add(string id, bool ok, object? details = null, string? error = null)
            {
                if (!ok) okAll = false;
                checks.Add(new
                {
                    id,
                    ok,
                    error,
                    details
                });
            }

            try
            {
                var uidoc = app.ActiveUIDocument;
                if (uidoc == null)
                {
                    Add("revit.uidoc", ok: false, error: "No active UI document.");
                    return Task.FromResult<object>(new { status = "fail", checks });
                }

                var doc = uidoc.Document;
                Add("revit.document", ok: doc != null, details: new { title = doc?.Title });

                try
                {
                    var views = new FilteredElementCollector(doc)
                        .OfClass(typeof(View))
                        .ToElements();
                    Add("views.list", ok: views != null, details: new { count = views?.Count ?? 0 });
                }
                catch (Exception ex)
                {
                    Add("views.list", ok: false, error: ex.Message);
                }

                try
                {
                    var caps = OperatorCapabilities.Get();
                    Add("capabilities.get", ok: true, details: new { version = OperatorCapabilities.Version });
                }
                catch (Exception ex)
                {
                    Add("capabilities.get", ok: false, error: ex.Message);
                }

                if (includeRooms)
                {
                    try
                    {
                        var roomsRes = new RevitBridge.Logic.Handlers.RoomHandler().Handle(app, "{\"action\":\"list\",\"max\":3}").GetAwaiter().GetResult();
                        Add("rooms.list", ok: true, details: new { note = "ok", sample = roomsRes });
                    }
                    catch (Exception ex)
                    {
                        Add("rooms.list", ok: false, error: ex.Message);
                    }
                }

                if (includeExport)
                {
                    try
                    {
                        var imgRes = new ExportViewImageHandler().Handle(app, "{\"imageSize\":800}").GetAwaiter().GetResult();
                        Add("export-image", ok: true, details: imgRes);
                    }
                    catch (Exception ex)
                    {
                        Add("export-image", ok: false, error: ex.Message);
                    }
                }
            }
            catch (Exception ex)
            {
                Add("self-test", ok: false, error: ex.Message);
            }

            return Task.FromResult<object>(new
            {
                status = okAll ? "pass" : "fail",
                generated_at = DateTime.UtcNow.ToString("o"),
                checks
            });
        }
    }
}

