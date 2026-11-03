using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace RevitOperator.DynamicRevitSdk.Tests;

public sealed class NativeProgramArtifactTests
{
    private static string H(string s) => DynamicWire.Sha256(s);
    private static DynamicNativeReferenceV1[] References() => new[] { "mscorlib", "System", "System.Core", "RevitAPI" }
        .Select(n => new DynamicNativeReferenceV1 { Name = n, Version = n == "RevitAPI" ? "24.3.30.0" : "4.0.0.0", Sha256 = H(n) }).ToArray();
    // Synthetic bytes exercise binding only. Actual compiler/PE integration is
    // tested by NativeProgramCompilerTests against the installed SDK metadata.
    private static DynamicNativeProgramArtifactV1 Artifact() => new()
    {
        RevitYear = 2024, Mode = "write", EntryType = "NativeTask", SourceHash = H("source"),
        Assembly = new byte[] { 1, 2, 3 }, AssemblyHash = DynamicWire.Sha256(new byte[] { 1, 2, 3 }), References = References(),
        DirectNativeMembers = new[] { new DynamicNativeMemberV1 { Id = "M:Autodesk.Revit.DB.Parameter.Set(System.String)", DeclaringType = "Autodesk.Revit.DB.Parameter", Name = "Set", MutationHint = true } }
    };
    private static DynamicNativeProgramScopeV1 Scope() => new()
    {
        DocumentFingerprint = H("doc"), DocumentSessionId = "session", DocumentRevision = 4, NativeScopeHash = H("scope"),
        AllowedExistingElementIds = new long[] { 2, 1 }, MaxAffectedElements = 4, DeadlineMs = 5000
    };
    private static string Current(DynamicNativeProgramArtifactV1 a, DynamicNativeProgramScopeV1 s) =>
        DynamicNativeProgramArtifactPolicyV1.ValidateCurrentBinding(a, s, References(), H("source"), H("doc"), "session", 4, H("scope"));
    private static DynamicWorkerAdmission Sign(DynamicNativeProgramArtifactV1 a, DynamicNativeProgramScopeV1 s, byte[] key) {
        var receipt = new DynamicWorkerAdmission { RuntimeInstanceId = "runtime", LauncherExecutableHash = H("launcher"),
            WorkerExecutableHash = H("worker"), WorkerProcessId = 42, SandboxProfile = "windows-lpac-v1-zero-capabilities",
            SourceHash = a.SourceHash, ProgramHash = a.AssemblyHash, SdkHash = H("sdk"),
            OperationGraphHash = Current(a, s), DocumentFingerprint = s.DocumentFingerprint, DocumentSessionId = s.DocumentSessionId,
            StartupNonceHash = H("nonce"), TaskDirectoryIdentity = H("directory"), CorrelationId = "one-use", ExpiresUnixSeconds = 1100 };
        receipt.Signature = DynamicWire.SignAdmission(receipt, key); return receipt;
    }
    private static void Admit(DynamicWorkerAdmission r, DynamicNativeProgramArtifactV1 a, DynamicNativeProgramScopeV1 s, byte[] key) =>
        DynamicWorkerAdmissionPolicy.Validate(r, key, H("launcher"), "windows-lpac-v1-zero-capabilities", a.SourceHash, a.AssemblyHash,
            H("sdk"), Current(a, s), s.DocumentFingerprint, s.DocumentSessionId, 1000);

    [Fact]
    public void CanonicalArtifactAndScopeReuseExistingSignedAdmissionWithoutGrantingExecution()
    {
        var a = Artifact(); var s = Scope(); var key = new byte[32]; key[0] = 17;
        var receipt = Sign(a, s, key); Admit(receipt, a, s, key);
        a.References = a.References.Reverse().ToArray(); s.AllowedExistingElementIds = new long[] { 1, 2 };
        Admit(receipt, a, s, key);
        Assert.False(a.ExecutionAuthorized);
        Assert.NotEqual(DynamicNativeProgramArtifactPolicyV1.ArtifactHash(a), Current(a, s));
    }

