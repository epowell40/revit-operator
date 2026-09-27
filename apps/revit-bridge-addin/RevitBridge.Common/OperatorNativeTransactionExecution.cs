using System;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    public enum NativeTransactionDisposition { Commit, Rollback }

    /// <summary>
    /// Executes one native transaction. Delegates keep Revit status and exception
    /// paths executable without loading Revit in the unit-test host.
    /// </summary>
    public static class OperatorNativeTransactionExecution
    {
        // Presentation follows native authority; it is never used to infer effect.
        public static string OutcomeStatus(Dictionary<string, object?> result, string committedSuccessStatus,
            string rolledBackSuccessStatus = "Dry Run")
        {
            if (!result.TryGetValue("transaction", out var raw) || !(raw is OperatorNativeTransactionReceipt receipt))
                return "UnknownEffect";
            var succeeded = result.TryGetValue("success", out var success) && success is true;
            if (receipt.CommittedValue == true) return succeeded ? committedSuccessStatus : "CommittedWithErrors";
            if (receipt.Status == "rolled_back") return succeeded ? rolledBackSuccessStatus : "Blocked";
            return receipt.Status == "not_started" ? "Blocked" : "UnknownEffect";
        }

        /// <summary>Read persisted output without losing commit authority if readback fails.</summary>
        public static Dictionary<string, object?> ReadCommitted(
            Dictionary<string, object?> result, Func<Dictionary<string, object?>> readback,
            bool requestedChangesComplete = true)
        {
            if (!result.TryGetValue("transaction", out var raw) || !(raw is OperatorNativeTransactionReceipt receipt))
                throw new InvalidOperationException("Post-commit readback requires native transaction authority.");
            result["applied"] = receipt.CommittedValue;
            result["verified"] = false;
            result["ok"] = false;
            if (receipt.Status != "committed" || receipt.CommittedValue != true) return result;
            try
            {
                var persisted = readback();
                foreach (var entry in persisted)
                {
                    if (entry.Key == "transaction" || entry.Key == "success" || entry.Key == "applied" || entry.Key == "ok" || entry.Key == "verified")
                        throw new InvalidOperationException("Readback cannot replace native outcome authority.");
                }
                foreach (var entry in persisted) result[entry.Key] = entry.Value;
                result["verified"] = requestedChangesComplete;
                result["ok"] = requestedChangesComplete && result.TryGetValue("success", out var success) && success is bool passed && passed;
            }
            catch (Exception ex)
            {
                result["success"] = false;
                result["error"] = JoinError(result.TryGetValue("error", out var prior) ? prior as string : null, ex.Message);
            }
            return result;
        }

        public static Dictionary<string, object?> Execute(
            Func<string> start, Func<string> commit, Func<string> rollback,
            Func<string> getStatus, Func<Dictionary<string, object?>> mutate,
            Func<OperatorNativeTransactionReceipt> committedReceipt,
            Func<IEnumerable<long>>? nativeCreatedElements = null,
            Func<IEnumerable<long>>? nativeModifiedElements = null,
            NativeTransactionDisposition disposition = NativeTransactionDisposition.Commit,
            Func<IEnumerable<long>>? nativeDeletedElements = null)
        {
            var result = new Dictionary<string, object?>();
            string status = "unknown";
            string? error = null;
            bool rollbackAttempted = false;
            var expectedStatus = disposition == NativeTransactionDisposition.Rollback ? "RolledBack" : "Committed";
            try
            {
                status = start();
                if (status != "Started") throw new InvalidOperationException("Native transaction did not start: " + status);
                result = mutate();
                if (disposition == NativeTransactionDisposition.Rollback)
                {
                    rollbackAttempted = true;
                    status = rollback();
                }
                else status = commit();
                if (status != expectedStatus) error = "Native transaction did not reach " + expectedStatus + ": " + status;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                // A commit can throw after it has changed the document. Never
                // replay or blindly roll it back based on the exception alone.
                try { status = getStatus(); } catch { status = "unknown"; }
                if (status == "Started" && !rollbackAttempted)
                {
                    rollbackAttempted = true;
                    try { status = rollback(); }
                    catch (Exception rollbackError)
                    {
                        error = JoinError(error, rollbackError.Message);
                        try { status = getStatus(); } catch { status = "unknown"; }
                    }
                }
            }

            OperatorNativeTransactionReceipt receipt;
            if (status == "Committed")
            {
                // Once native commit is observed, later inventory/readback errors
                // cannot turn it into an unknown effect or invite another edit.
                receipt = OperatorNativeTransactionReceipt.Committed(Array.Empty<long>());
                try
                {
                    var captured = committedReceipt();
                    if (captured == null || captured.Status != "committed" || captured.CommittedValue != true)
                        throw new InvalidOperationException("Committed inventory cannot contradict the observed native commit.");
                    receipt = captured;
                }
                catch (Exception ex) { error = JoinError(error, ex.Message); }
                // Native creation return values remain authoritative even when
                // DocumentChanged was not observed within the handler's scope.
                if (nativeCreatedElements != null)
                {
                    try { receipt = receipt.WithNativeCreatedElements(nativeCreatedElements()); }
                    catch (Exception ex) { error = JoinError(error, ex.Message); }
                }
                if (nativeModifiedElements != null)
                {
                    try { receipt = receipt.WithNativeModifiedElements(nativeModifiedElements()); }
                    catch (Exception ex) { error = JoinError(error, ex.Message); }
                }
                if (nativeDeletedElements != null)
                {
                    try { receipt = receipt.WithNativeDeletedElements(nativeDeletedElements()); }
                    catch (Exception ex) { error = JoinError(error, ex.Message); }
                }
            }
            else if (status == "RolledBack") receipt = OperatorNativeTransactionReceipt.RolledBack(Array.Empty<long>());
            else if (status == "Uninitialized") receipt = OperatorNativeTransactionReceipt.NotStarted();
            else receipt = OperatorNativeTransactionReceipt.Unknown(status);
            var businessSucceeded = !result.TryGetValue("success", out var success) || success is bool passed && passed;
            // Only an intentionally rolled-back successful preview retains its
            // transient snapshots. A failed edit or unknown result must not.
            bool completedPreview = disposition == NativeTransactionDisposition.Rollback && status == "RolledBack" && error == null;
            if (status != "Committed" && !completedPreview) result.Clear();
            result["success"] = error == null && status == expectedStatus && businessSucceeded;
            result["transaction"] = receipt;
            if (error != null) result["error"] = error;
            return result;
        }

        private static string JoinError(string? prior, string next)
            => string.IsNullOrEmpty(prior) ? next : prior + "; " + next;
    }
}
