using System;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common.LowVoltage.Skills.DwellingReceptacles
{
    public static class DwellingReceptacleProfileSerializer
    {
        private static readonly JsonSerializerOptions ReadOptions = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        };

        private static readonly JsonSerializerOptions WriteOptions = new JsonSerializerOptions
        {
            WriteIndented = true
        };

        public static DwellingReceptacleProfile Deserialize(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) throw new ArgumentException("Profile JSON is required.", nameof(json));
            var profile = JsonSerializer.Deserialize<DwellingReceptacleProfile>(json, ReadOptions)
                ?? throw new ArgumentException("Profile JSON did not produce a profile.", nameof(json));
            Validate(profile);
            return profile;
        }

        public static string Serialize(DwellingReceptacleProfile profile)
        {
            if (profile == null) throw new ArgumentNullException(nameof(profile));
            Validate(profile);
            return JsonSerializer.Serialize(profile, WriteOptions);
        }

        public static void Validate(DwellingReceptacleProfile profile)
        {
            if (!string.Equals(profile.ProfileId, "DWELLING-RECEPTACLES-V1", StringComparison.Ordinal))
                throw new ArgumentException("Unsupported dwelling receptacle profile id.");
            if (string.IsNullOrWhiteSpace(profile.Version)) throw new ArgumentException("Profile version is required.");
            if (string.IsNullOrWhiteSpace(profile.ComplianceDisclaimer) || profile.ComplianceDisclaimer.IndexOf("not", StringComparison.OrdinalIgnoreCase) < 0)
                throw new ArgumentException("A non-compliance disclaimer is required.");
            if (profile.MinimumWallSpaceWidthFt <= 0) throw new ArgumentOutOfRangeException(nameof(profile.MinimumWallSpaceWidthFt));
            if (profile.MaximumFloorLineDistanceToReceptacleFt <= 0) throw new ArgumentOutOfRangeException(nameof(profile.MaximumFloorLineDistanceToReceptacleFt));
            if (profile.MaximumReceptacleSpacingFt <= 0 || profile.MaximumReceptacleSpacingFt > profile.MaximumFloorLineDistanceToReceptacleFt * 2.0)
                throw new ArgumentOutOfRangeException(nameof(profile.MaximumReceptacleSpacingFt));
            if (profile.DefaultMountingHeightAffFt < 0 || profile.DefaultMountingHeightAffFt > 10)
                throw new ArgumentOutOfRangeException(nameof(profile.DefaultMountingHeightAffFt));
            if (profile.DuplicateToleranceFt < 0 || profile.DuplicateToleranceFt > profile.MaximumFloorLineDistanceToReceptacleFt)
                throw new ArgumentOutOfRangeException(nameof(profile.DuplicateToleranceFt));
            if (profile.SupportedRoomClassifications == null || !profile.SupportedRoomClassifications.Any())
                throw new ArgumentException("At least one supported room classification is required.");
            if (profile.ManualReviewClassifications == null || !profile.ManualReviewClassifications.Any())
                throw new ArgumentException("At least one manual-review classification is required.");
        }
    }
}
