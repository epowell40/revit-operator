using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace RevitBridge.Common
{
    /// <summary>The existing native dispatcher owns authorization/deadline and
    /// passes its cancellation token. This interface grants no UI-input rights.</summary>
    public interface IInteractiveRequestHandler : IRequestHandler
    {
        Task<object> HandleInteractive(UIApplication app, string jsonData, CancellationToken cancellationToken);
    }
}
