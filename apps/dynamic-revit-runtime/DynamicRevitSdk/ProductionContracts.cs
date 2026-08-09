using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace RevitOperator.DynamicRevitSdk;

/// <summary>
/// Production-oriented protocol identities. These contracts describe trusted inputs;
/// generated source is never an authority for any field in this file.
/// </summary>
public static class DynamicRevitProductionSchemas
{
    public const string AdmissionV1 = "dynamic_program_admission/v1";
    public const string EffectBudgetV1 = "dynamic_effect_budget/v1";
    public const string FileCapabilityV1 = "dynamic_file_capability/v1";
    public const string FileCapabilitySetV1 = "dynamic_file_capability_set/v1";
    public const string OperationGraphV1 = "dynamic-revit-operation-graph/v1";
    public const string ExternalEffectV1 = "dynamic_external_effect/v1";
    public const string RepairFeedbackV1 = "dynamic_program_repair_feedback/v1";
    public const string ReuseRecordV1 = "dynamic_program_reuse_record/v1";
    public const string StrategyEvidenceV1 = "revit-operator.execution-strategy-evidence.v1";
    public const string PrimitiveManifestV1 = "dynamic_revit_primitive_manifest/v1";
}

/// <summary>A versioned identity over the complete public v1 wire surface and primitive manifest.</summary>
public static class DynamicRevitSdkProductionVersion
{
    public const string Value = "dynamic-revit-sdk/v1";
    public const string GraphSchema = DynamicRevitProductionSchemas.OperationGraphV1;
    private static readonly Type[] WireTypes =
    {
        typeof(DynamicProgramAdmissionV1), typeof(DynamicEffectBudgetV1), typeof(DynamicFileCapabilityV1),
        typeof(DynamicFileCapabilitySetV1), typeof(DynamicOperationGraphV1), typeof(DynamicOperationNodeV1),
        typeof(DynamicExternalEffectV1), typeof(DynamicProgramRepairFeedbackV1), typeof(DynamicProgramReuseRecordV1),
        typeof(DynamicExecutionStrategyEvidenceV1), typeof(DynamicPrimitiveDescriptorV1)
    };

    public static string ContractSurfaceHash => DynamicWire.Sha256(string.Join("\n", WireTypes.OrderBy(type => type.FullName, StringComparer.Ordinal).Select(Surface)));
    public static string ManifestHash => DynamicWire.Sha256(DynamicCanonical.Join(Value, GraphSchema,
        DynamicRevitProductionSchemas.AdmissionV1, DynamicRevitProductionSchemas.EffectBudgetV1,
        DynamicRevitProductionSchemas.FileCapabilityV1, DynamicRevitProductionSchemas.FileCapabilitySetV1,
        DynamicRevitProductionSchemas.ExternalEffectV1, DynamicRevitProductionSchemas.RepairFeedbackV1,
        DynamicRevitProductionSchemas.ReuseRecordV1, DynamicRevitProductionSchemas.StrategyEvidenceV1,
        ContractSurfaceHash, DynamicPrimitiveManifestV1.ManifestHash, DynamicObservationContractV1.ManifestHash,
        DynamicBuildingSystemsObservationContractV1.ManifestHash, DynamicCoreOperationManifestV1.ManifestHash,
        DynamicResultReferenceManifestV1.ManifestHash));

    private static string Surface(Type type) => type.FullName + "\n" + string.Join("\n", type.GetProperties()
        .Where(property => property.GetMethod != null && property.GetMethod.IsPublic && !property.GetMethod.IsStatic)
        .OrderBy(property => property.Name, StringComparer.Ordinal).Select(property => property.Name + ":" + TypeName(property.PropertyType)));
    private static string TypeName(Type type)
    {
        if (type.IsArray) return TypeName(type.GetElementType()!) + "[]";
        if (type.IsGenericType)
        {
            var name = type.GetGenericTypeDefinition().FullName ?? type.Name;
            var tick = name.IndexOf('`'); if (tick >= 0) name = name.Substring(0, tick);
            return name + "<" + string.Join(",", type.GetGenericArguments().Select(TypeName)) + ">";
        }
        return type.FullName ?? type.Name;
    }
}

public sealed class DynamicProgramAdmissionV1
{
    public string Schema { get; set; } = DynamicRevitProductionSchemas.AdmissionV1;
    public string AdmissionId { get; set; } = "";
    public string NormalizedSourceHash { get; set; } = "";
    public string CompiledArtifactHash { get; set; } = "";
    public string CompilerRuntimeHash { get; set; } = "";
    public string SdkVersion { get; set; } = "";
    public string SdkManifestHash { get; set; } = "";
    public string SdkArtifactHash { get; set; } = "";
    public string WorkerExecutableHash { get; set; } = "";
    public string WorkerRuntimePackageHash { get; set; } = "";
    public string SandboxProfileVersion { get; set; } = "";
    public string SandboxProfileHash { get; set; } = "";
    public string AuthenticatedWorkerIdentityHash { get; set; } = "";
    public string TargetRevitVersion { get; set; } = "";
    public string HostAdapterManifestHash { get; set; } = "";
    public string DocumentFingerprint { get; set; } = "";
    public string DocumentSessionId { get; set; } = "";
    public long DocumentRevision { get; set; }
    public string ProjectContextIdentityHash { get; set; } = "";
    public string CapabilityEnvelopeHash { get; set; } = "";
    public string OperationFamilyEnvelopeHash { get; set; } = "";
    public string EffectBudgetHash { get; set; } = "";
    public string FileCapabilitySetHash { get; set; } = "";
    public string OperationGraphHash { get; set; } = "";
    public string PreviewReceiptHash { get; set; } = "";
    public string PolicyIdentityHash { get; set; } = "";
    public string RuntimeIdentityHash { get; set; } = "";
    public string RequestFamilySealHash { get; set; } = "";
    public string FinalAuthorizationHash { get; set; } = "";
    public string PrincipalIdHash { get; set; } = "";
    public string PrincipalSessionHash { get; set; } = "";
    public string CorrelationId { get; set; } = "";
    public string ReplayNonceHash { get; set; } = "";
    public long IssuedUnixSeconds { get; set; }
    public long ExpiresUnixSeconds { get; set; }
    public string AdmissionSignature { get; set; } = "";
}

