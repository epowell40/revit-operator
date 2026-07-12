using System.Collections.Generic;

namespace RevitBridge.Common.LowVoltage.Skills.DwellingReceptacles
{
    public sealed class DwellingReceptacleProfile
    {
        public string ProfileId { get; set; } = "DWELLING-RECEPTACLES-V1";
        public string Version { get; set; } = "1.0.0";
        public string DisplayName { get; set; } = "Office Standard - Dwelling Receptacles";
        public string RuleBasis { get; set; } = "NEC-derived dwelling-unit general wall-space geometry, adopted as an office-standard proposal for professional review.";
        public string ReferenceEdition { get; set; } = "NFPA 70 (NEC) 2023";
        public List<string> ReferenceSections { get; set; } = new List<string> { "210.52(A)" };
        public double MinimumWallSpaceWidthFt { get; set; } = 2.0;
        public double MaximumFloorLineDistanceToReceptacleFt { get; set; } = 6.0;
        public double MaximumReceptacleSpacingFt { get; set; } = 12.0;
        public double DefaultMountingHeightAffFt { get; set; } = 1.5;
        public double DuplicateToleranceFt { get; set; } = 1.0;
        public double OpeningClearanceFt { get; set; } = 0.0;
        public string PreferredDeviceFamilyIntent { get; set; } = "duplex receptacle";
        public string CircuitPolicy { get; set; } = "Do not create or infer a circuit in V1. Preserve an existing source circuit only when explicitly requested and deterministically verified.";
        public string ComplianceDisclaimer { get; set; } = "Project-standard proposal for professional review; this is not a jurisdictional code-compliance determination.";
        public List<string> SupportedRoomClassifications { get; set; } = new List<string>
        {
            "bedroom",
            "family_room",
            "dining_room",
            "living_room",
            "parlor",
            "library",
            "den",
            "sunroom",
            "recreation_room",
            "live_work_unit",
            "similar_dwelling_area"
        };
        public List<string> ManualReviewClassifications { get; set; } = new List<string>
        {
            "kitchen",
            "countertop",
            "island",
            "peninsula",
            "bathroom",
            "laundry",
            "hallway",
            "closet",
            "garage",
            "exterior",
            "outdoor",
            "floor_receptacle"
        };
    }
}
