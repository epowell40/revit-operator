using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class ProductionContractsTests
{
    [Fact]
    public void AdmissionV1BindsEveryTrustedFieldAndConsumesReplayOnce()
    {
        var admission = Admission(); var expected = Expectations(admission); var key = RandomNumberGenerator.GetBytes(32);
        admission.AdmissionSignature = DynamicProgramAdmissionV1Policy.Sign(admission, key);
        var replay = new HashSet<string>(StringComparer.Ordinal);
        DynamicProgramAdmissionV1Policy.ValidateAndConsume(admission, expected, key, Now(), replay.Add);
        Assert.Throws<InvalidOperationException>(() => DynamicProgramAdmissionV1Policy.ValidateAndConsume(admission, expected, key, Now(), replay.Add));
    }

    [Fact]
    public void AdmissionV1RejectsStaleDocumentAndAuthorizationSubstitution()
    {
        var admission = Admission(); var expected = Expectations(admission); var key = RandomNumberGenerator.GetBytes(32);
        admission.AdmissionSignature = DynamicProgramAdmissionV1Policy.Sign(admission, key);
        expected.DocumentRevision++;
        Assert.Throws<InvalidOperationException>(() => DynamicProgramAdmissionV1Policy.ValidateAndConsume(admission, expected, key, Now(), _ => true));
        expected.DocumentRevision = admission.DocumentRevision; expected.FinalAuthorizationHash = H("other-auth");
        Assert.Throws<InvalidOperationException>(() => DynamicProgramAdmissionV1Policy.ValidateAndConsume(admission, expected, key, Now(), _ => true));
    }

    [Fact]
    public void EffectBudgetHashIsOrderIndependentButScopeSensitive()
    {
        var first = Budget(); first.AllowedSdkDomains = new[] { "parameters", "elements" };
        var second = Budget(); second.AllowedSdkDomains = new[] { "elements", "parameters" };
        Assert.Equal(first.CanonicalHash(), second.CanonicalHash());
        second.MaximumModifications = 3; second.MaximumDeletes = 1;
        Assert.NotEqual(first.CanonicalHash(), second.CanonicalHash());
    }

    [Fact]
    public void FileCapabilitySetIsOpaqueOrderIndependentAndProgramBound()
    {
        var a = Capability("a", H("program")); var b = Capability("b", H("program"));
        var first = new DynamicFileCapabilitySetV1 { Capabilities = new[] { a, b } };
        var second = new DynamicFileCapabilitySetV1 { Capabilities = new[] { Capability("b", H("program")), Capability("a", H("program")) } };
        Assert.Equal(first.CanonicalHash(), second.CanonicalHash());
        a.ProgramHash = H("different-program");
        Assert.NotEqual(first.CanonicalHash(), second.CanonicalHash());
    }

    [Fact]
    public void GraphV1AcceptsOrderedParameterWritesAndDeterministicHash()
    {
        var first = Node("set_parameter", new[] { "a" }, Array.Empty<string>(), ("parameter_identity", "Comments"), ("value", "one"), ("value_kind", "string"));
        var second = Node("set_parameter", new[] { "a" }, new[] { first.NodeId }, ("parameter_identity", "Comments"), ("value", "two"), ("value_kind", "string"));
        var graph = Graph(first, second); var budget = Budget(); budget.MaximumModifications = 2;
        DynamicOperationGraphV1Admission.Validate(graph, budget, new[] { "set_parameter" });
    }

    [Fact]
    public void GraphV1RejectsCyclesMissingDependenciesAndUnorderedConflicts()
    {
        var one = Node("set_parameter", new[] { "a" }, Array.Empty<string>(), ("parameter_identity", "Comments"), ("value", "one"), ("value_kind", "string"));
        var two = Node("set_parameter", new[] { "a" }, Array.Empty<string>(), ("parameter_identity", "Comments"), ("value", "two"), ("value_kind", "string"));
        var graph = Graph(one, two); var budget = Budget(); budget.MaximumModifications = 2;
        Assert.Throws<ArgumentException>(() => DynamicOperationGraphV1Admission.Validate(graph, budget, new[] { "set_parameter" }));

        one.DependsOn = new[] { H("missing-node") }; one.NodeId = DynamicOperationGraphV1Admission.NodeId(one); graph = Graph(one);
        Assert.Throws<ArgumentException>(() => DynamicOperationGraphV1Admission.Validate(graph, budget, new[] { "set_parameter" }));
    }

    [Fact]
    public void GraphV1RejectsDescriptorOnlyPrimitiveUntilHostAllowsIt()
    {
        var node = Node("create_sheet", Array.Empty<string>(), Array.Empty<string>(), ("number", "A101"), ("name", "Plan"), ("titleblock_type", "tb"));
        var graph = Graph(node); var budget = Budget(); budget.AllowedSdkDomains = new[] { "elements", "parameters", "sheets" }; budget.MaximumCreates = 1; budget.MaximumModifications = 3;
        Assert.Throws<ArgumentException>(() => DynamicOperationGraphV1Admission.Validate(graph, budget, new[] { "move_element", "set_parameter" }));
        DynamicOperationGraphV1Admission.Validate(graph, budget, new[] { "create_sheet" });
    }

    [Fact]
    public void ExternalEffectRequiresStageInspectAndFreshPublishAuthorization()
    {
        var planned = Effect("planned");
        var staged = Effect("staged"); staged.StageManifestHash = H("stage");
        DynamicExternalEffectV1Policy.ValidateTransition(planned, staged, Now());
        var inspected = Effect("inspected"); inspected.StageManifestHash = staged.StageManifestHash; inspected.InspectionReceiptHash = H("inspection");
        DynamicExternalEffectV1Policy.ValidateTransition(staged, inspected, Now());
        var unauthorized = Effect("authorized"); unauthorized.StageManifestHash = staged.StageManifestHash; unauthorized.InspectionReceiptHash = inspected.InspectionReceiptHash;
        Assert.Throws<InvalidOperationException>(() => DynamicExternalEffectV1Policy.ValidateTransition(inspected, unauthorized, Now()));
        unauthorized.PublicationAuthorizationHash = H("authorization");
        DynamicExternalEffectV1Policy.ValidateTransition(inspected, unauthorized, Now());
    }

    [Fact]
    public void RepairIsPreviewOnlyBoundedAndRequiresNewProgramAndAdmission()
    {
        var feedback = new DynamicProgramRepairFeedbackV1 { AttemptId = "attempt-1", AttemptNumber = 1, Phase = "preview", FailureClass = "compiler", ProgramHash = H("program-a"), AdmissionId = "admission-a", StructuredEvidenceHash = H("feedback") };
        DynamicProgramRepairPolicyV1.ValidatePreviewRepair(feedback, H("program-b"), "admission-b", 3);
        feedback.Phase = "apply";
        Assert.Throws<InvalidOperationException>(() => DynamicProgramRepairPolicyV1.ValidatePreviewRepair(feedback, H("program-c"), "admission-c", 3));
    }

    [Fact]
    public void StrategyEvidenceIsExplicitlyNonAuthoritative()
    {
        var evidence = new DynamicExecutionStrategyEvidenceV1 { ObjectiveHash = H("objective"), SelectedSubstrate = "dynamic_program", ReasonCode = "custom_loop", ReasonSummary = "A bounded loop avoids many equivalent calls.", ModelIdentityHash = H("model"), RecordedUnixSeconds = Now() };
        evidence.Validate();
        Assert.False(evidence.IsAuthorization);
    }

    [Fact]
    public void PrimitiveManifestIsStableAndSeparatesDescriptorsFromImplementedHostOps()
    {
        Assert.StartsWith("sha256:", DynamicPrimitiveManifestV1.ManifestHash);
        Assert.True(DynamicPrimitiveManifestV1.Find("move_element")!.ImplementedByV1Host);
        Assert.False(DynamicPrimitiveManifestV1.Find("create_sheet")!.ImplementedByV1Host);
        Assert.Null(DynamicPrimitiveManifestV1.Find("layout_receptacles_like_room"));
    }

    private static DynamicProgramAdmissionV1 Admission()
    {
        var now = Now();
        return new DynamicProgramAdmissionV1
        {
            AdmissionId = "admission-1", NormalizedSourceHash = H("source"), CompiledArtifactHash = H("artifact"), CompilerRuntimeHash = H("compiler"),
            SdkVersion = "dynamic-revit-sdk/v1", SdkManifestHash = H("sdk-manifest"), SdkArtifactHash = H("sdk-artifact"), WorkerExecutableHash = H("worker"),
            WorkerRuntimePackageHash = H("worker-package"), SandboxProfileVersion = "windows-appcontainer/v2", SandboxProfileHash = H("sandbox"),
            AuthenticatedWorkerIdentityHash = H("worker-identity"), TargetRevitVersion = "2024", HostAdapterManifestHash = H("host-adapter"),
            DocumentFingerprint = H("document"), DocumentSessionId = "document-session", DocumentRevision = 12, ProjectContextIdentityHash = H("context"),
            CapabilityEnvelopeHash = H("capabilities"), OperationFamilyEnvelopeHash = H("operations"), EffectBudgetHash = H("budget"), FileCapabilitySetHash = H("files"),
            OperationGraphHash = H("graph"), PreviewReceiptHash = H("preview"), PolicyIdentityHash = H("policy"), RuntimeIdentityHash = H("runtime"),
            RequestFamilySealHash = H("family"), FinalAuthorizationHash = H("authorization"), PrincipalIdHash = H("principal"), PrincipalSessionHash = H("principal-session"),
            CorrelationId = "correlation", ReplayNonceHash = H("nonce"), IssuedUnixSeconds = now - 1, ExpiresUnixSeconds = now + 60
        };
    }

    private static DynamicProgramAdmissionExpectationsV1 Expectations(DynamicProgramAdmissionV1 value) => new()
    {
        NormalizedSourceHash = value.NormalizedSourceHash, CompiledArtifactHash = value.CompiledArtifactHash, SdkManifestHash = value.SdkManifestHash,
        SdkArtifactHash = value.SdkArtifactHash, WorkerRuntimePackageHash = value.WorkerRuntimePackageHash, SandboxProfileHash = value.SandboxProfileHash,
        AuthenticatedWorkerIdentityHash = value.AuthenticatedWorkerIdentityHash, TargetRevitVersion = value.TargetRevitVersion, HostAdapterManifestHash = value.HostAdapterManifestHash,
        DocumentFingerprint = value.DocumentFingerprint, DocumentSessionId = value.DocumentSessionId, DocumentRevision = value.DocumentRevision,
        ProjectContextIdentityHash = value.ProjectContextIdentityHash, CapabilityEnvelopeHash = value.CapabilityEnvelopeHash,
        OperationFamilyEnvelopeHash = value.OperationFamilyEnvelopeHash, EffectBudgetHash = value.EffectBudgetHash, FileCapabilitySetHash = value.FileCapabilitySetHash,
        OperationGraphHash = value.OperationGraphHash, PreviewReceiptHash = value.PreviewReceiptHash, PolicyIdentityHash = value.PolicyIdentityHash,
        RuntimeIdentityHash = value.RuntimeIdentityHash, RequestFamilySealHash = value.RequestFamilySealHash, FinalAuthorizationHash = value.FinalAuthorizationHash,
        PrincipalIdHash = value.PrincipalIdHash, PrincipalSessionHash = value.PrincipalSessionHash
    };

    private static DynamicEffectBudgetV1 Budget() => new()
    {
        BudgetId = "budget-1", TargetDocumentFingerprints = new[] { H("document") }, AllowedCategories = new[] { "Mechanical Equipment" },
        ExplicitTargetUniqueIds = new[] { "a", "b" }, AllowedSdkDomains = new[] { "elements", "parameters" }, AllowedExternalEffectClasses = Array.Empty<string>(),
        MaximumOperationCount = 4, MaximumAffectedElements = 4, MaximumCreates = 0, MaximumModifications = 4, MaximumDeletes = 0,
        MaximumExecutionMilliseconds = 30000, MaximumRegenerations = 4, MaximumOutputCount = 0, MaximumOutputBytes = 0, FileCapabilitySetHash = H("file-set")
    };

    private static DynamicFileCapabilityV1 Capability(string id, string program) => new()
    {
        CapabilityId = id, Kind = "selected_input", Access = "read", Scope = "file", CanonicalLocationHash = H("path-" + id),
        AllowedExtensions = new[] { ".rfa" }, MaximumOutputCount = 0, MaximumOutputBytes = 0, TaskIdHash = H("task"),
        ProgramHash = program, DocumentFingerprint = H("document"), PrincipalIdHash = H("principal"), ExpiresUnixSeconds = Now() + 60, MaximumUseCount = 1
    };

    private static DynamicOperationNodeV1 Node(string kind, string[] targets, string[] dependencies, params (string Key, string Value)[] attributes)
    {
        var node = new DynamicOperationNodeV1 { Kind = kind, TargetUniqueIds = targets, DependsOn = dependencies, Attributes = new Dictionary<string, string>(StringComparer.Ordinal) };
        foreach (var attribute in attributes) ((Dictionary<string, string>)node.Attributes)[attribute.Key] = attribute.Value;
        node.NodeId = DynamicOperationGraphV1Admission.NodeId(node);
        return node;
    }

    private static DynamicOperationGraphV1 Graph(params DynamicOperationNodeV1[] nodes)
    {
        var graph = new DynamicOperationGraphV1 { InputHash = H("input"), DocumentFingerprint = H("document"), DocumentRevision = 12, Nodes = nodes };
        graph.GraphHash = DynamicOperationGraphV1Admission.GraphHash(graph); return graph;
    }

    private static DynamicExternalEffectV1 Effect(string state) => new()
    {
        EffectId = "effect-1", EffectClass = "export", State = state, PlanHash = H("plan"), FileCapabilityId = "destination-1",
        DocumentSessionId = "document-session", ExpiresUnixSeconds = Now() + 60
    };

    private static string H(string value) => DynamicWire.Sha256(value);
    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
}