/// <summary>Trusted current facts supplied by the host/authorization service.</summary>
public sealed class DynamicProgramAdmissionExpectationsV1
{
    public string NormalizedSourceHash { get; set; } = "";
    public string CompiledArtifactHash { get; set; } = "";
    public string CompilerRuntimeHash { get; set; } = "";
    public string SdkVersion { get; set; } = "";
    public string SdkManifestHash { get; set; } = "";
    public string SdkArtifactHash { get; set; } = "";
    public string WorkerExecutableHash { get; set; } = "";
    public string WorkerRuntimePackageHash { get; set; } = "";
    public string SandboxProfileVersion { get; set; } = "";
    public string SandboxProfileHash { get; set; } = "";
    public string AuthenticatedWorkerIdentityHash { get; set; } = "";
    public string TargetRevitVersion { get; set; } = "";
    public string HostAdapterManifestHash { get; set; } = "";
    public string DocumentFingerprint { get; set; } = "";
    public string DocumentSessionId { get; set; } = "";
    public long DocumentRevision { get; set; }
    public string ProjectContextIdentityHash { get; set; } = "";
    public string CapabilityEnvelopeHash { get; set; } = "";
    public string OperationFamilyEnvelopeHash { get; set; } = "";
    public string EffectBudgetHash { get; set; } = "";
    public string FileCapabilitySetHash { get; set; } = "";
    public string OperationGraphHash { get; set; } = "";
    public string PreviewReceiptHash { get; set; } = "";
    public string PolicyIdentityHash { get; set; } = "";
    public string RuntimeIdentityHash { get; set; } = "";
    public string RequestFamilySealHash { get; set; } = "";
    public string FinalAuthorizationHash { get; set; } = "";
    public string PrincipalIdHash { get; set; } = "";
    public string PrincipalSessionHash { get; set; } = "";
}

public static class DynamicProgramAdmissionV1Policy
{
    public static string Canonical(DynamicProgramAdmissionV1 admission)
    {
        if (admission == null) throw new ArgumentNullException(nameof(admission));
        return DynamicCanonical.Join(
            admission.Schema, admission.AdmissionId, admission.NormalizedSourceHash, admission.CompiledArtifactHash,
            admission.CompilerRuntimeHash, admission.SdkVersion, admission.SdkManifestHash, admission.SdkArtifactHash,
            admission.WorkerExecutableHash, admission.WorkerRuntimePackageHash, admission.SandboxProfileVersion,
            admission.SandboxProfileHash, admission.AuthenticatedWorkerIdentityHash, admission.TargetRevitVersion,
            admission.HostAdapterManifestHash, admission.DocumentFingerprint, admission.DocumentSessionId,
            admission.DocumentRevision.ToString(CultureInfo.InvariantCulture), admission.ProjectContextIdentityHash,
            admission.CapabilityEnvelopeHash, admission.OperationFamilyEnvelopeHash, admission.EffectBudgetHash,
            admission.FileCapabilitySetHash, admission.OperationGraphHash, admission.PreviewReceiptHash,
            admission.PolicyIdentityHash, admission.RuntimeIdentityHash, admission.RequestFamilySealHash,
            admission.FinalAuthorizationHash, admission.PrincipalIdHash, admission.PrincipalSessionHash,
            admission.CorrelationId, admission.ReplayNonceHash,
            admission.IssuedUnixSeconds.ToString(CultureInfo.InvariantCulture),
            admission.ExpiresUnixSeconds.ToString(CultureInfo.InvariantCulture));
    }

    public static string Sign(DynamicProgramAdmissionV1 admission, byte[] trustedKey)
        => DynamicCanonical.Hmac(Canonical(admission), trustedKey);

