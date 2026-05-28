using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace RevitBridge.Common
{
    public interface IRequestHandler
    {
        Task<object> Handle(UIApplication app, string jsonData);
    }
}