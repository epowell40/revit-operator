using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.Drafting;
using RevitBridge.Logic.Handlers.MEP;

namespace RevitBridge.Logic.Handlers
{
    // Compatibility entry point: the route engine owns native type resolution,
    // size/geometry verification, and observed commit/rollback receipts.
    public class CreateDuctHandler : IRequestHandler
    {
        public class Params
        {
            public string? levelName { get; set; }
            [System.ComponentModel.DefaultValue(0d)]
            public double startX { get; set; }
            [System.ComponentModel.DefaultValue(0d)]
            public double startY { get; set; }
            [System.ComponentModel.DefaultValue(0d)]
            public double startZ { get; set; }
            [System.ComponentModel.DefaultValue(0d)]
            public double endX { get; set; }
            [System.ComponentModel.DefaultValue(0d)]
            public double endY { get; set; }
            [System.ComponentModel.DefaultValue(0d)]
            public double endZ { get; set; }
            public string systemType { get; set; } = "Supply Air";
            public string? ductType { get; set; }
            public long? ductTypeId { get; set; }
            public string? ductShape { get; set; }
            public long? levelId { get; set; }
            public string? frameId { get; set; }
            public DraftPoint? startPoint { get; set; }
            public DraftPoint? endPoint { get; set; }
            public string? ductSize { get; set; } // e.g. "10x12" or "12"
            public string? width { get; set; } // optional explicit width
            public string? height { get; set; } // optional explicit height
            public string? diameter { get; set; } // optional explicit diameter
            public bool dryRun { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            string routeRequest;
            try
            {
                var p = JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
                var start = p.startPoint?.Resolve(p.frameId) ?? new XYZ(p.startX, p.startY, p.startZ);
                var end = p.endPoint?.Resolve(p.frameId) ?? new XYZ(p.endX, p.endY, p.endZ);
                var size = MepRouteSizeInputPolicy.ResolveSingleDuctSize(p.ductSize, p.width, p.height, p.diameter);
                routeRequest = JsonSerializer.Serialize(new {
                    kind = "duct",
                    points = new[] { new { xyz = new[] { start.X, start.Y, start.Z } }, new { xyz = new[] { end.X, end.Y, end.Z } } },
                    p.levelName, p.levelId, p.systemType, p.ductType, p.ductTypeId, p.ductShape,
                    ductSize = size, sizePolicy = "explicit_required", elevationPolicy = "explicit_required",
                    connectSegments = false, connectToExisting = false, requireExistingEndpointConnections = false,
                    verify = true, p.dryRun
                });
            }
            catch (Exception ex)
            {
                return Task.FromResult<object>(new { status = "Blocked", transaction = OperatorNativeTransactionReceipt.NotStarted(), error = ex.Message });
            }
            // Do not catch/reclassify a route transaction failure as not-started.
            return new CreateMepRouteHandler().Handle(app, routeRequest);
        }
    }
}