    public static void ValidateAndConsume(
        DynamicProgramAdmissionV1 admission,
        DynamicProgramAdmissionExpectationsV1 expected,
        byte[] trustedKey,
        long nowUnixSeconds,
        Func<string, bool> tryConsumeReplayKey)
    {
        if (admission == null || expected == null || tryConsumeReplayKey == null)
            throw new ArgumentNullException("Admission, trusted expectations, and replay authority are required.");
        if (admission.Schema != DynamicRevitProductionSchemas.AdmissionV1 ||
            !DynamicCanonical.Id(admission.AdmissionId, 160) || !DynamicCanonical.Id(admission.CorrelationId, 160) ||
            admission.DocumentRevision < 0 || admission.IssuedUnixSeconds > nowUnixSeconds + 5 ||
            admission.ExpiresUnixSeconds <= nowUnixSeconds || admission.ExpiresUnixSeconds > nowUnixSeconds + 300 ||
            admission.ExpiresUnixSeconds <= admission.IssuedUnixSeconds)
            throw new InvalidOperationException("Dynamic program admission identity or lifetime is invalid.");

        DynamicCanonical.RequireHashes(
            admission.NormalizedSourceHash, admission.CompiledArtifactHash, admission.CompilerRuntimeHash,
            admission.SdkManifestHash, admission.SdkArtifactHash, admission.WorkerExecutableHash,
            admission.WorkerRuntimePackageHash, admission.SandboxProfileHash,
            admission.AuthenticatedWorkerIdentityHash, admission.HostAdapterManifestHash,
            admission.DocumentFingerprint, admission.ProjectContextIdentityHash, admission.CapabilityEnvelopeHash,
            admission.OperationFamilyEnvelopeHash, admission.EffectBudgetHash, admission.FileCapabilitySetHash,
            admission.OperationGraphHash, admission.PreviewReceiptHash, admission.PolicyIdentityHash,
            admission.RuntimeIdentityHash, admission.RequestFamilySealHash, admission.FinalAuthorizationHash,
            admission.PrincipalIdHash, admission.PrincipalSessionHash, admission.ReplayNonceHash);
        if (!DynamicCanonical.Id(admission.SdkVersion, 128) || !DynamicCanonical.Id(admission.SandboxProfileVersion, 128) ||
            !DynamicCanonical.RevitVersion(admission.TargetRevitVersion) || !DynamicCanonical.Id(admission.DocumentSessionId, 256))
            throw new InvalidOperationException("Dynamic program admission version or session identity is invalid.");

        RequireEqual(admission.NormalizedSourceHash, expected.NormalizedSourceHash, "source");
        RequireEqual(admission.CompiledArtifactHash, expected.CompiledArtifactHash, "artifact");
        RequireEqual(admission.CompilerRuntimeHash, expected.CompilerRuntimeHash, "compiler runtime");
        RequireEqual(admission.SdkVersion, expected.SdkVersion, "SDK version");
        RequireEqual(admission.SdkManifestHash, expected.SdkManifestHash, "SDK manifest");
        RequireEqual(admission.SdkArtifactHash, expected.SdkArtifactHash, "SDK artifact");
        RequireEqual(admission.WorkerExecutableHash, expected.WorkerExecutableHash, "worker executable");
        RequireEqual(admission.WorkerRuntimePackageHash, expected.WorkerRuntimePackageHash, "worker package");
        RequireEqual(admission.SandboxProfileVersion, expected.SandboxProfileVersion, "sandbox profile version");
        RequireEqual(admission.SandboxProfileHash, expected.SandboxProfileHash, "sandbox profile");
        RequireEqual(admission.AuthenticatedWorkerIdentityHash, expected.AuthenticatedWorkerIdentityHash, "worker identity");
        RequireEqual(admission.TargetRevitVersion, expected.TargetRevitVersion, "Revit version");
        RequireEqual(admission.HostAdapterManifestHash, expected.HostAdapterManifestHash, "host adapter");
        RequireEqual(admission.DocumentFingerprint, expected.DocumentFingerprint, "document");
        RequireEqual(admission.DocumentSessionId, expected.DocumentSessionId, "document session");
        if (admission.DocumentRevision != expected.DocumentRevision) throw new InvalidOperationException("Dynamic program admission document revision is stale.");
        RequireEqual(admission.ProjectContextIdentityHash, expected.ProjectContextIdentityHash, "project context");
        RequireEqual(admission.CapabilityEnvelopeHash, expected.CapabilityEnvelopeHash, "capability envelope");
        RequireEqual(admission.OperationFamilyEnvelopeHash, expected.OperationFamilyEnvelopeHash, "operation-family envelope");
        RequireEqual(admission.EffectBudgetHash, expected.EffectBudgetHash, "effect budget");
        RequireEqual(admission.FileCapabilitySetHash, expected.FileCapabilitySetHash, "file capability set");
        RequireEqual(admission.OperationGraphHash, expected.OperationGraphHash, "operation graph");
        RequireEqual(admission.PreviewReceiptHash, expected.PreviewReceiptHash, "preview receipt");
        RequireEqual(admission.PolicyIdentityHash, expected.PolicyIdentityHash, "policy identity");
        RequireEqual(admission.RuntimeIdentityHash, expected.RuntimeIdentityHash, "runtime identity");
        RequireEqual(admission.RequestFamilySealHash, expected.RequestFamilySealHash, "request-family seal");
        RequireEqual(admission.FinalAuthorizationHash, expected.FinalAuthorizationHash, "final authorization");
        RequireEqual(admission.PrincipalIdHash, expected.PrincipalIdHash, "principal");
        RequireEqual(admission.PrincipalSessionHash, expected.PrincipalSessionHash, "principal session");

        var expectedSignature = Sign(admission, trustedKey);
        if (!DynamicCanonical.FixedEquals(expectedSignature, admission.AdmissionSignature))
            throw new InvalidOperationException("Dynamic program admission signature is invalid.");
        var replayKey = DynamicWire.Sha256(admission.AdmissionId + "\n" + admission.ReplayNonceHash + "\n" + admission.FinalAuthorizationHash);
        if (!tryConsumeReplayKey(replayKey)) throw new InvalidOperationException("Dynamic program admission was replayed.");
    }

    private static void RequireEqual(string observed, string expected, string field)
    {
        if (!DynamicCanonical.FixedEquals(observed, expected))
            throw new InvalidOperationException("Dynamic program admission " + field + " binding does not match trusted state.");
    }
}

public sealed class DynamicEffectBudgetV1
{
    public string Schema { get; set; } = DynamicRevitProductionSchemas.EffectBudgetV1;
    public string BudgetId { get; set; } = "";
    public IReadOnlyList<string> TargetDocumentFingerprints { get; set; } = Array.Empty<string>();
    public IReadOnlyList<string> AllowedCategories { get; set; } = Array.Empty<string>();
    public IReadOnlyList<string> ExplicitTargetUniqueIds { get; set; } = Array.Empty<string>();
    public IReadOnlyList<string> AllowedSdkDomains { get; set; } = Array.Empty<string>();
    public IReadOnlyList<string> AllowedExternalEffectClasses { get; set; } = Array.Empty<string>();
    public string ViewScopeHash { get; set; } = DynamicWire.Sha256("none");
    public string LevelScopeHash { get; set; } = DynamicWire.Sha256("none");
    public string WorksetScopeHash { get; set; } = DynamicWire.Sha256("none");
    public string PhaseScopeHash { get; set; } = DynamicWire.Sha256("none");
    public int MaximumOperationCount { get; set; } = 256;
    public int MaximumAffectedElements { get; set; } = 512;
    public int MaximumCreates { get; set; } = 32;
    public int MaximumModifications { get; set; } = 224;
    public int MaximumDeletes { get; set; }
    public int MaximumExecutionMilliseconds { get; set; } = 30000;
    public int MaximumRegenerations { get; set; } = 8;
    public int MaximumOutputCount { get; set; } = 16;
    public long MaximumOutputBytes { get; set; } = 256L * 1024L * 1024L;
    public string FileCapabilitySetHash { get; set; } = "";

    public string CanonicalHash()
    {
        Validate();
        return DynamicWire.Sha256(DynamicCanonical.Join(
            Schema, BudgetId,
            DynamicCanonical.Set(TargetDocumentFingerprints), DynamicCanonical.Set(AllowedCategories),
            DynamicCanonical.Set(ExplicitTargetUniqueIds), DynamicCanonical.Set(AllowedSdkDomains),
            DynamicCanonical.Set(AllowedExternalEffectClasses), ViewScopeHash, LevelScopeHash, WorksetScopeHash,
            PhaseScopeHash, MaximumOperationCount.ToString(CultureInfo.InvariantCulture),
            MaximumAffectedElements.ToString(CultureInfo.InvariantCulture), MaximumCreates.ToString(CultureInfo.InvariantCulture),
            MaximumModifications.ToString(CultureInfo.InvariantCulture), MaximumDeletes.ToString(CultureInfo.InvariantCulture),
            MaximumExecutionMilliseconds.ToString(CultureInfo.InvariantCulture), MaximumRegenerations.ToString(CultureInfo.InvariantCulture),
            MaximumOutputCount.ToString(CultureInfo.InvariantCulture), MaximumOutputBytes.ToString(CultureInfo.InvariantCulture),
            FileCapabilitySetHash));
    }

