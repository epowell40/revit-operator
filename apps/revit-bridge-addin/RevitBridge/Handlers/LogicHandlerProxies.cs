using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    // These handlers live in `RevitBridge.Logic` but the HTTP server in `RevitBridge`
    // expects types in the `RevitBridge.Handlers` namespace.
    // Proxies keep the wire/API surface stable without duplicating implementations.

    public class AnalyzeDimensionsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.AnalyzeDimensionsHandler().Handle(app, jsonData);
    }

    public class ExportDimensioningV2Handler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ExportDimensioningV2Handler().Handle(app, jsonData);
    }

    public class CreateDimensionHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.CreateDimensionHandler().Handle(app, jsonData);
    }

    public class QuantifyElementsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.QuantifyElementsHandler().Handle(app, jsonData);
    }

    public class QuantifyVisualizeHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.QuantifyVisualizeHandler().Handle(app, jsonData);
    }

    public class EnsureSpacesHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.EnsureSpacesHandler().Handle(app, jsonData);
    }

    public class CreateZonesHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.CreateZonesHandler().Handle(app, jsonData);
    }

    public class CreateZoneVisualsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.CreateZoneVisualsHandler().Handle(app, jsonData);
    }

    public class QueryZoneDataHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.QueryZoneDataHandler().Handle(app, jsonData);
    }

    public class PlaceFamiliesHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.PlaceFamiliesHandler().Handle(app, jsonData);
    }

    public class LoadFamilyHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.LoadFamilyHandler().Handle(app, jsonData);
    }

    public class CreateFamilyFromTemplateHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.CreateFamilyFromTemplateHandler().Handle(app, jsonData);
    }

    public class TagElementsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.TagElementsHandler().Handle(app, jsonData);
    }

    public class CreateScheduleHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.CreateScheduleHandler().Handle(app, jsonData);
    }

    public class SpatialAnalysisHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.SpatialAnalysisHandler().Handle(app, jsonData);
    }

    public class DuplicateViewHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.DuplicateViewHandler().Handle(app, jsonData);
    }

    public class RoomContentsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.RoomContentsHandler().Handle(app, jsonData);
    }


    public class LocateElementsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.LocateElementsHandler().Handle(app, jsonData);
    }

    public class GetPlacementContextHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.GetPlacementContextHandler().Handle(app, jsonData);
    }

    public class ResolveRedlineTargetHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ResolveRedlineTargetHandler().Handle(app, jsonData);
    }

    public class ProposeFixHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ProposeFixHandler().Handle(app, jsonData);
    }
    public class FindElementsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.FindElementsHandler().Handle(app, jsonData);
    }

    public class UpdateParameterByQueryHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.UpdateParameterByQueryHandler().Handle(app, jsonData);
    }

    public class UpdatePanelParameterHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.UpdatePanelParameterHandler().Handle(app, jsonData);
    }

    public class AlignRoomTopsToCeilingsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.AlignRoomTopsToCeilingsHandler().Handle(app, jsonData);
    }

    // EPIC-0002: Safety primitives (Plan / Apply / Validate) + element summary ("Eyes/Hands")

    public class GetElementSummaryHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.GetElementSummaryHandler().Handle(app, jsonData);
    }

    public class TransactionPlanHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.TransactionPlanHandler().Handle(app, jsonData);
    }

    public class TransactionApplyHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.TransactionApplyHandler().Handle(app, jsonData);
    }

    public class TransactionValidateHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.TransactionValidateHandler().Handle(app, jsonData);
    }

    public class MoveElementsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MoveElementsHandler().Handle(app, jsonData);
    }

    public class RotateElementsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.RotateElementsHandler().Handle(app, jsonData);
    }

    public class AlignElementsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.AlignElementsHandler().Handle(app, jsonData);
    }

    public class MeasureGapHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MeasureGapHandler().Handle(app, jsonData);
    }

    public class RoomAlignWallToNearestColumnHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.RoomAlignWallToNearestColumnHandler().Handle(app, jsonData);
    }
}
