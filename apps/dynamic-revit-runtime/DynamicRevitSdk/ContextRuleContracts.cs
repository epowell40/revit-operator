using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace RevitOperator.DynamicRevitSdk;

public static class DynamicContextRuleContractV1
{
    public const string RecordSchema = "dynamic-revit-context-rule-record/v1";
    public const string BindingSchema = "dynamic-revit-context-rule-binding/v1";
    public const string CanonicalVersion = "dynamic-revit-context-rule-canonical/v1";
    public const int MaximumConditions = 8;
    public const int MaximumCategories = 32;
}

public sealed class DynamicContextRuleConditionV1
{
    public string ParameterName { get; set; } = "";
    public string ParameterIdentity { get; set; } = "";
    public string ParameterScope { get; set; } = "instance";
    public string Operator { get; set; } = "equals";
    public string ValueKind { get; set; } = "string";
    public string RawValue { get; set; } = "";
}

public sealed class DynamicContextRuleActionV1
{
    public string Kind { get; set; } = "set_parameter";
    public string ParameterName { get; set; } = "";
    public string ParameterIdentity { get; set; } = "";
    public string ParameterScope { get; set; } = "instance";
    public string ValueKind { get; set; } = "string";
    public string RawValue { get; set; } = "";
    public string? SpecTypeId { get; set; }
    public string? UnitTypeId { get; set; }
}

public sealed class DynamicContextRuleRecordV1
{
    public string Schema { get; set; } = DynamicContextRuleContractV1.RecordSchema;
    public string RecordId { get; set; } = "";
    public string CompanyId { get; set; } = "";
    public string ProjectFingerprint { get; set; } = "";
    public string UserId { get; set; } = "";
    public long ActiveViewElementId { get; set; }
    public IReadOnlyList<string> TargetCategoryStableIds { get; set; } = Array.Empty<string>();
    public IReadOnlyList<DynamicContextRuleConditionV1> Conditions { get; set; } = Array.Empty<DynamicContextRuleConditionV1>();
    public DynamicContextRuleActionV1 Action { get; set; } = new();
    public long IssuedUnixSeconds { get; set; }
    public long ExpiresUnixSeconds { get; set; }
    public string RecordHash { get; set; } = "";
    public string Signature { get; set; } = "";
}

/// <summary>Verified rule and observation identity visible to generated reasoning; no verification secret or signature enters the worker.</summary>
public sealed class DynamicVerifiedContextRuleV1
{
    public string Schema { get; set; } = DynamicContextRuleContractV1.BindingSchema;
    public string RecordId { get; set; } = "";
    public string RecordHash { get; set; } = "";
    public string CompanyId { get; set; } = "";
    public string ProjectFingerprint { get; set; } = "";
    public string UserId { get; set; } = "";
    public long ActiveViewElementId { get; set; }
    public IReadOnlyList<string> TargetCategoryStableIds { get; set; } = Array.Empty<string>();
    public IReadOnlyList<DynamicContextRuleConditionV1> Conditions { get; set; } = Array.Empty<DynamicContextRuleConditionV1>();
    public DynamicContextRuleActionV1 Action { get; set; } = new();
    public long IssuedUnixSeconds { get; set; }
    public long ExpiresUnixSeconds { get; set; }
    public string VerificationKeyHash { get; set; } = "";
    public string WorkerRuntimePackageHash { get; set; } = "";
    public string ObservationScopeHash { get; set; } = "";
    public string ObservationRevisionHash { get; set; } = "";
    public string BindingHash { get; set; } = "";
}

public static class DynamicContextRulePolicyV1
{
    public static string RecordHash(DynamicContextRuleRecordV1 value)
    {
        ValidateRecord(value, false);
        return DynamicWire.Sha256(DynamicCanonical.Join(DynamicContextRuleContractV1.CanonicalVersion, value.Schema,
            value.RecordId, value.CompanyId, value.ProjectFingerprint, value.UserId, value.ActiveViewElementId.ToString(CultureInfo.InvariantCulture),
            DynamicCanonical.Set(value.TargetCategoryStableIds), string.Join("\n", value.Conditions.Select(ConditionCanonical)), ActionCanonical(value.Action),
            value.IssuedUnixSeconds.ToString(CultureInfo.InvariantCulture), value.ExpiresUnixSeconds.ToString(CultureInfo.InvariantCulture)));
    }

    public static string BindingHash(DynamicVerifiedContextRuleV1 value)
    {
        ValidateBinding(value, false);
        return DynamicWire.Sha256(DynamicCanonical.Join(DynamicContextRuleContractV1.CanonicalVersion, value.Schema,
            value.RecordId, value.RecordHash, value.CompanyId, value.ProjectFingerprint, value.UserId, value.ActiveViewElementId.ToString(CultureInfo.InvariantCulture),
            DynamicCanonical.Set(value.TargetCategoryStableIds), string.Join("\n", value.Conditions.Select(ConditionCanonical)), ActionCanonical(value.Action),
            value.IssuedUnixSeconds.ToString(CultureInfo.InvariantCulture), value.ExpiresUnixSeconds.ToString(CultureInfo.InvariantCulture),
            value.VerificationKeyHash, value.WorkerRuntimePackageHash, value.ObservationScopeHash, value.ObservationRevisionHash));
    }