    public void Validate()
    {
        if (Schema != DynamicRevitProductionSchemas.EffectBudgetV1 || !DynamicCanonical.Id(BudgetId, 160) ||
            TargetDocumentFingerprints == null || TargetDocumentFingerprints.Count < 1 || TargetDocumentFingerprints.Count > 8 ||
            AllowedSdkDomains == null || AllowedSdkDomains.Count < 1 || AllowedSdkDomains.Count > 32 ||
            MaximumOperationCount < 1 || MaximumOperationCount > 10000 || MaximumAffectedElements < 1 || MaximumAffectedElements > 50000 ||
            MaximumCreates < 0 || MaximumModifications < 0 || MaximumDeletes < 0 ||
            MaximumCreates + MaximumModifications + MaximumDeletes > MaximumOperationCount ||
            MaximumExecutionMilliseconds < 100 || MaximumExecutionMilliseconds > 600000 || MaximumRegenerations < 0 || MaximumRegenerations > 1000 ||
            MaximumOutputCount < 0 || MaximumOutputCount > 10000 || MaximumOutputBytes < 0 || MaximumOutputBytes > 20L * 1024L * 1024L * 1024L)
            throw new ArgumentException("Dynamic effect budget is invalid.");
        DynamicCanonical.RequireHashes(TargetDocumentFingerprints.Concat(new[] { ViewScopeHash, LevelScopeHash, WorksetScopeHash, PhaseScopeHash, FileCapabilitySetHash }).ToArray());
        DynamicCanonical.RequireDistinct(AllowedCategories, 256, 256, "category");
        DynamicCanonical.RequireDistinct(ExplicitTargetUniqueIds, 50000, 256, "target");
        DynamicCanonical.RequireDistinct(AllowedSdkDomains, 32, 128, "SDK domain");
        DynamicCanonical.RequireDistinct(AllowedExternalEffectClasses, 16, 128, "external effect");
    }
}

public sealed class DynamicFileCapabilityV1
{
    public string Schema { get; set; } = DynamicRevitProductionSchemas.FileCapabilityV1;
    public string CapabilityId { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Access { get; set; } = "read";
    public string Scope { get; set; } = "file";
    public string CanonicalLocationHash { get; set; } = "";
    public IReadOnlyList<string> AllowedExtensions { get; set; } = Array.Empty<string>();
    public int MaximumOutputCount { get; set; }
    public long MaximumOutputBytes { get; set; }
    public string TaskIdHash { get; set; } = "";
    public string ProgramHash { get; set; } = "";
    public string DocumentFingerprint { get; set; } = "";
    public string PrincipalIdHash { get; set; } = "";
    public long ExpiresUnixSeconds { get; set; }
    public int MaximumUseCount { get; set; } = 1;

    public string CanonicalHash()
    {
        Validate();
        return DynamicWire.Sha256(DynamicCanonical.Join(Schema, CapabilityId, Kind, Access, Scope, CanonicalLocationHash,
            DynamicCanonical.Set(AllowedExtensions.Select(value => value.ToLowerInvariant())), MaximumOutputCount.ToString(CultureInfo.InvariantCulture),
            MaximumOutputBytes.ToString(CultureInfo.InvariantCulture), TaskIdHash, ProgramHash, DocumentFingerprint,
            PrincipalIdHash, ExpiresUnixSeconds.ToString(CultureInfo.InvariantCulture), MaximumUseCount.ToString(CultureInfo.InvariantCulture)));
    }

    public void Validate()
    {
        var kinds = new[] { "project_directory", "linked_document", "selected_input", "conversation_attachment", "company_library", "family_library", "task_scratch", "export_destination", "save_as_destination" };
        var accessValues = new[] { "read", "write", "create", "read_write_create" };
        if (Schema != DynamicRevitProductionSchemas.FileCapabilityV1 || !DynamicCanonical.Id(CapabilityId, 160) ||
            !kinds.Contains(Kind, StringComparer.Ordinal) || !accessValues.Contains(Access, StringComparer.Ordinal) ||
            (Scope != "file" && Scope != "directory") || MaximumOutputCount < 0 || MaximumOutputCount > 10000 ||
            MaximumOutputBytes < 0 || MaximumOutputBytes > 20L * 1024L * 1024L * 1024L || MaximumUseCount < 1 || MaximumUseCount > 10000)
            throw new ArgumentException("Dynamic file capability is invalid.");
        DynamicCanonical.RequireHashes(CanonicalLocationHash, TaskIdHash, ProgramHash, DocumentFingerprint, PrincipalIdHash);
        DynamicCanonical.RequireDistinct(AllowedExtensions, 64, 32, "file extension");
        if (AllowedExtensions.Any(extension => extension.Length < 2 || extension[0] != '.' || extension.IndexOfAny(new[] { '/', '\\', ':' }) >= 0))
            throw new ArgumentException("Dynamic file capability extension is invalid.");
    }
}

public sealed class DynamicFileCapabilitySetV1
{
    public string Schema { get; set; } = DynamicRevitProductionSchemas.FileCapabilitySetV1;
    public IReadOnlyList<DynamicFileCapabilityV1> Capabilities { get; set; } = Array.Empty<DynamicFileCapabilityV1>();
    public string CanonicalHash()
    {
        if (Schema != DynamicRevitProductionSchemas.FileCapabilitySetV1 || Capabilities == null || Capabilities.Count > 64)
            throw new ArgumentException("Dynamic file capability set is invalid.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var hashes = new List<string>();
        foreach (var capability in Capabilities)
        {
            if (capability == null || !ids.Add(capability.CapabilityId)) throw new ArgumentException("Dynamic file capability IDs must be unique.");
            hashes.Add(capability.CanonicalHash());
        }
        return DynamicWire.Sha256(DynamicCanonical.Join(Schema, DynamicCanonical.Set(hashes)));
    }
}

public sealed class DynamicOperationGraphV1
{
    public string Schema { get; set; } = DynamicRevitProductionSchemas.OperationGraphV1;
    public string InputHash { get; set; } = "";
    public string DocumentFingerprint { get; set; } = "";
    public long DocumentRevision { get; set; }
    public IReadOnlyList<DynamicOperationNodeV1> Nodes { get; set; } = Array.Empty<DynamicOperationNodeV1>();
    public string GraphHash { get; set; } = "";
}

public sealed class DynamicOperationNodeV1
{
    public string NodeId { get; set; } = "";
    public string Kind { get; set; } = "";
    public IReadOnlyList<string> TargetUniqueIds { get; set; } = Array.Empty<string>();
    public IReadOnlyList<string> DependsOn { get; set; } = Array.Empty<string>();
    public IReadOnlyDictionary<string, string> Attributes { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
}

public sealed class DynamicPrimitiveDescriptorV1
{
    public string Kind { get; set; } = "";
    public string Domain { get; set; } = "";
    public string EffectClass { get; set; } = "read";
    public IReadOnlyList<string> RequiredAttributes { get; set; } = Array.Empty<string>();
    public bool ImplementedByV1Host { get; set; }
}

public static class DynamicPrimitiveManifestV1
{
    private static readonly DynamicPrimitiveDescriptorV1[] Descriptors =
    {
        D("move_element", "elements", "modify", true, "vector_feet"),
        D("rotate_element", "elements", "modify", true, "axis", "angle_radians"),
        D("copy_element", "elements", "create", false, "transform"),
        D("delete_element", "elements", "delete", true),
        D("set_parameter", "parameters", "modify", true, "parameter_identity", "value", "value_kind"),
        D("change_type", "elements", "modify", true, "replacement_type_unique_id", "expected_target_state_hash"),
        D("create_family_instance", "families", "create", false, "family_type_identity", "placement"),
        D("create_model_curve", "geometry", "create", false, "curve"),
        D("create_mep_curve", "mep", "create", false, "curve", "system_type", "type_identity"),
        D("connect_mep", "mep", "modify", false, "connector_a", "connector_b"),
        D("create_view", "views", "create", false, "view_kind"),
        D("duplicate_view", "views", "create", false, "duplicate_mode"),
        D("create_sheet", "sheets", "create", false, "number", "name", "titleblock_type"),
        D("place_viewport", "sheets", "create", false, "sheet_identity", "view_identity", "point"),
        D("create_schedule", "schedules", "create", false, "category", "fields"),
        D("modify_schedule", "schedules", "modify", false, "changes"),
        D("create_tag", "annotation", "create", false, "tag_type", "view_identity", "point"),
        D("create_text", "annotation", "create", false, "view_identity", "point", "text"),
        D("create_dimension", "annotation", "create", false, "view_identity", "references"),
        D("reload_link", "links", "external", false, "file_capability_id"),
        D("load_family", "families", "external", false, "file_capability_id"),
        D("export", "files", "external", false, "file_capability_id", "export_manifest_hash"),
        D("save_as", "files", "external", false, "file_capability_id"),
        D("print", "files", "external", false, "print_manifest_hash")
    };

