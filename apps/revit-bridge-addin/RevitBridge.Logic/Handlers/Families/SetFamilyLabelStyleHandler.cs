using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.Annotation;

namespace RevitBridge.Logic.Handlers
{
    public sealed class SetFamilyLabelStyleHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => Task.FromResult(NativeMutationPreflightBoundary.Execute(enter => HandleCore(app, jsonData, enter)));

        private object HandleCore(UIApplication app, string jsonData, Action enter)
        {
            var p = FamilyLabelStylePolicy.Parse(jsonData);
            var session = FamilyLabelStyleAccess.RequireSession(app, p.familyDocumentId);
            var labels = FamilyLabelStyleAccess.Labels(session.FamilyDoc);
            var type = FamilyLabelStyleAccess.RequireType(session.FamilyDoc, p.labelTypeId, labels);
            if (!string.Equals(type.UniqueId, p.expectedTypeUniqueId, StringComparison.Ordinal))
                throw new InvalidOperationException("expected_type_identity_mismatch: inspect the current family session before editing.");
            var affected = labels.Where(label => label.GetTypeId() == type.Id).Select(label => ElementIdCompat.GetValue(label.Id)).ToArray();
            if (affected.Length > FamilyLabelStylePolicy.MaxAffectedLabels)
                throw new InvalidOperationException("The style affects too many family labels for this bounded operation.");
            FamilyLabelStyleAccess.RequireWritable(type, p.style);
            var before = FamilyLabelStyleAccess.Read(type);
            var planned = FamilyLabelStylePolicy.Plan(before, p);
            var changed = !FamilyLabelStylePolicy.Same(before, planned);
            var result = new Dictionary<string, object?>
            {
                ["ok"] = true, ["success"] = true, ["scope"] = "family_session",
                ["familyDocumentId"] = session.SessionId, ["sourceFamilyId"] = session.FamilyId,
                ["labelTypeId"] = p.labelTypeId, ["uniqueId"] = type.UniqueId,
                ["affectedLabelIds"] = affected, ["before"] = before, ["proposedStyle"] = planned,
                ["changed"] = changed, ["dryRun"] = p.dryRun, ["previewExecuted"] = false,
                ["projectReloadPerformed"] = false, ["loadedProjectStyleVerified"] = false
            };
            if (p.dryRun || !changed)
            {
                result["status"] = p.dryRun ? "Plan Only" : "No Change";
                result["applied"] = false; result["verified"] = !p.dryRun;
                result["familyStyleVerified"] = !p.dryRun;
                result["after"] = before;
                result["transaction"] = OperatorNativeTransactionReceipt.NotStarted(new[] { p.labelTypeId });
                return result;
            }
            enter();
            result = NativeSingleTransaction.Execute(app, session.FamilyDoc, "Operator Set Family Label Style", created =>
            {
                FamilyLabelStyleAccess.RequireSession(app, p.familyDocumentId);
                before = FamilyLabelStyleAccess.Read(type);
                planned = FamilyLabelStylePolicy.Plan(before, p);
                FamilyLabelStyleAccess.RequireWritable(type, p.style);
                FamilyLabelStyleAccess.Set(type, p.style);
                session.FamilyDoc.Regenerate();
                if (!FamilyLabelStylePolicy.Same(FamilyLabelStyleAccess.Read(type), planned))
                    throw new InvalidOperationException("Label style readback mismatch inside the transaction; rollback is required.");
                result["before"] = before; result["proposedStyle"] = planned;
                result["status"] = "Family Style Changed";
                return result;
            });
            return OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            {
                var after = FamilyLabelStyleAccess.Read(type);
                if (!FamilyLabelStylePolicy.Same(after, planned))
                    throw new InvalidOperationException("Committed family style does not match the requested change; inspect before any further edit.");
                return new Dictionary<string, object?> { ["after"] = after, ["familyStyleVerified"] = true };
            });
        }
    }
}
