using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace RevitOperator.DynamicRevitSdk;

// Data exchanged by the native-target compiler and the existing trusted runtime.
// These facts do not grant execution. The host must validate the authenticated
// compiler receipt, current document/scope, member policy and transaction lane.
public sealed class DynamicNativeReferenceV1
{
    public string Name { get; set; } = "";
    public string Version { get; set; } = "";
    public string Sha256 { get; set; } = "";
}

public sealed class DynamicNativeMemberV1
{
    public string Id { get; set; } = "";
    public string DeclaringType { get; set; } = "";
    public string Name { get; set; } = "";
    public bool MutationHint { get; set; }
}

public sealed class DynamicNativeProgramArtifactV1
{
    public string Schema { get; set; } = DynamicNativeProgramArtifactPolicyV1.Schema;
    public int RevitYear { get; set; }
    public string Mode { get; set; } = "";
    public string EntryType { get; set; } = "";
    public string SourceHash { get; set; } = "";
    public string AssemblyHash { get; set; } = "";
    public byte[] Assembly { get; set; } = Array.Empty<byte>();
    public IReadOnlyList<DynamicNativeReferenceV1> References { get; set; } = Array.Empty<DynamicNativeReferenceV1>();
    public IReadOnlyList<DynamicNativeMemberV1> DirectNativeMembers { get; set; } = Array.Empty<DynamicNativeMemberV1>();
    public bool ExecutionAuthorized => false;
}

public sealed class DynamicNativeProgramScopeV1
{
    public string EffectScope { get; set; } = "listed_elements";
    public string DocumentFingerprint { get; set; } = "";
    public string DocumentSessionId { get; set; } = "";
    public long DocumentRevision { get; set; }
    public string NativeScopeHash { get; set; } = "";
    public IReadOnlyList<long> AllowedExistingElementIds { get; set; } = Array.Empty<long>();
    public bool AllowCreate { get; set; }
    public int MaxAffectedElements { get; set; }
    // Cooperative/checkpoint budget only. No claim of interrupting a blocked API.
    public int DeadlineMs { get; set; }
}

public static class DynamicNativeProgramArtifactPolicyV1
{
    public const string Schema = "dynamic-revit-native-compile-artifact/v1";

    public static void ValidateHostApiVersion(DynamicNativeProgramArtifactV1 artifact, Version? actualVersion)
    {
        if (artifact == null || actualVersion == null ||
            !DynamicNativeTargetProfile.MatchesAssembly(artifact.RevitYear, "RevitAPI", actualVersion.ToString()) ||
            artifact.References == null || artifact.References.Count(r => r.Name == "RevitAPI") != 1 ||
            artifact.References.Single(r => r.Name == "RevitAPI").Version != actualVersion.ToString())
            throw new InvalidOperationException("Native program target differs from this Revit host.");
    }

    public static string ArtifactHash(DynamicNativeProgramArtifactV1 artifact)
    {
        if (artifact == null || artifact.Schema != Schema || !DynamicNativeTargetProfile.Supports(artifact.RevitYear) ||
            (artifact.Mode != "read" && artifact.Mode != "write") || !Text(artifact.EntryType, 256) ||
            !Hash(artifact.SourceHash) || !Hash(artifact.AssemblyHash) || artifact.Assembly == null ||
            artifact.Assembly.Length < 1 || artifact.Assembly.Length > 1024 * 1024 ||
            DynamicWire.Sha256(artifact.Assembly) != artifact.AssemblyHash)
            throw new InvalidOperationException("Native program artifact identity or bytes are invalid.");
        ValidateReferences(artifact.References, artifact.RevitYear);
        var members = artifact.DirectNativeMembers;
        if (members == null || members.Count > 512 || members.Any(m => m == null || !Text(m.Id, 2048) ||
            !Text(m.DeclaringType, 512) || !m.DeclaringType.StartsWith("Autodesk.Revit.", StringComparison.Ordinal) ||
            !Text(m.Name, 256)) || members.Select(m => m.Id).Distinct(StringComparer.Ordinal).Count() != members.Count ||
            artifact.Mode == "read" && members.Any(m => m.MutationHint))
            throw new InvalidOperationException("Native program direct-member facts are invalid or conflict with read mode.");
        var text = new StringBuilder();
        Add(text, Schema); Add(text, artifact.RevitYear.ToString(CultureInfo.InvariantCulture));
        Add(text, artifact.Mode); Add(text, artifact.EntryType); Add(text, artifact.SourceHash); Add(text, artifact.AssemblyHash);
        foreach (var reference in artifact.References.OrderBy(r => r.Name, StringComparer.Ordinal))
        { Add(text, reference.Name); Add(text, reference.Version); Add(text, reference.Sha256); }
        Add(text, members.Count.ToString(CultureInfo.InvariantCulture));
        foreach (var member in members.OrderBy(m => m.Id, StringComparer.Ordinal))
        { Add(text, member.Id); Add(text, member.DeclaringType); Add(text, member.Name); Add(text, member.MutationHint ? "1" : "0"); }
        return DynamicWire.Sha256(text.ToString());
    }