    public static IReadOnlyList<DynamicPrimitiveDescriptorV1> All => Descriptors;
    public static string ManifestHash => DynamicWire.Sha256(DynamicCanonical.Join(DynamicRevitProductionSchemas.PrimitiveManifestV1,
        string.Join("\n", Descriptors.OrderBy(item => item.Kind, StringComparer.Ordinal).Select(item => DynamicCanonical.Join(
            item.Kind, item.Domain, item.EffectClass, DynamicCanonical.Set(item.RequiredAttributes), item.ImplementedByV1Host ? "1" : "0")))));

    public static DynamicPrimitiveDescriptorV1? Find(string kind) => Descriptors.FirstOrDefault(item => item.Kind == kind);
    private static DynamicPrimitiveDescriptorV1 D(string kind, string domain, string effectClass, bool implemented, params string[] required)
        => new() { Kind = kind, Domain = domain, EffectClass = effectClass, ImplementedByV1Host = implemented, RequiredAttributes = required };
}

public static class DynamicOperationGraphV1Admission
{
    public sealed class TrustedValidationContext
    {
        public IReadOnlyDictionary<string, string> TargetCategories { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
        public string ViewScopeHash { get; set; } = "";
        public string LevelScopeHash { get; set; } = "";
        public string WorksetScopeHash { get; set; } = "";
        public string PhaseScopeHash { get; set; } = "";
        public string FileCapabilitySetHash { get; set; } = "";
        public IReadOnlyList<string> AuthorizedFileCapabilityIds { get; set; } = Array.Empty<string>();
        public int PlannedExecutionMilliseconds { get; set; }
        public int PlannedRegenerations { get; set; }
        public int PlannedOutputCount { get; set; }
        public long PlannedOutputBytes { get; set; }
    }

    public static string NodeId(DynamicOperationNodeV1 node)
    {
        if (node == null) throw new ArgumentNullException(nameof(node));
        return DynamicWire.Sha256(DynamicCanonical.Join(node.Kind, DynamicCanonical.Set(node.TargetUniqueIds),
            DynamicCanonical.Set(node.DependsOn), DynamicCanonical.Map(node.Attributes)));
    }

    public static string GraphHash(DynamicOperationGraphV1 graph)
    {
        if (graph == null) throw new ArgumentNullException(nameof(graph));
        return DynamicWire.Sha256(DynamicCanonical.Join(graph.Schema, graph.InputHash, graph.DocumentFingerprint,
            graph.DocumentRevision.ToString(CultureInfo.InvariantCulture),
            string.Join("\n", graph.Nodes.Select(NodeId).OrderBy(value => value, StringComparer.Ordinal))));
    }

