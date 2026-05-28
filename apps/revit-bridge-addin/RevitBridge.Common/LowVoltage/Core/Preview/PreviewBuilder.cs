using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Placement;

namespace RevitBridge.Common.LowVoltage.Core.Preview
{
    public static class PreviewBuilder
    {
        public static List<PreviewAnnotation> FromActions(IEnumerable<PlacementAction> actions)
            => actions.Select(a => new PreviewAnnotation
            {
                AnnotationType = a.ActionType == "manual_review" ? "manual_review" : "proposed_device",
                Label = $"{a.Discipline}:{(string.IsNullOrWhiteSpace(a.DeviceCategory) ? a.DeviceType : a.DeviceCategory)}",
                Location = a.Candidate.Location,
                Color = a.ActionType == "manual_review" ? "orange" : a.Approved ? "green" : "yellow",
                RelatedActionId = a.ActionId,
                RoomId = a.RoomId ?? a.Candidate.RoomId,
                GroupId = a.GroupId
            }).ToList();
    }
}
