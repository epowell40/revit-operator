using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class ResolveMepRoutingContextHandler : IRequestHandler
    {
        public sealed class Params : MepRoutingUtil.RoutingContextRequest
        {
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();

            var doc = app.ActiveUIDocument.Document;
            var ctx = MepRoutingUtil.ResolveRoutingContext(doc, app, p);
            return Task.FromResult(ctx.ToResponse("Ok"));
        }
    }
}