    public static void Validate(DynamicOperationGraphV1 graph, DynamicEffectBudgetV1 budget, IEnumerable<string> allowedKinds, TrustedValidationContext context)
    {
        if (graph == null || budget == null || allowedKinds == null || context == null || graph.Schema != DynamicRevitProductionSchemas.OperationGraphV1 ||
            graph.DocumentRevision < 0 || graph.Nodes == null || graph.Nodes.Count < 1)
            throw new ArgumentException("Dynamic operation graph v1 is invalid.");
        DynamicCanonical.RequireHashes(graph.InputHash, graph.DocumentFingerprint, graph.GraphHash);
        budget.Validate();
        if (!budget.TargetDocumentFingerprints.Contains(graph.DocumentFingerprint, StringComparer.Ordinal) || graph.Nodes.Count > budget.MaximumOperationCount)
            throw new ArgumentException("Dynamic operation graph exceeds its document or operation budget.");
        DynamicCanonical.RequireHashes(context.ViewScopeHash, context.LevelScopeHash, context.WorksetScopeHash, context.PhaseScopeHash, context.FileCapabilitySetHash);
        if (!DynamicCanonical.FixedEquals(context.ViewScopeHash, budget.ViewScopeHash) || !DynamicCanonical.FixedEquals(context.LevelScopeHash, budget.LevelScopeHash) ||
            !DynamicCanonical.FixedEquals(context.WorksetScopeHash, budget.WorksetScopeHash) || !DynamicCanonical.FixedEquals(context.PhaseScopeHash, budget.PhaseScopeHash) ||
            !DynamicCanonical.FixedEquals(context.FileCapabilitySetHash, budget.FileCapabilitySetHash))
            throw new ArgumentException("Dynamic operation graph trusted scope or file-capability identity changed.");
        if (context.PlannedExecutionMilliseconds < 0 || context.PlannedExecutionMilliseconds > budget.MaximumExecutionMilliseconds ||
            context.PlannedRegenerations < 0 || context.PlannedRegenerations > budget.MaximumRegenerations ||
            context.PlannedOutputCount < 0 || context.PlannedOutputCount > budget.MaximumOutputCount ||
            context.PlannedOutputBytes < 0 || context.PlannedOutputBytes > budget.MaximumOutputBytes)
            throw new ArgumentException("Dynamic operation graph exceeds an execution, regeneration, or output budget.");

        var permittedKinds = new HashSet<string>(allowedKinds, StringComparer.Ordinal);
        var permittedDomains = new HashSet<string>(budget.AllowedSdkDomains, StringComparer.Ordinal);
        var permittedTargets = new HashSet<string>(budget.ExplicitTargetUniqueIds ?? Array.Empty<string>(), StringComparer.Ordinal);
        var permittedCategories = new HashSet<string>(budget.AllowedCategories ?? Array.Empty<string>(), StringComparer.Ordinal);
        var permittedExternalEffects = new HashSet<string>(budget.AllowedExternalEffectClasses ?? Array.Empty<string>(), StringComparer.Ordinal);
        var permittedFileCapabilities = new HashSet<string>(context.AuthorizedFileCapabilityIds ?? Array.Empty<string>(), StringComparer.Ordinal);
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var nodes = new Dictionary<string, DynamicOperationNodeV1>(StringComparer.Ordinal);
        var affected = new HashSet<string>(StringComparer.Ordinal);
        var creates = 0; var modifies = 0; var deletes = 0;
        foreach (var node in graph.Nodes)
        {
            if (node == null || !DynamicCanonical.Id(node.Kind, 128) || node.NodeId != NodeId(node) || !ids.Add(node.NodeId))
                throw new ArgumentException("Dynamic operation node identity is invalid or duplicated.");
            var descriptor = DynamicPrimitiveManifestV1.Find(node.Kind);
            if (descriptor == null || !permittedKinds.Contains(node.Kind) || !permittedDomains.Contains(descriptor.Domain))
                throw new ArgumentException("Dynamic operation kind or SDK domain is not authorized.");
            DynamicCanonical.RequireDistinct(node.TargetUniqueIds, 50000, 256, "operation target");
            DynamicCanonical.RequireDistinct(node.DependsOn, 10000, 80, "operation dependency");
            if (node.DependsOn.Contains(node.NodeId, StringComparer.Ordinal)) throw new ArgumentException("Dynamic operation cannot depend on itself.");
            if (node.Attributes == null || node.Attributes.Count > 64 || node.Attributes.Any(pair => !DynamicCanonical.Id(pair.Key, 128) || pair.Value == null || pair.Value.Length > 8192))
                throw new ArgumentException("Dynamic operation attributes are invalid.");
            if (descriptor.RequiredAttributes.Any(required => !node.Attributes.ContainsKey(required)))
                throw new ArgumentException("Dynamic operation is missing a required primitive attribute.");
            ValidateTypedAttributes(node);
            foreach (var target in node.TargetUniqueIds)
            {
                if (permittedTargets.Count > 0 && !permittedTargets.Contains(target)) throw new ArgumentException("Dynamic operation target is outside explicit scope.");
                if (!context.TargetCategories.TryGetValue(target, out var category) || permittedCategories.Count < 1 || !permittedCategories.Contains(category))
                    throw new ArgumentException("Dynamic operation target category is outside the trusted effect budget.");
                affected.Add(target);
            }
            if (descriptor.EffectClass == "create") creates++;
            else if (descriptor.EffectClass == "modify") modifies++;
            else if (descriptor.EffectClass == "delete") deletes++;
            else if (descriptor.EffectClass == "external")
            {
                if (!permittedExternalEffects.Contains(node.Kind)) throw new ArgumentException("Dynamic external-effect class is not authorized.");
                if (node.Attributes.TryGetValue("file_capability_id", out var fileCapabilityId) && !permittedFileCapabilities.Contains(fileCapabilityId))
                    throw new ArgumentException("Dynamic external effect references an unauthorized file capability.");
            }
            nodes.Add(node.NodeId, node);
        }
        if (affected.Count > budget.MaximumAffectedElements || creates > budget.MaximumCreates || modifies > budget.MaximumModifications || deletes > budget.MaximumDeletes)
            throw new ArgumentException("Dynamic operation graph exceeds an effect budget.");
        foreach (var node in graph.Nodes)
            if (node.DependsOn.Any(dependency => !nodes.ContainsKey(dependency))) throw new ArgumentException("Dynamic operation dependency is missing.");
        RejectCycles(nodes);
        RejectConflicts(graph.Nodes);
        if (graph.GraphHash != GraphHash(graph)) throw new ArgumentException("Dynamic operation graph v1 hash is invalid.");
    }

    private static void ValidateTypedAttributes(DynamicOperationNodeV1 node)
    {
        if (node.Kind == "move_element")
        {
            var values = node.Attributes["vector_feet"].Split(',');
            if (values.Length != 3 || values.Any(value => !double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) || double.IsNaN(parsed) || double.IsInfinity(parsed)))
                throw new ArgumentException("move_element vector_feet must contain three finite invariant numbers.");
        }
        else if (node.Kind == "set_parameter")
        {
            var kind = node.Attributes["value_kind"];
            var value = node.Attributes["value"];
            var valid = kind == "string" ||
                (kind == "integer" && long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out _)) ||
                (kind == "double" && double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && !double.IsNaN(number) && !double.IsInfinity(number)) ||
                (kind == "boolean" && (value == "true" || value == "false")) ||
                (kind == "element_id" && long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out _));
            if (!valid || string.IsNullOrWhiteSpace(node.Attributes["parameter_identity"])) throw new ArgumentException("set_parameter attributes are not typed canonical values.");
        }
    }

