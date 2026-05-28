using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Operator;

namespace RevitBridge.Handlers
{
    public sealed class NativeCapabilitiesHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            return Task.FromResult(OperatorCapabilities.Get(app));
        }
    }

    public sealed class SpatialContextHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long? roomId { get; set; }
            public string roomName { get; set; } = "";
            public string roomNumber { get; set; } = "";
            public object? pickedPoint { get; set; }
            public string[]? categories { get; set; }
            public int? limit { get; set; }
        }

        public async Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData, RevitBridge.Operator.OperatorUiProtocol.JsonOptions) ?? new Params();
            var roomNumber = (p.roomNumber ?? "").Trim();
            if (string.IsNullOrWhiteSpace(roomNumber))
            {
                throw new System.InvalidOperationException("spatial-context currently requires roomNumber. Resolve roomName/pickedPoint with /revit/rooms first, then call again with roomNumber.");
            }

            var roomPayload = JsonSerializer.Serialize(new
            {
                action = "detail",
                roomNumber,
                includeBoundaryElementIds = true,
                spatialKindPreference = "auto"
            });
            var contentsPayload = JsonSerializer.Serialize(new
            {
                roomNumber,
                categories = p.categories,
                mode = "auto",
                verticalScope = "room+plenum",
                spatialKindPreference = "auto",
                includeLinked = true,
                limit = p.limit ?? 1000
            });
            var room = await new RoomHandler().Handle(app, roomPayload);
            var contents = await new RoomContentsHandler().Handle(app, contentsPayload);
            var uidoc = app.ActiveUIDocument;
            var doc = uidoc?.Document;
            var view = doc?.ActiveView;
            return new
            {
                schema = "operator.spatial_context.v1",
                coordinate_system = new
                {
                    model = "Revit internal XYZ feet; Z is vertical.",
                    active_view_2d = "Use export-visible-elements/export-view-frame mapping. In plan views, view right/up are exposed by the mapping payload.",
                    plan_note = "Do not infer user X/Z wording without checking active view basis and level elevation."
                },
                units = "feet",
                active_view = view == null ? null : new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    name = view.Name,
                    type = view.ViewType.ToString(),
                    scale = view.Scale
                },
                room,
                visible_elements_in_room = contents,
                next_tools = new
                {
                    model_to_view2d = "/revit/export-visible-elements",
                    view2d_to_model = "/revit/pick-at-pixel or /revit/pick-candidate-cluster",
                    nearest_wall = "/revit/get-placement-context",
                    room_wall_segments = "/revit/resolve-room-wall",
                    similar_device_ranking = "/revit/rank-similar-devices-on-wall",
                    place_similar_device = "/revit/create-similar-from-instance",
                    assign_electrical_circuit = "/revit/assign-electrical-circuit",
                    adjust_hosted_device = "/revit/adjust-hosted-instance-on-host",
                    verify = "/revit/audit-hosted-instance-placement"
                }
            };
        }
    }
}
