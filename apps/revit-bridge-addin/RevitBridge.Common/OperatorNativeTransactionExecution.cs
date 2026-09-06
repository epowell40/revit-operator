using System;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    /// <summary>
    /// Executes one native transaction. Delegates keep Revit status and exception
    /// paths executable without loading Revit in the unit-test host.
    /// </summary>
    public static class OperatorNativeTransactionExecution
    {
        public static Dictionary<string, object?> Execute(
            Func<string> start, Func<string> commit, Func<string> rollback,
            Func<string> getStatus, Func<Dictionary<string, object?>> mutate,
            Func<OperatorNativeTransactionReceipt> committedReceipt,
            Func<IEnumerable<long>>? nativeCreatedElements = null)
        {
            var result = new Dictionary<string, object?>();
            string status = "unknown";
            string? error = null;
            try
            {
                status = start();
                if (status != "Started") throw new InvalidOperationException("Native transaction did not start: " + status);
                result = mutate();
                status = commit();
                if (status != "Committed") error = "Native transaction did not commit: " + status;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                // A commit can throw after it has changed the document. Never
                // replay or blindly roll it back based on the exception alone.
                try { status = getStatus(); } catch { status = "unknown"; }
                if (status == "Started")
                {
                    try { status = rollback(); }
                    catch { status = "unknown"; }
                }
            }

            OperatorNativeTransactionReceipt receipt;
            if (status == "Committed")
            {
                receipt = committedReceipt();
                // Native creation return values remain authoritative even when
                // DocumentChanged was not observed within the handler's scope.
                if (nativeCreatedElements != null)
                    receipt = receipt.WithNativeCreatedElements(nativeCreatedElements());
            }
            else if (status == "RolledBack") receipt = OperatorNativeTransactionReceipt.RolledBack(Array.Empty<long>());
            else if (status == "Uninitialized") receipt = OperatorNativeTransactionReceipt.NotStarted();
            else receipt = OperatorNativeTransactionReceipt.Unknown(status);
            result["success"] = error == null && status == "Committed";
            result["transaction"] = receipt;
            if (error != null) result["error"] = error;
            return result;
        }
    }
}
