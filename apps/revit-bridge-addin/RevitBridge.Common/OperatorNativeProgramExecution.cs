using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    // Adapter for one generated program. Outcome/rollback authority remains in
    // OperatorNativeTransactionExecution; this has no admission or replay state.
    public static class OperatorNativeProgramExecution
    {
        // Existing canonical native-effect inventory bound. This is an audit
        // capacity limit, not a model-predicted count or intended-change list.
        public const int MaximumDocumentAuditElements = 4096;
        public static void RequireSupportedHost(string? nativeProgramMode, string? runtimeMode, string? exposureProfile)
        {
            // Normal workstation execution needs no developer opt-in. Exposure
            // never replaces authenticated launcher/task admission or native
            // source/document/transaction checks. The workstation can belong to
            // a hosted deployment; it still executes locally under native authority.
            var generalHost = (string.IsNullOrEmpty(runtimeMode) || runtimeMode == "local" || runtimeMode == "self_hosted"
                || runtimeMode == "hosted" || runtimeMode == "production")
                && (string.IsNullOrEmpty(exposureProfile) || exposureProfile == "general");
            if (((string.IsNullOrEmpty(nativeProgramMode) || nativeProgramMode == "development_laboratory_v1") && generalHost)
                || OperatorNativeHttpRuntimeProfile.IsExactDevelopmentLaboratory(runtimeMode, exposureProfile)) return;
            throw new InvalidOperationException("Native program execution requires a general workstation host or the exact development/laboratory host profile.");
        }

        public static Dictionary<string, object?> ExecuteWrite(
            Func<string> start, Func<string> commitInner, Func<string> assimilate,
            Func<string> rollback, Func<string> getStatus, Func<string> program,
            Func<IEnumerable<long>> added, Func<IEnumerable<long>> modified, Func<IEnumerable<long>> deleted,
            IEnumerable<long> allowedExisting, bool allowCreate, int maximumAffected,
            bool activeDocumentScope = false, IEnumerable<long>? protectedExisting = null)
        {
            var allowed = (allowedExisting ?? throw new ArgumentNullException(nameof(allowedExisting))).ToArray();
            if (allowed.Length > 64 || allowed.Any(id => id <= 0) || allowed.Distinct().Count() != allowed.Length ||
                (!activeDocumentScope && (maximumAffected < 1 || maximumAffected > 64)) ||
                (activeDocumentScope && (maximumAffected != 0 || allowCreate || allowed.Length != 0 || protectedExisting == null)))
                throw new ArgumentException("Invalid native program effect scope.");
            var protectedIds = new HashSet<long>(protectedExisting ?? Array.Empty<long>());
            return OperatorNativeTransactionExecution.Execute(start, () =>
            {
                var status = commitInner();
                if (status != "Committed") throw new InvalidOperationException("Native program inner transaction did not commit: " + status);
                if (activeDocumentScope)
                {
                    var observed = added().Concat(modified()).Concat(deleted()).Distinct().ToArray();
                    if (observed.Length > MaximumDocumentAuditElements || observed.Any(id => id <= 0))
                        throw new InvalidOperationException("Native program change audit exceeds the supported identity/capacity bound; rollback required.");
                    if (observed.Any(protectedIds.Contains))
                        throw new InvalidOperationException("Native program changed a preexisting pinned or grouped element; rollback required.");
                    // Requested-result verification and code/intent review are
                    // separate. Revit-induced modifications are recorded, not
                    // rejected merely because no one predicted their IDs.
                }
                else
                {
                    var scope = OperatorNativeMutationScopePolicy.Evaluate(added(), modified(), deleted(), allowed, allowCreate, maximumAffected);
                    if (!scope.Allowed) throw new InvalidOperationException("Native program exceeded its admitted effects: " + scope.Code + ": " + scope.Error);
                }
                return assimilate();
            }, rollback, getStatus, () => new Dictionary<string, object?> { ["program_result"] = ValidateResult(program()) },
            () => OperatorNativeTransactionReceipt.CommittedChanges(added(), modified(), deleted()));
        }

        public static string ValidateResult(string result)
        {
            if (result == null || result.Length > 32768) throw new InvalidOperationException("Native program result is null or exceeds32768characters.");
            return result;
        }
    }
}
