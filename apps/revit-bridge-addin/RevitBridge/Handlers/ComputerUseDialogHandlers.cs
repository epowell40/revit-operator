using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Operator;

namespace RevitBridge.Handlers
{
    public sealed class ComputerUseObserveHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = ComputerUseDialogHandlerJson.Parse<OperatorDialogComputerUse.ObserveParams>(jsonData);
            var service = App.Instance?.DialogComputerUse ?? throw new System.InvalidOperationException("Dialog computer-use service is not initialized.");
            return Task.FromResult(service.Observe(app, request));
        }
    }

    public sealed class ComputerUseActHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = ComputerUseDialogHandlerJson.Parse<OperatorDialogComputerUse.ActParams>(jsonData);
            var service = App.Instance?.DialogComputerUse ?? throw new System.InvalidOperationException("Dialog computer-use service is not initialized.");
            return Task.FromResult(service.Act(app, request));
        }
    }

    public sealed class ComputerUseGuardHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = ComputerUseDialogHandlerJson.Parse<OperatorDialogComputerUse.GuardParams>(jsonData);
            var service = App.Instance?.DialogComputerUse ?? throw new System.InvalidOperationException("Dialog computer-use service is not initialized.");
            return Task.FromResult(service.ArmGuard(request));
        }
    }

    internal static class ComputerUseDialogHandlerJson
    {
        internal static T? Parse<T>(string jsonData)
        {
            if (string.IsNullOrWhiteSpace(jsonData))
            {
                return default;
            }

            try
            {
                return JsonSerializer.Deserialize<T>(jsonData, OperatorUiProtocol.JsonOptions);
            }
            catch
            {
                return default;
            }
        }
    }
}
