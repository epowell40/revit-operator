using System;
using Autodesk.Revit.UI;

namespace RevitBridge.Common
{
    public interface ILogicService
    {
        bool CanHandle(string path);
        object Handle(string path, string body, UIApplication app);
    }
}