using System.Collections.Generic;
using RevitBridge.Common.LowVoltage.Core.Geometry;

namespace RevitBridge.Common.LowVoltage.Core.Placement
{
    public class CandidatePoint
    {
        public string Id { get; set; } = string.Empty;
        public string Strategy { get; set; } = string.Empty;
        public string HostType { get; set; } = string.Empty;
        public long? HostElementId { get; set; }
        public long? RoomId { get; set; }
        public Point3 Location { get; set; } = new Point3();
        public double Score { get; set; }
        public Dictionary<string, string> Meta { get; set; } = new Dictionary<string, string>();
        public List<string> RuleTrace { get; set; } = new List<string>();
    }

    public class PlacementAction
    {
        public string ActionId { get; set; } = string.Empty;
        public string ActionType { get; set; } = "place_family_instance";
        public string Discipline { get; set; } = string.Empty;
        public string DeviceCategory { get; set; } = string.Empty;
        public string DeviceType { get; set; } = string.Empty;
        public long? FamilyTypeId { get; set; }
        public string HostPreference { get; set; } = string.Empty;
        public long? HostElementId { get; set; }
        public long? RoomId { get; set; }
        public string? GroupId { get; set; }
        public CandidatePoint Candidate { get; set; } = new CandidatePoint();
        public bool Approved { get; set; }
        public Dictionary<string, string> Meta { get; set; } = new Dictionary<string, string>();
    }

    public class PreviewAnnotation
    {
        public string AnnotationType { get; set; } = "marker";
        public string Label { get; set; } = string.Empty;
        public Point3 Location { get; set; } = new Point3();
        public string Color { get; set; } = "yellow";
        public string? RelatedActionId { get; set; }
        public long? RoomId { get; set; }
        public string? GroupId { get; set; }
        public Dictionary<string, string> Meta { get; set; } = new Dictionary<string, string>();
    }

    public class RuleViolation
    {
        public string RuleId { get; set; } = string.Empty;
        public string Severity { get; set; } = "warning";
        public string Message { get; set; } = string.Empty;
        public long? RoomId { get; set; }
        public string? CandidateId { get; set; }
        public string? GroupId { get; set; }
        public Dictionary<string, string> Meta { get; set; } = new Dictionary<string, string>();
    }

    public class ReviewItem
    {
        public string Code { get; set; } = string.Empty;
        public string Severity { get; set; } = "warning";
        public string Message { get; set; } = string.Empty;
        public long? RoomId { get; set; }
        public string? GroupId { get; set; }
        public string? CandidateId { get; set; }
        public Dictionary<string, string> Meta { get; set; } = new Dictionary<string, string>();
    }

    public class LayoutResult
    {
        public List<PlacementAction> ProposedActions { get; set; } = new List<PlacementAction>();
        public List<PreviewAnnotation> Preview { get; set; } = new List<PreviewAnnotation>();
        public List<RuleViolation> Violations { get; set; } = new List<RuleViolation>();
        public List<ReviewItem> ManualReviews { get; set; } = new List<ReviewItem>();
        public List<string> Assumptions { get; set; } = new List<string>();
    }
}
