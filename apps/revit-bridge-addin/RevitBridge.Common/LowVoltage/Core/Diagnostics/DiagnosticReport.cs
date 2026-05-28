using System.Collections.Generic;
using RevitBridge.Common.LowVoltage.Core.Placement;

namespace RevitBridge.Common.LowVoltage.Core.Diagnostics
{
    public class ClassifiedSpaceDiagnostic
    {
        public long RoomId { get; set; }
        public string Bucket { get; set; } = string.Empty;
        public string Source { get; set; } = string.Empty;
        public bool OpenToCorridor { get; set; }
        public string? GroupId { get; set; }
    }

    public class LayoutGroupDiagnostic
    {
        public string GroupId { get; set; } = string.Empty;
        public string GroupType { get; set; } = string.Empty;
        public List<long> RoomIds { get; set; } = new List<long>();
    }

    public class CandidateRejectionDiagnostic
    {
        public string CandidateId { get; set; } = string.Empty;
        public string Reason { get; set; } = string.Empty;
        public long? RoomId { get; set; }
    }

    public class ProposedDeviceDiagnostic
    {
        public string ActionId { get; set; } = string.Empty;
        public string DeviceCategory { get; set; } = string.Empty;
        public string DeviceType { get; set; } = string.Empty;
        public long? RoomId { get; set; }
        public string? GroupId { get; set; }
        public long? FamilyTypeId { get; set; }
    }

    public class DetectedElementDiagnostic
    {
        public long ElementId { get; set; }
        public string ElementKind { get; set; } = string.Empty;
        public string SemanticType { get; set; } = string.Empty;
        public long? RoomId { get; set; }
    }

    public class AnchorDiagnostic
    {
        public string AnchorId { get; set; } = string.Empty;
        public string AnchorKind { get; set; } = string.Empty;
        public long SourceElementId { get; set; }
        public long? RoomId { get; set; }
        public string HostPreference { get; set; } = string.Empty;
        public bool ReviewRequired { get; set; }
    }

    public class EndpointRequirementDiagnostic
    {
        public long ElementId { get; set; }
        public string ElementKind { get; set; } = string.Empty;
        public string EndpointClass { get; set; } = string.Empty;
        public long? RoomId { get; set; }
        public string DeviceCategory { get; set; } = string.Empty;
        public bool RequiresOutlet { get; set; }
    }

    public class SkippedElementDiagnostic
    {
        public long ElementId { get; set; }
        public string ElementKind { get; set; } = string.Empty;
        public string SemanticType { get; set; } = string.Empty;
        public long? RoomId { get; set; }
        public string Reason { get; set; } = string.Empty;
    }

    public class DiagnosticReport
    {
        public List<string> Assumptions { get; set; } = new List<string>();
        public List<string> MissingFamilyTypes { get; set; } = new List<string>();
        public List<long> SkippedRooms { get; set; } = new List<long>();
        public List<string> UnknownRoomClassifications { get; set; } = new List<string>();
        public List<string> HostFailures { get; set; } = new List<string>();
        public List<RuleViolation> RuleViolations { get; set; } = new List<RuleViolation>();
        public List<ClassifiedSpaceDiagnostic> ClassifiedSpaces { get; set; } = new List<ClassifiedSpaceDiagnostic>();
        public List<LayoutGroupDiagnostic> GroupsFormed { get; set; } = new List<LayoutGroupDiagnostic>();
        public List<CandidateRejectionDiagnostic> RejectedCandidates { get; set; } = new List<CandidateRejectionDiagnostic>();
        public List<ProposedDeviceDiagnostic> ProposedDevices { get; set; } = new List<ProposedDeviceDiagnostic>();
        public List<ReviewItem> ManualReviews { get; set; } = new List<ReviewItem>();
        public List<DetectedElementDiagnostic> FixturesDetected { get; set; } = new List<DetectedElementDiagnostic>();
        public List<AnchorDiagnostic> AnchorsUsed { get; set; } = new List<AnchorDiagnostic>();
        public List<string> UnknownFixtureMappings { get; set; } = new List<string>();
        public List<DetectedElementDiagnostic> DetectedEndpoints { get; set; } = new List<DetectedElementDiagnostic>();
        public List<EndpointRequirementDiagnostic> RequiredEndpoints { get; set; } = new List<EndpointRequirementDiagnostic>();
        public List<SkippedElementDiagnostic> SkippedEndpoints { get; set; } = new List<SkippedElementDiagnostic>();
        public List<string> UnknownEndpointMappings { get; set; } = new List<string>();
    }
}