    // Fits the existing signed admission's OperationGraphHash slot. Its distinct
    // domain binds the program AND scope; it cannot be mistaken for a graph hash.
    public static string BindingHash(DynamicNativeProgramArtifactV1 artifact, DynamicNativeProgramScopeV1 scope)
    {
        var artifactHash = ArtifactHash(artifact);
        if (scope == null || (scope.EffectScope!="listed_elements" && scope.EffectScope!="active_document") || !Hash(scope.DocumentFingerprint) || !Text(scope.DocumentSessionId, 128) ||
            scope.DocumentRevision < 0 || !Hash(scope.NativeScopeHash) || scope.DeadlineMs < 250 || scope.DeadlineMs > 10000 ||
            scope.AllowedExistingElementIds == null || scope.AllowedExistingElementIds.Count > 64 ||
            scope.AllowedExistingElementIds.Any(id => id <= 0) ||
            scope.AllowedExistingElementIds.Distinct().Count() != scope.AllowedExistingElementIds.Count ||
            artifact.Mode == "read" && (scope.EffectScope!="listed_elements" || scope.AllowCreate || scope.MaxAffectedElements != 0 || scope.AllowedExistingElementIds.Count != 0) ||
            artifact.Mode == "write" && scope.EffectScope=="listed_elements" && (scope.MaxAffectedElements < 1 || scope.MaxAffectedElements > 64) ||
            scope.EffectScope=="active_document" && (artifact.Mode!="write" || scope.AllowCreate || scope.MaxAffectedElements!=0 || scope.AllowedExistingElementIds.Count!=0))
            throw new InvalidOperationException("Native program document/effect scope is invalid.");
        var text = new StringBuilder(); Add(text, "dynamic-revit-native-program-binding/v1"); Add(text, artifactHash);
        Add(text, scope.DocumentFingerprint); Add(text, scope.DocumentSessionId);
        Add(text, scope.DocumentRevision.ToString(CultureInfo.InvariantCulture)); Add(text, scope.NativeScopeHash);
        Add(text, scope.AllowCreate ? "1" : "0"); Add(text, scope.MaxAffectedElements.ToString(CultureInfo.InvariantCulture));
        Add(text, scope.DeadlineMs.ToString(CultureInfo.InvariantCulture));
        foreach (var id in scope.AllowedExistingElementIds.OrderBy(id => id)) Add(text, id.ToString(CultureInfo.InvariantCulture));
        // Preserve legacy binding bytes, but never let a listed-element grant
        // authorize document-scoped execution (or the reverse).
        if(scope.EffectScope=="active_document") Add(text,"effect-scope:active_document/v1");
        return DynamicWire.Sha256(text.ToString());
    }

    // Trusted inputs must come from the installed host and current native scope,
    // never be copied from the worker's claims. No loader or execution route is
    // enabled by this data validation; replay consumption remains host-owned.
    public static string ValidateCurrentBinding(DynamicNativeProgramArtifactV1 artifact, DynamicNativeProgramScopeV1 scope,
        IReadOnlyList<DynamicNativeReferenceV1> trustedReferences, string expectedSourceHash,
        string fingerprint, string sessionId, long revision, string nativeScopeHash)
    {
        var hash = BindingHash(artifact, scope);
        ValidateReferences(trustedReferences, artifact.RevitYear);
        if (artifact.SourceHash != expectedSourceHash || scope.DocumentFingerprint != fingerprint ||
            scope.DocumentSessionId != sessionId || scope.DocumentRevision != revision || scope.NativeScopeHash != nativeScopeHash)
            throw new InvalidOperationException("Native program source/document/scope binding is stale or foreign.");
        foreach (var reference in artifact.References)
        {
            var expected = trustedReferences.Single(r => r.Name == reference.Name);
            if (reference.Version != expected.Version || reference.Sha256 != expected.Sha256)
                throw new InvalidOperationException("Native program references differ from the installed trusted target.");
        }
        return hash;
    }

    private static void ValidateReferences(IReadOnlyList<DynamicNativeReferenceV1> references, int year)
    {
        var names = DynamicNativeTargetProfile.ReferenceNames(year);
        if (references == null || references.Count != names.Length || references.Any(r => r == null || !Text(r.Version, 64) || !Hash(r.Sha256)
                || !DynamicNativeTargetProfile.MatchesAssembly(year, r.Name, r.Version)) ||
            !references.Select(r => r.Name).OrderBy(n => n, StringComparer.Ordinal).SequenceEqual(names))
            throw new InvalidOperationException("Native program requires exactly the pinned target reference identities.");
    }
    private static bool Hash(string value) => value != null && value.Length == 71 && value.StartsWith("sha256:", StringComparison.Ordinal) &&
        value.Substring(7).All(c => c >= '0' && c <= '9' || c >= 'a' && c <= 'f');
    private static bool Text(string value, int max) => !string.IsNullOrWhiteSpace(value) && value.Length <= max && !value.Any(char.IsControl);
    private static void Add(StringBuilder builder, string value) => builder.Append(value.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(value).Append('\n');
}