    [Theory]
    [InlineData("source")][InlineData("document")][InlineData("session")][InlineData("revision")][InlineData("scope")][InlineData("reference")]
    public void StaleForeignSourceScopeAndRehashedReferenceClaimsReject(string field)
    {
        var a = Artifact(); var s = Scope();
        switch (field) { case "source": a.SourceHash = H("other"); break; case "document": s.DocumentFingerprint = H("other"); break;
            case "session": s.DocumentSessionId = "other"; break; case "revision": s.DocumentRevision++; break;
            case "scope": s.NativeScopeHash = H("other"); break; case "reference": a.References[0].Sha256 = H("other"); break; }
        Assert.Throws<InvalidOperationException>(() => Current(a, s));
    }

    [Theory]
    [InlineData("bytes")][InlineData("entry")][InlineData("member")][InlineData("targets")][InlineData("create")][InlineData("cap")][InlineData("deadline")]
    public void ChangingCompiledProgramOrEffectBudgetCannotReuseSignedAdmission(string field)
    {
        var a = Artifact(); var s = Scope(); var key = new byte[32]; key[0] = 17; var receipt = Sign(a, s, key);
        switch (field) { case "bytes": a.Assembly[0] = 4; a.AssemblyHash = DynamicWire.Sha256(a.Assembly); break;
            case "entry": a.EntryType = "Another"; break; case "member": a.DirectNativeMembers[0].MutationHint = false; break;
            case "targets": s.AllowedExistingElementIds = new long[] { 1, 3 }; break; case "create": s.AllowCreate = true; break;
            case "cap": s.MaxAffectedElements++; break; case "deadline": s.DeadlineMs++; break; }
        Assert.Throws<InvalidOperationException>(() => Admit(receipt, a, s, key));
    }

    [Fact]
    public void ForgedSignatureExpiredAdmissionAndGraphReceiptDoNotAuthorizeNativeProgram()
    {
        var a = Artifact(); var s = Scope(); var key = new byte[32]; var r = Sign(a, s, key);
        r.Signature = "hmac-sha256:" + new string('0', 64); Assert.Throws<InvalidOperationException>(() => Admit(r, a, s, key));
        r = Sign(a, s, key); r.ExpiresUnixSeconds = 999; r.Signature = DynamicWire.SignAdmission(r, key);
        Assert.Throws<InvalidOperationException>(() => Admit(r, a, s, key));
        r = Sign(a, s, key); r.OperationGraphHash = H("some-other-graph"); r.Signature = DynamicWire.SignAdmission(r, key);
        Assert.Throws<InvalidOperationException>(() => Admit(r, a, s, key));
    }

    [Fact]
    public void ReadArtifactCannotAcquireWriteScopeOrHideRecognizedMutation()
    {
        var a = Artifact(); a.Mode = "read"; var s = Scope();
        Assert.Throws<InvalidOperationException>(() => Current(a, s));
        a.DirectNativeMembers = Array.Empty<DynamicNativeMemberV1>();
        Assert.Throws<InvalidOperationException>(() => Current(a, s));
        s.AllowedExistingElementIds = Array.Empty<long>(); s.MaxAffectedElements = 0;
        Assert.NotEmpty(Current(a, s));
        s.AllowCreate = true; Assert.Throws<InvalidOperationException>(() => Current(a, s));
    }

    [Fact]
    public void MalformedCountsDuplicateIdsUnpinnedReferencesAndTamperedBytesFailClosed()
    {
        var a = Artifact(); a.Assembly[0] = 99; Assert.Throws<InvalidOperationException>(() => Current(a, Scope()));
        a = Artifact(); a.References = a.References.Concat(new[] { a.References[0] }).ToArray(); Assert.Throws<InvalidOperationException>(() => Current(a, Scope()));
        a = Artifact(); a.DirectNativeMembers = new[] { a.DirectNativeMembers[0], a.DirectNativeMembers[0] }; Assert.Throws<InvalidOperationException>(() => Current(a, Scope()));
        a = Artifact(); a.DirectNativeMembers = null!; Assert.Throws<InvalidOperationException>(() => Current(a, Scope()));
        a = Artifact(); a.EntryType = "Entry\nForged"; Assert.Throws<InvalidOperationException>(() => Current(a, Scope()));
        a = Artifact(); var s = Scope(); s.AllowedExistingElementIds = new long[] { 1, 1 }; Assert.Throws<InvalidOperationException>(() => Current(a, s));
        s = Scope(); s.MaxAffectedElements = 65; Assert.Throws<InvalidOperationException>(() => Current(a, s));
        s = Scope(); s.DeadlineMs = 10001; Assert.Throws<InvalidOperationException>(() => Current(a, s));
    }
}
