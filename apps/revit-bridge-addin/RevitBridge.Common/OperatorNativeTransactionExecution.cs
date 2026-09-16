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
        /// <summary>Read persisted output without losing commit authority if readback fails.</summary>
        public static Dictionary<string, object?> ReadCommitted(
            Dictionary<string, object?> result, Func<Dictionary<string, object?>> readback)
        {
            if (!result.TryGetValue("transaction", out var raw) || !(raw is OperatorNativeTransactionReceipt receipt))
                throw new InvalidOperationException("Post-commit readback requires native transaction authority.");
            result["applied"] = receipt.CommittedValue;
            result["verified"] = false;
            result["ok"] = false;
            if (receipt.Status != "committed" || receipt.CommittedValue != true) return result;
            try
            {
                foreach (var entry in readback())
                {
                    if (entry.Key == "transaction" || entry.Key == "success" || entry.Key == "applied" || entry.Key == "ok" || entry.Key == "verified")
                        throw new InvalidOperationException("Readback cannot replace native outcome authority.");
                    result[entry.Key] = entry.Value;
                }
                result["verified"] = true;
                result["ok"] = result.TryGetValue("success", out var success) && success is bool passed && passed;
            }
            catch (Exception ex)
            {
                result["success"] = false;
                result["error"] = ex.Message;
            }
            return result;
        }

        public static Dictionary<string, object?> Execute(
            Func<string> start, Func<string> commit, Func<string> rollback,
            Func<string> getStatus, Func<Dictionary<string, object?>> mutate,
            Func<OperatorNativeTransactionReceipt> committedReceipt,
            Func<IEnumerable<long>>? nativeCreatedElements = null,
            Func<IEnumerable<long>>? nativeModifiedElements = null)
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
                if (nativeModifiedElements != null)
                    receipt = receipt.WithNativeModifiedElements(nativeModifiedElements());
            }
            else if (status == "RolledBack") receipt = OperatorNativeTransactionReceipt.RolledBack(Array.Empty<long>());
            else if (status == "Uninitialized") receipt = OperatorNativeTransactionReceipt.NotStarted();
            else receipt = OperatorNativeTransactionReceipt.Unknown(status);
            // A handler's in-transaction readback cannot describe the persisted
            // document after rollback or while the native outcome is pending.
            if (status != "Committed") result.Clear();
            result["success"] = error == null && status == "Committed";
            result["transaction"] = receipt;
            if (error != null) result["error"] = error;
            return result;
        }
    }
}
