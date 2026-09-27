using System;
using System.Collections.Generic;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>Only code before the caller enters native execution can prove no transaction started.</summary>
    public static class NativeMutationPreflightBoundary
    {
        public static object Execute(Func<Action, object> run)
        {
            var nativeScopeEntered = false;
            try { return run(() => nativeScopeEntered = true); }
            catch (Exception error) when (!nativeScopeEntered)
            {
                var result = new Dictionary<string, object?>
                {
                    ["status"] = "Blocked", ["success"] = false,
                    ["applied"] = false, ["error"] = error.Message,
                    ["transaction"] = OperatorNativeTransactionReceipt.NotStarted()
                };
                if (error is OperatorToolUserErrorException userError)
                {
                    result["code"] = userError.Code;
                    result["requiredConfirm"] = userError.RequiredConfirm;
                    result["confirmReceived"] = userError.ConfirmReceived;
                    result["maxChangesPerCall"] = userError.MaxChangesPerCall;
                    result["hint"] = userError.Hint;
                }
                return result;
            }
        }
    }
}