    public static void ValidateRecord(DynamicContextRuleRecordV1 value, bool requireHashAndSignature = true)
    {
        if (value == null || value.Schema != DynamicContextRuleContractV1.RecordSchema) throw new ArgumentException("Context rule record schema is invalid.");
        ValidateCommon(value.RecordId, value.CompanyId, value.ProjectFingerprint, value.UserId, value.ActiveViewElementId,
            value.TargetCategoryStableIds, value.Conditions, value.Action, value.IssuedUnixSeconds, value.ExpiresUnixSeconds);
        if (requireHashAndSignature && (value.RecordHash != RecordHash(value) || !DynamicCanonical.Hash(value.RecordHash) ||
            string.IsNullOrWhiteSpace(value.Signature) || value.Signature.Length > 512)) throw new ArgumentException("Context rule record hash or signature is invalid.");
    }

    public static void ValidateBinding(DynamicVerifiedContextRuleV1 value, bool requireHash = true)
    {
        if (value == null || value.Schema != DynamicContextRuleContractV1.BindingSchema) throw new ArgumentException("Verified context rule binding schema is invalid.");
        ValidateCommon(value.RecordId, value.CompanyId, value.ProjectFingerprint, value.UserId, value.ActiveViewElementId,
            value.TargetCategoryStableIds, value.Conditions, value.Action, value.IssuedUnixSeconds, value.ExpiresUnixSeconds);
        DynamicCanonical.RequireHashes(value.RecordHash, value.VerificationKeyHash, value.WorkerRuntimePackageHash, value.ObservationScopeHash, value.ObservationRevisionHash);
        if (requireHash && (!DynamicCanonical.Hash(value.BindingHash) || value.BindingHash != BindingHash(value))) throw new ArgumentException("Verified context rule binding hash is invalid.");
    }

    private static void ValidateCommon(string recordId, string companyId, string project, string userId, long activeView,
        IReadOnlyList<string> categories, IReadOnlyList<DynamicContextRuleConditionV1> conditions, DynamicContextRuleActionV1 action, long issued, long expires)
    {
        if (!DynamicCanonical.Id(recordId, 240) || !DynamicCanonical.Id(companyId, 240) || !DynamicCanonical.Hash(project) || !DynamicCanonical.Id(userId, 240) ||
            activeView < 0 || categories == null || categories.Count < 1 || categories.Count > DynamicContextRuleContractV1.MaximumCategories ||
            categories.Any(value => !DynamicCanonical.Id(value, 256)) || categories.Distinct(StringComparer.Ordinal).Count() != categories.Count ||
            conditions == null || conditions.Count < 1 || conditions.Count > DynamicContextRuleContractV1.MaximumConditions || action == null ||
            issued < 0 || expires <= issued || expires - issued > 86400) throw new ArgumentException("Context rule scope, lifetime, or bounds are invalid.");
        foreach (var condition in conditions) ValidateCondition(condition);
        ValidateAction(action);
    }

    private static void ValidateCondition(DynamicContextRuleConditionV1 value)
    {
        if (value == null || !DynamicCanonical.Id(value.ParameterName, 256) || !DynamicCanonical.Id(value.ParameterIdentity, 256) ||
            value.ParameterScope != "instance" && value.ParameterScope != "type" ||
            !new[] { "equals", "not_equals", "contains", "starts_with", "ends_with" }.Contains(value.Operator, StringComparer.Ordinal) ||
            !new[] { "string", "integer", "double", "element_id" }.Contains(value.ValueKind, StringComparer.Ordinal) || value.RawValue == null || value.RawValue.Length > 4096)
            throw new ArgumentException("Context rule condition is invalid or unbounded.");
    }

    private static void ValidateAction(DynamicContextRuleActionV1 value)
    {
        if (value.Kind != "set_parameter" || !DynamicCanonical.Id(value.ParameterName, 256) || !DynamicCanonical.Id(value.ParameterIdentity, 256) ||
            value.ParameterScope != "instance" && value.ParameterScope != "type" || !new[] { "string", "integer", "double", "element_id" }.Contains(value.ValueKind, StringComparer.Ordinal) ||
            value.RawValue == null || value.RawValue.Length > 4096 || value.ValueKind == "double" && (!DynamicCanonical.Id(value.SpecTypeId ?? "", 256) || !DynamicCanonical.Id(value.UnitTypeId ?? "", 256)) ||
            value.ValueKind != "double" && (value.SpecTypeId != null || value.UnitTypeId != null)) throw new ArgumentException("Context rule action is invalid or unbounded.");
    }

    private static string ConditionCanonical(DynamicContextRuleConditionV1 value) => DynamicCanonical.Join(value.ParameterName, value.ParameterIdentity, value.ParameterScope, value.Operator, value.ValueKind, value.RawValue);
    private static string ActionCanonical(DynamicContextRuleActionV1 value) => DynamicCanonical.Join(value.Kind, value.ParameterName, value.ParameterIdentity, value.ParameterScope, value.ValueKind, value.RawValue, value.SpecTypeId, value.UnitTypeId);
}