    private static void RejectCycles(IReadOnlyDictionary<string, DynamicOperationNodeV1> nodes)
    {
        var state = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var id in nodes.Keys) Visit(id);
        void Visit(string id)
        {
            if (state.TryGetValue(id, out var existing))
            {
                if (existing == 1) throw new ArgumentException("Dynamic operation graph contains a cycle.");
                return;
            }
            state[id] = 1;
            foreach (var dependency in nodes[id].DependsOn) Visit(dependency);
            state[id] = 2;
        }
    }

    private static void RejectConflicts(IEnumerable<DynamicOperationNodeV1> nodes)
    {
        var byTarget = new Dictionary<string, List<DynamicOperationNodeV1>>(StringComparer.Ordinal);
        foreach (var node in nodes)
            foreach (var target in node.TargetUniqueIds)
            {
                if (!byTarget.TryGetValue(target, out var list)) byTarget[target] = list = new List<DynamicOperationNodeV1>();
                list.Add(node);
            }
        foreach (var pair in byTarget)
        {
            if (pair.Value.Any(node => node.Kind == "delete_element") && pair.Value.Count > 1)
                throw new ArgumentException("Dynamic operation graph deletes and also operates on the same target.");
            var parameterWrites = pair.Value.Where(node => node.Kind == "set_parameter")
                .GroupBy(node => node.Attributes["parameter_identity"], StringComparer.Ordinal);
            foreach (var writes in parameterWrites)
            {
                var list = writes.ToArray();
                for (var i = 0; i < list.Length; i++)
                    for (var j = i + 1; j < list.Length; j++)
                        if (!DependsTransitively(list[i], list[j], nodes) && !DependsTransitively(list[j], list[i], nodes))
                            throw new ArgumentException("Dynamic operation graph contains unordered conflicting parameter writes.");
            }
        }
    }

    private static bool DependsTransitively(DynamicOperationNodeV1 candidate, DynamicOperationNodeV1 ancestor, IEnumerable<DynamicOperationNodeV1> nodes)
    {
        var map = nodes.ToDictionary(node => node.NodeId, StringComparer.Ordinal);
        var pending = new Stack<string>(candidate.DependsOn);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        while (pending.Count > 0)
        {
            var id = pending.Pop();
            if (!seen.Add(id)) continue;
            if (id == ancestor.NodeId) return true;
            if (map.TryGetValue(id, out var node)) foreach (var dependency in node.DependsOn) pending.Push(dependency);
        }
        return false;
    }
}

public sealed class DynamicExternalEffectV1
{
    public string Schema { get; set; } = DynamicRevitProductionSchemas.ExternalEffectV1;
    public string EffectId { get; set; } = "";
    public string EffectClass { get; set; } = "";
    public string State { get; set; } = "planned";
    public string PlanHash { get; set; } = "";
    public string StageManifestHash { get; set; } = "";
    public string InspectionReceiptHash { get; set; } = "";
    public string PublicationAuthorizationHash { get; set; } = "";
    public string PublicationReceiptHash { get; set; } = "";
    public string FileCapabilityId { get; set; } = "";
    public string DocumentSessionId { get; set; } = "";
    public long ExpiresUnixSeconds { get; set; }
}

public static class DynamicExternalEffectV1Policy
{
    private static readonly IReadOnlyDictionary<string, string[]> Next = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["planned"] = new[] { "staged", "failed" },
        ["staged"] = new[] { "inspected", "failed" },
        ["inspected"] = new[] { "authorized", "failed" },
        ["authorized"] = new[] { "published", "outcome_uncertain", "failed" },
        ["published"] = new[] { "verified", "outcome_uncertain" },
        ["verified"] = Array.Empty<string>(), ["outcome_uncertain"] = Array.Empty<string>(), ["failed"] = Array.Empty<string>()
    };

    public static void ValidateTransition(DynamicExternalEffectV1 previous, DynamicExternalEffectV1 next, long nowUnixSeconds)
    {
        if (previous == null || next == null || previous.Schema != DynamicRevitProductionSchemas.ExternalEffectV1 || next.Schema != previous.Schema ||
            previous.EffectId != next.EffectId || previous.EffectClass != next.EffectClass || previous.PlanHash != next.PlanHash ||
            previous.FileCapabilityId != next.FileCapabilityId || previous.DocumentSessionId != next.DocumentSessionId ||
            previous.ExpiresUnixSeconds <= nowUnixSeconds || next.ExpiresUnixSeconds != previous.ExpiresUnixSeconds ||
            !Next.TryGetValue(previous.State, out var allowed) || !allowed.Contains(next.State, StringComparer.Ordinal))
            throw new InvalidOperationException("Dynamic external-effect state transition is invalid.");
        DynamicCanonical.RequireHashes(previous.PlanHash);
        Preserve(previous.StageManifestHash, next.StageManifestHash, "stage manifest");
        Preserve(previous.InspectionReceiptHash, next.InspectionReceiptHash, "inspection receipt");
        Preserve(previous.PublicationAuthorizationHash, next.PublicationAuthorizationHash, "publication authorization");
        Preserve(previous.PublicationReceiptHash, next.PublicationReceiptHash, "publication receipt");
        if (next.State == "staged" && !DynamicCanonical.Hash(next.StageManifestHash)) throw new InvalidOperationException("Staged external effect requires a stage manifest.");
        if (next.State == "inspected" && (!DynamicCanonical.Hash(next.StageManifestHash) || !DynamicCanonical.Hash(next.InspectionReceiptHash))) throw new InvalidOperationException("Inspected external effect requires stage and inspection receipts.");
        if (next.State == "authorized" && !DynamicCanonical.Hash(next.PublicationAuthorizationHash)) throw new InvalidOperationException("Publishing requires fresh authorization.");
        if ((next.State == "published" || next.State == "verified") && !DynamicCanonical.Hash(next.PublicationReceiptHash)) throw new InvalidOperationException("Published external effect requires a publication receipt.");
    }

    private static void Preserve(string prior, string current, string field)
    {
        if (!string.IsNullOrEmpty(prior) && !DynamicCanonical.FixedEquals(prior, current))
            throw new InvalidOperationException("Dynamic external-effect " + field + " continuity changed.");
    }
}

