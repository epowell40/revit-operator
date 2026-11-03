using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common.Annotation
{
    public sealed class FamilyLabelStyleValues
    {
        public string? font { get; set; }
        public double? textSizeFeet { get; set; }
        public bool? bold { get; set; }
        public bool? italic { get; set; }
        public bool? underline { get; set; }
        public double? widthFactor { get; set; }
    }

    public sealed class FamilyLabelStyleChangeRequest
    {
        public string familyDocumentId { get; set; } = "";
        public long labelTypeId { get; set; }
        public string expectedTypeUniqueId { get; set; } = "";
        public FamilyLabelStyleValues style { get; set; } = new FamilyLabelStyleValues();
        public FamilyLabelStyleValues expectedStyle { get; set; } = new FamilyLabelStyleValues();
        public bool dryRun { get; set; }
    }

    public static class FamilyLabelStylePolicy
    {
        public const int MaxAffectedLabels = 500;
        private static readonly string[] StyleFields = { "font", "textSizeFeet", "bold", "italic", "underline", "widthFactor" };
        private static readonly string[] RequestFields = { "familyDocumentId", "labelTypeId", "expectedTypeUniqueId", "style", "expectedStyle", "dryRun" };

        public static FamilyLabelStyleChangeRequest Parse(string json)
        {
            using (var doc = JsonDocument.Parse(json))
            {
                RequireFields(doc.RootElement, RequestFields);
                if (!doc.RootElement.TryGetProperty("style", out var style)
                    || !doc.RootElement.TryGetProperty("expectedStyle", out var expected))
                    throw new ArgumentException("style and expectedStyle objects are required.");
                RequireFields(style, StyleFields);
                RequireFields(expected, StyleFields);
            }
            var request = JsonSerializer.Deserialize<FamilyLabelStyleChangeRequest>(json)
                ?? throw new ArgumentException("A family label style request is required.");
            Validate(request);
            return request;
        }

        public static void Validate(FamilyLabelStyleChangeRequest request)
        {
            if (!Guid.TryParseExact(request.familyDocumentId, "N", out var _))
                throw new ArgumentException("familyDocumentId must be the exact tracked family session handle.");
            if (request.labelTypeId <= 0 || string.IsNullOrWhiteSpace(request.expectedTypeUniqueId)
                || request.expectedTypeUniqueId.Length > 256)
                throw new ArgumentException("A positive labelTypeId and its current expectedTypeUniqueId are required.");
            ValidateValues(request.style);
            ValidateValues(request.expectedStyle);
            var changedFields = Values(request.style);
            var expectedFields = Values(request.expectedStyle);
            if (changedFields.Count == 0) throw new ArgumentException("At least one label style value is required.");
            foreach (var field in changedFields.Keys)
                if (!expectedFields.ContainsKey(field))
                    throw new ArgumentException("expectedStyle." + field + " is required for every requested value.");
        }

        public static FamilyLabelStyleValues Plan(FamilyLabelStyleValues current, FamilyLabelStyleChangeRequest request)
        {
            Validate(request);
            if (!Matches(current, request.expectedStyle))
                throw new InvalidOperationException("expected_style_mismatch: label style changed after inspection; no values were replaced.");
            return new FamilyLabelStyleValues
            {
                font = request.style.font ?? current.font,
                textSizeFeet = request.style.textSizeFeet ?? current.textSizeFeet,
                bold = request.style.bold ?? current.bold,
                italic = request.style.italic ?? current.italic,
                underline = request.style.underline ?? current.underline,
                widthFactor = request.style.widthFactor ?? current.widthFactor
            };
        }

        public static bool Matches(FamilyLabelStyleValues actual, FamilyLabelStyleValues expected)
        {
            var values = Values(actual);
            return Values(expected).All(pair => values.TryGetValue(pair.Key, out var observed) && EqualValue(pair.Value, observed));
        }

        public static bool EqualValue(object left, object right)
            => left is double number && right is double actualNumber
                ? Math.Abs(number - actualNumber) <= 1e-10 * Math.Max(1, Math.Abs(number)) : Equals(left, right);

        public static bool Same(FamilyLabelStyleValues left, FamilyLabelStyleValues right)
            => Values(left).Count == Values(right).Count && Matches(left, right);

        public static Dictionary<string, object> Values(FamilyLabelStyleValues style)
        {
            if (style == null) throw new ArgumentException("Style cannot be null.");
            var values = new Dictionary<string, object>();
            if (style.font != null) values.Add("font", style.font);
            if (style.textSizeFeet.HasValue) values.Add("textSizeFeet", style.textSizeFeet.Value);
            if (style.bold.HasValue) values.Add("bold", style.bold.Value);
            if (style.italic.HasValue) values.Add("italic", style.italic.Value);
            if (style.underline.HasValue) values.Add("underline", style.underline.Value);
            if (style.widthFactor.HasValue) values.Add("widthFactor", style.widthFactor.Value);
            return values;
        }

        private static void ValidateValues(FamilyLabelStyleValues style)
        {
            if (style == null) throw new ArgumentException("Style cannot be null.");
            if (style.font != null && (style.font.Length == 0 || style.font.Length > 128
                || style.font != style.font.Trim() || style.font.Any(char.IsControl)))
                throw new ArgumentException("font must be a nonempty font name without surrounding whitespace or control characters.");
            if (style.textSizeFeet.HasValue && !PositiveFinite(style.textSizeFeet.Value, 1))
                throw new ArgumentException("textSizeFeet must be positive, finite and at most one foot of paper text size.");
            if (style.widthFactor.HasValue && !PositiveFinite(style.widthFactor.Value, 100))
                throw new ArgumentException("widthFactor must be positive, finite and at most 100.");
        }

        private static bool PositiveFinite(double value, double maximum)
            => !double.IsNaN(value) && !double.IsInfinity(value) && value > 0 && value <= maximum;

        private static void RequireFields(JsonElement value, IEnumerable<string> allowed)
        {
            if (value.ValueKind != JsonValueKind.Object) throw new ArgumentException("Expected a JSON object.");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
                if (!allowed.Contains(property.Name) || !seen.Add(property.Name))
                    throw new ArgumentException("Unknown or duplicate field: " + property.Name);
        }
    }
}
