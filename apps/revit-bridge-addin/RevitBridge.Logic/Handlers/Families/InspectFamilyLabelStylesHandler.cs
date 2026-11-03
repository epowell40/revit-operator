using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.Annotation;

namespace RevitBridge.Logic.Handlers
{
    public sealed class InspectFamilyLabelStylesHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string familyDocumentId { get; set; } = "";
            public long? labelTypeId { get; set; }
            public int maxStyles { get; set; } = 100;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new ArgumentException("An inspection request is required.");
            if (p.maxStyles < 1 || p.maxStyles > 500 || p.labelTypeId.HasValue && p.labelTypeId.Value <= 0)
                throw new ArgumentException("maxStyles must be between 1 and 500 and labelTypeId must be positive when supplied.");
            var session = FamilyLabelStyleAccess.RequireSession(app, p.familyDocumentId);
            var labels = FamilyLabelStyleAccess.Labels(session.FamilyDoc);
            var types = labels.Select(label => ElementIdCompat.GetValue(label.GetTypeId())).Distinct()
                .Where(id => id > 0 && (!p.labelTypeId.HasValue || id == p.labelTypeId.Value)).OrderBy(id => id).ToArray();
            if (p.labelTypeId.HasValue && types.Length == 0)
                throw new InvalidOperationException("No family label uses the requested labelTypeId in this session.");
            var items = types.Take(p.maxStyles).Select(id =>
            {
                var type = FamilyLabelStyleAccess.RequireType(session.FamilyDoc, id, labels);
                var usedBy = labels.Where(label => ElementIdCompat.GetValue(label.GetTypeId()) == id).Select(label => ElementIdCompat.GetValue(label.Id)).ToArray();
                return new
                {
                    labelTypeId = id, uniqueId = type.UniqueId, name = type.Name,
                    style = FamilyLabelStyleAccess.Read(type), labelCount = usedBy.Length,
                    labelIds = usedBy.Take(FamilyLabelStylePolicy.MaxAffectedLabels).ToArray(),
                    labelsComplete = usedBy.Length <= FamilyLabelStylePolicy.MaxAffectedLabels
                };
            }).ToArray();
            return Task.FromResult<object>(new
            {
                ok = true, observational = true, mutated = false, scope = "family_session",
                familyDocumentId = session.SessionId, familyName = session.FamilyName,
                sourceFamilyId = session.FamilyId, parentProjectTitle = session.ProjectDoc.Title,
                items, count = items.Length, totalStyles = types.Length, truncated = types.Length > p.maxStyles,
                loadedProjectStyleVerified = false,
                note = "These styles belong to the tracked edited family, not the effective loaded project family. No save or reload occurred."
            });
        }
    }
}