public sealed class DynamicProgramRepairFeedbackV1
{
    public string Schema { get; set; } = DynamicRevitProductionSchemas.RepairFeedbackV1;
    public string AttemptId { get; set; } = "";
    public int AttemptNumber { get; set; }
    public string Phase { get; set; } = "preview";
    public string FailureClass { get; set; } = "";
    public string ProgramHash { get; set; } = "";
    public string AdmissionId { get; set; } = "";
    public IReadOnlyList<string> DiagnosticCodes { get; set; } = Array.Empty<string>();
    public IReadOnlyList<string> FailingElementIdentityHashes { get; set; } = Array.Empty<string>();
    public string StructuredEvidenceHash { get; set; } = "";
    public bool OutcomeUncertain { get; set; }
}

public static class DynamicProgramRepairPolicyV1
{
    public static void ValidatePreviewRepair(DynamicProgramRepairFeedbackV1 previous, string revisedProgramHash, string revisedAdmissionId, int maximumAttempts)
    {
        if (previous == null || previous.Schema != DynamicRevitProductionSchemas.RepairFeedbackV1 || previous.Phase != "preview" ||
            previous.OutcomeUncertain || previous.AttemptNumber < 1 || previous.AttemptNumber >= maximumAttempts || maximumAttempts < 1 || maximumAttempts > 10 ||
            !DynamicCanonical.Hash(previous.ProgramHash) || !DynamicCanonical.Hash(revisedProgramHash) ||
            previous.ProgramHash == revisedProgramHash || previous.AdmissionId == revisedAdmissionId || !DynamicCanonical.Id(revisedAdmissionId, 160))
            throw new InvalidOperationException("Dynamic preview repair is not permitted.");
    }
}

public sealed class DynamicProgramReuseRecordV1
{
    public string Schema { get; set; } = DynamicRevitProductionSchemas.ReuseRecordV1;
    public string RecordId { get; set; } = "";
    public string NormalizedSourceHash { get; set; } = "";
    public string SemanticTaskDescriptionHash { get; set; } = "";
    public string RequiredSdkCapabilitiesHash { get; set; } = "";
    public string ApplicabilityHash { get; set; } = "";
    public string InputSchemaHash { get; set; } = "";
    public string ProgramHash { get; set; } = "";
    public string PreviewEvidenceHash { get; set; } = "";
    public string ApplyEvidenceHash { get; set; } = "";
    public string VerificationOutcomeHash { get; set; } = "";
    public string FailureHistoryHash { get; set; } = "";
    public string RuntimeVersion { get; set; } = "";
    public string SdkVersion { get; set; } = "";
    public string AuthoringModelIdentityHash { get; set; } = "";
    public bool HistoricalSuccessBypassesAdmission => false;
}

public sealed class DynamicExecutionStrategyEvidenceV1
{
    public const bool AuthorizationGranted = false;
    public string Schema { get; set; } = DynamicRevitProductionSchemas.StrategyEvidenceV1;
    public string SelectedSubstrate { get; set; } = "";
    public string Reason { get; set; } = "";

    public void Validate()
    {
        var substrates = new[] { "typed_capability", "typed_capability_composition", "dynamic_revit_program" };
        if (Schema != DynamicRevitProductionSchemas.StrategyEvidenceV1 || !substrates.Contains(SelectedSubstrate, StringComparer.Ordinal) ||
            string.IsNullOrWhiteSpace(Reason) || Reason.Length > 320)
            throw new ArgumentException("Dynamic execution-strategy evidence is invalid.");
    }
}

internal static class DynamicCanonical
{
    internal static string Join(params string?[] values)
    {
        var builder = new StringBuilder();
        foreach (var value in values)
        {
            if (value == null) builder.Append("-\n");
            else builder.Append('+').Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(value))).Append('\n');
        }
        return builder.ToString();
    }

    internal static string Set(IEnumerable<string>? values)
        => Join((values ?? Array.Empty<string>()).OrderBy(value => value, StringComparer.Ordinal).ToArray());

    internal static string Map(IReadOnlyDictionary<string, string>? values)
        => Join((values ?? new Dictionary<string, string>()).OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .Select(pair => Join(pair.Key, pair.Value)).ToArray());

    internal static string Hmac(string value, byte[] key)
    {
        if (key == null || key.Length < 32) throw new ArgumentException("Trusted admission signing key must be at least 256 bits.");
        using var hmac = new HMACSHA256(key);
        return "hmac-sha256:" + BitConverter.ToString(hmac.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant();
    }

    internal static bool FixedEquals(string? left, string? right)
    {
        var a = Encoding.UTF8.GetBytes(left ?? ""); var b = Encoding.UTF8.GetBytes(right ?? "");
        if (a.Length != b.Length) return false;
        var difference = 0; for (var index = 0; index < a.Length; index++) difference |= a[index] ^ b[index];
        return difference == 0;
    }

    internal static bool Hash(string? value)
    {
        if (value == null || value.Length != 71 || !value.StartsWith("sha256:", StringComparison.Ordinal)) return false;
        for (var index = 7; index < value.Length; index++)
            if (!(value[index] >= '0' && value[index] <= '9') && !(value[index] >= 'a' && value[index] <= 'f')) return false;
        return true;
    }

    internal static void RequireHashes(params string[] values)
    {
        if (values == null || values.Any(value => !Hash(value))) throw new ArgumentException("A trusted SHA-256 identity is malformed.");
    }

    internal static bool Id(string? value, int maximumLength)
        => !string.IsNullOrWhiteSpace(value) && value!.Length <= maximumLength && value.All(character => character >= 0x20 && character != '\r' && character != '\n');

    internal static bool RevitVersion(string? value)
        => value == "2023" || value == "2024" || value == "2025";

    internal static void RequireDistinct(IEnumerable<string>? values, int maximumCount, int maximumLength, string label)
    {
        if (values == null) throw new ArgumentException("Dynamic " + label + " collection is missing.");
        var array = values.ToArray();
        if (array.Length > maximumCount || array.Any(value => !Id(value, maximumLength)) || array.Distinct(StringComparer.Ordinal).Count() != array.Length)
            throw new ArgumentException("Dynamic " + label + " collection is invalid.");
    }
}
