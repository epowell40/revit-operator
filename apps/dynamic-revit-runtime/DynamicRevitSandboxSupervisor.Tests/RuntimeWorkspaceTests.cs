using System.Text.Json;
using RevitOperator.DynamicRevitSandboxSupervisor;
using RevitOperator.DynamicRevitSdk;
using WorkerExecutor = RevitOperator.DynamicRevitWorker.WorkerExecutor;
using WorkerInput = RevitOperator.DynamicRevitWorker.WorkerInput;
using Xunit;

namespace DynamicRevitSandboxSupervisor.Tests;

public sealed class RuntimeWorkspaceTests
{
    [Fact]
    public void BridgeTimeoutOutlivesBoundedWorkerAndApplyWindows()
    {
        Assert.Equal(TimeSpan.FromSeconds(90), Program.BridgeRequestTimeoutForTests);
        Assert.True(Program.BridgeRequestTimeoutForTests > TimeSpan.FromSeconds(35));
    }

    [Fact]
    public void SignedContextRuleIsExactScopedExpiringAndFailsClosedOutsideLaboratory()
    {
        using var temporary = new TemporaryDirectory(); var root = temporary.CreateDirectory("context");
        var key = Enumerable.Range(1, 32).Select(value => (byte)value).ToArray(); var keyPath = Path.Combine(root, "key.txt");
        File.WriteAllText(keyPath, Convert.ToBase64String(key));
        var input = new DynamicTaskInput { Document = new DynamicDocumentDto { ProjectFingerprint = DynamicWire.Sha256("project"), SessionId = "session", ActiveViewId = 77 } };
        var record = RuleRecord(input.Document.ProjectFingerprint, 77, 2_000_000_000);
        record.RecordHash = DynamicContextRulePolicyV1.RecordHash(record); record.Signature = Program.ContextRuleSignature(record.RecordHash, key);
        var recordPath = Path.Combine(root, "rule.json");
        File.WriteAllText(recordPath, JsonSerializer.Serialize(record, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));

        Assert.Equal(record.RecordHash, Program.VerifyContextRuleRecord(recordPath, keyPath, input, "company-a", "user-a", 2_000_000_010).RecordHash);
        Assert.Throws<InvalidOperationException>(() => Program.VerifyContextRuleRecord(recordPath, keyPath, input, "company-b", "user-a", 2_000_000_010));
        record.Signature = Program.ContextRuleSignature(DynamicWire.Sha256("forged"), key);
        File.WriteAllText(recordPath, JsonSerializer.Serialize(record, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
        Assert.Throws<InvalidOperationException>(() => Program.VerifyContextRuleRecord(recordPath, keyPath, input, "company-a", "user-a", 2_000_000_010));

        var oldMode = Environment.GetEnvironmentVariable("REVIT_OPERATOR_MODE"); var oldExposure = Environment.GetEnvironmentVariable("OPERATOR_TOOL_EXPOSURE_PROFILE");
        try
        {
            Environment.SetEnvironmentVariable("REVIT_OPERATOR_MODE", "production"); Environment.SetEnvironmentVariable("OPERATOR_TOOL_EXPOSURE_PROFILE", "laboratory");
            Assert.Throws<InvalidOperationException>(Program.RequireDevelopmentLaboratory);
            Environment.SetEnvironmentVariable("REVIT_OPERATOR_MODE", "development"); Assert.Null(Record.Exception(Program.RequireDevelopmentLaboratory));
        }
        finally { Environment.SetEnvironmentVariable("REVIT_OPERATOR_MODE", oldMode); Environment.SetEnvironmentVariable("OPERATOR_TOOL_EXPOSURE_PROFILE", oldExposure); }
    }

    [Fact]
    public void GeneratedCoreSourceDerivesRuleTargetAndEveryMutationBindingFromVerifiedContext()
    {
        var input = new DynamicTaskInput { Document = new DynamicDocumentDto { ProjectFingerprint = DynamicWire.Sha256("project"), SessionId = "session", ActiveViewId = 77 }, OperationBudget = 4 };
        var parameter = new DynamicParameterValueV1 { Identity = "parameter:builtin:-1001203", Name = "Mark", StorageKind = "string", HasValue = true, RawString = "MATCH", Scope = "instance", Writable = true };
        var actionParameter = new DynamicParameterValueV1 { Identity = "parameter:builtin:-1001205", Name = "Comments", StorageKind = "string", HasValue = true, RawString = "", Scope = "instance", Writable = true };
        var element = new DynamicObservedElementV1
        {
            Element = new DynamicStableReferenceV1 { Kind = "element", StableId = "revit-element:candidate-1", UniqueId = "candidate-1", ElementId = 10 },
            Category = new DynamicStableReferenceV1 { Kind = "category", StableId = "category:builtin:OST_ElectricalFixtures", ElementId = -1 },
            CoreStateHash = DynamicWire.Sha256("exact-core-state"), Parameters = new[] { parameter, actionParameter }
        };
        var selector = new DynamicObservationSelectorV1 { CategoryStableIds = new[] { element.Category.StableId }, VisibleInViewElementId = 77, ParameterNames = new[] { "Comments", "Mark" }, PageSize = 16 };
        var page = DynamicObservationPolicyV1.BuildPage(selector, input.Document.ProjectFingerprint, input.Document.SessionId, new[] { element });
        var record = RuleRecord(input.Document.ProjectFingerprint, 77, 2_000_000_000); record.RecordHash = DynamicContextRulePolicyV1.RecordHash(record);
        var rule = new DynamicVerifiedContextRuleV1
        {
            RecordId = record.RecordId, RecordHash = record.RecordHash, CompanyId = record.CompanyId, ProjectFingerprint = record.ProjectFingerprint, UserId = record.UserId,
            ActiveViewElementId = record.ActiveViewElementId, TargetCategoryStableIds = record.TargetCategoryStableIds, Conditions = record.Conditions, Action = record.Action,
            IssuedUnixSeconds = record.IssuedUnixSeconds, ExpiresUnixSeconds = record.ExpiresUnixSeconds, VerificationKeyHash = DynamicWire.Sha256("key"),
            WorkerRuntimePackageHash = DynamicWire.Sha256("package"), ObservationScopeHash = page.ScopeHash, ObservationRevisionHash = page.RevisionHash
        };
        rule.BindingHash = DynamicContextRulePolicyV1.BindingHash(rule);
        const string source = """
using System.Linq;
using RevitOperator.DynamicRevitSdk;
public sealed class Generated : IDynamicCoreRevitProgramV1 {
  public DynamicCoreProgramResultV1 Execute(DynamicCoreProgramContextV1 c) {
    var condition = c.Rule.Conditions.Single(); var action = c.Rule.Action;
    foreach (var candidate in c.Candidates) {
      var observed = candidate.Parameters.SingleOrDefault(p => p.Identity == condition.ParameterIdentity && p.Scope == condition.ParameterScope);
      if (observed == null || observed.StorageKind != condition.ValueKind || observed.RawString != condition.RawValue) continue;
      var target = candidate.Parameters.Single(p => p.Identity == action.ParameterIdentity && p.Scope == action.ParameterScope);
      c.Plan.SetString(candidate.Element.UniqueId, action.ParameterIdentity, action.ParameterScope, action.RawValue,
        candidate.CoreStateHash, DynamicCoreOperationStateV1.ParameterStateHash(target));
    }
    c.Report("context_rule_record_id", c.Rule.RecordId); c.Report("context_rule_record_hash", c.Rule.RecordHash); return c.Complete();
  }
}
""";
        var output = WorkerExecutor.Execute(new WorkerInput { Source = source, Input = input, ResultReferenceDocumentRevision = 123, VerifiedContextRule = rule, ContextObservationPages = new[] { page } });

        Assert.True(output.Ok, string.Join("; ", output.Diagnostics.Select(value => value.Code + ":" + value.Message)));
        var graph = Assert.IsType<DynamicOperationGraphV1>(output.CoreProgramResult?.Graph);
        Assert.Equal("candidate-1", graph.Nodes.Single().TargetUniqueIds.Single());
        Assert.Equal(element.CoreStateHash, graph.Nodes.Single().Attributes["expected_target_state_hash"]);
        Assert.Equal(DynamicCoreOperationStateV1.ParameterStateHash(actionParameter), graph.Nodes.Single().Attributes["expected_parameter_state_hash"]);
        Assert.Equal(rule.RecordId, graph.ContextRuleRecordId); Assert.Equal(rule.RecordHash, graph.ContextRuleRecordHash); Assert.Equal(rule.BindingHash, graph.ContextRuleBindingHash);
    }
    [Fact]
    public void HostTextNoteSelectorProjectionIsAcceptedBySupervisorObservationContext()
    {
        var adapterPath = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "revit-bridge-addin", "RevitBridge.Logic", "Handlers", "DynamicRuntime", "DynamicBuildingSystemsObservationAdapter.cs"));
        var adapter = File.ReadAllText(adapterPath);
        Assert.Contains("if (element is TextNote) return \"text_note\";", adapter);
        Assert.Contains("Annotation = new DynamicAnnotationObservationFactV1", adapter);
        Assert.Contains("StateHash = DynamicAnnotationRevitStateV1.StateHash(note)", adapter);
        Assert.Contains("element is IndependentTag", adapter);
        Assert.Contains("TagTypeStateHash = DynamicAnnotationRevitStateV1.StateHash(type)", adapter);
        Assert.Contains("OwnerViewStateHash = DynamicAnnotationRevitStateV1.StateHash(ownerView)", adapter);

        var documentHash = DynamicWire.Sha256("text-note-document"); var snapshotHash = DynamicWire.Sha256("text-note-snapshot");
        var stateHash = DynamicWire.Sha256("text-note-state");
        var element = Reference("element", "text-note-a", 41); var type = Reference("type", "text-type-a", 42); var view = Reference("view", "owner-view-a", 43);
        var category = new DynamicStableReferenceV1 { Kind = "category", StableId = "category:builtin:OST_TextNotes", ElementId = -2000300 };
        var fact = new DynamicBuildingSystemsFactV1
        {
            Kind = "text_note", Element = element, Category = category, Type = type, Location = new DynamicPointV1 { X = 1, Y = 2, Z = 0 },
            Annotation = new DynamicAnnotationObservationFactV1
            {
                AnnotationClass = "text_note", TextType = type, OwnerView = view, Text = "REVISE CIRCUIT DESIGNATION", StateHash = stateHash
            }
        };
        var selector = new DynamicBuildingSystemsSelectorV1 { ElementUniqueIds = new[] { "text-note-a" }, Kinds = new[] { "text_note" }, PageSize = 1 };
        var page = DynamicBuildingSystemsObservationPolicyV1.BuildPage(selector, documentHash, "text-note-session", 12, snapshotHash, new[] { fact });
        var trusted = new DynamicTrustedElementFactV1
        {
            UniqueId = "text-note-a", ElementId = 41, DocumentFingerprint = documentHash, CategoryStableId = category.StableId,
            TypeUniqueId = "text-type-a", StateHash = stateHash, Exists = true, Verified = true, Visible = true
        };
        var observation = new ResultReferenceObservationInput
        {
            SnapshotHash = snapshotHash, ScopeHash = page.ScopeHash, DocumentRevision = 12, Selector = selector,
            Pages = new[] { page }, TrustedExternalTargets = new[] { trusted }
        };
        var input = new DynamicTaskInput { Document = new DynamicDocumentDto { ProjectFingerprint = documentHash, SessionId = "text-note-session" } };

        Program.ValidateResultReferenceObservationContext(input, observation);

        trusted.StateHash = DynamicWire.Sha256("substituted-state");
        Assert.Throws<ArgumentException>(() => Program.ValidateResultReferenceObservationContext(input, observation));
    }

    [Fact]
    public void ResultReferenceLaneSelectsOnlyOneActivatedPrimitiveFamily()
    {
        var annotation = new DynamicResultReferenceGraphV1 { Nodes = new[] { new DynamicResultReferenceNodeV1 { Kind = "create_tag" } } };
        var mep = new DynamicResultReferenceGraphV1 { Nodes = new[] { new DynamicResultReferenceNodeV1 { Kind = "create_mep_curve" } } };
        var mixed = new DynamicResultReferenceGraphV1 { Nodes = new[] { new DynamicResultReferenceNodeV1 { Kind = "create_tag" }, new DynamicResultReferenceNodeV1 { Kind = "create_mep_curve" } } };
        Assert.Equal("annotation", Program.ResultReferenceFamily(annotation));
        Assert.Equal("mep", Program.ResultReferenceFamily(mep));
        Assert.Throws<InvalidOperationException>(() => Program.ResultReferenceFamily(mixed));
    }

    [Fact]
    public void WorkerAttestsCompiledIdentityTraceAndDeterministicReplay()
    {
        const string source = """
using System.Collections.Generic;
using RevitOperator.DynamicRevitSdk;
public sealed class Generated : IDynamicResultReferenceRevitProgramV1 {
  public DynamicResultReferenceProgramResultV1 Execute(DynamicResultReferenceProgramContextV1 c) {
    var operation = c.Plan.AddOperation("create_family_instance", null, null,
      new[] { new DynamicResultOutputSpecV1 { OutputSlot="created", ExpectedCategoryStableId="category:builtin:OST_GenericModel", ExpectedTypeUniqueId="type:generic" } },
      new Dictionary<string,string> { ["family_type_identity"]="type:generic", ["placement"]="1,2,3" });
    c.TraceStep("create-instance", "Create one typed instance.", new[] { operation });
    c.Require("one-operation", "create-instance", true, "Exactly one operation was planned.", "cardinality");
    c.Report("planned", "1");
    return c.Complete();
  }
}
""";
        var first = WorkerExecutor.Execute(ExecutionWorkerInput(source));
        var second = WorkerExecutor.Execute(ExecutionWorkerInput(source));

        Assert.True(first.Ok, Diagnostic(first));
        Assert.Equal("completed", first.ExecutionStatus);
        Assert.True(first.DeterministicReplayVerified);
        Assert.Matches("^sha256:[0-9a-f]{64}$", first.CompiledAssemblyHash);
        Assert.Equal(first.CompiledAssemblyHash, second.CompiledAssemblyHash);
        Assert.Equal(first.ExecutionIdentityHash, second.ExecutionIdentityHash);
        var result = Assert.IsType<DynamicResultReferenceProgramResultV1>(first.ResultReferenceProgramResult);
        Assert.Equal(result.Graph.GraphHash, result.ExecutionTrace.GraphHash);
        Assert.Equal(result.Graph.Nodes.Single().NodeId, result.ExecutionTrace.Steps.Single().NodeIds.Single());
    }

    [Fact]
    public void CompilationCacheReusesExactReadmittedAssemblyAndNeverNeedsSourceIndependentTrust()
    {
        const string source = """
using RevitOperator.DynamicRevitSdk;
using System.Collections.Generic;
public sealed class Generated : IDynamicResultReferenceRevitProgramV1 {
  public DynamicResultReferenceProgramResultV1 Execute(DynamicResultReferenceProgramContextV1 c) {
    var node = c.Plan.AddOperation("create_family_instance", null, null,
      new[] { new DynamicResultOutputSpecV1 { OutputSlot="created", ExpectedCategoryStableId="category:builtin:OST_GenericModel", ExpectedTypeUniqueId="type:generic" } },
      new Dictionary<string,string> { ["family_type_identity"]="type:generic", ["placement"]="1,2,3" });
    c.TraceStep("create", "Return one deterministic node.", new[] { node });
    return c.Complete();
  }
}
""";
        using var temporary = new TemporaryDirectory();
        var sourceHash = DynamicWire.Sha256(source.Replace("\r\n", "\n"));
        var compiler = DynamicWire.Sha256("compiler"); var sdk = DynamicWire.Sha256("sdk"); var package = DynamicWire.Sha256("package");
        var key = CompilationCache.Key(sourceHash, compiler, sdk, package);
        var missInput = ExecutionWorkerInput(source); missInput.CompilationCacheKey = key;
        var miss = WorkerExecutor.Execute(missInput);
        Assert.True(miss.Ok, Diagnostic(miss)); Assert.False(miss.CompilationCacheHit); Assert.NotNull(miss.CompiledAssemblyBase64);

        var cache = new CompilationCache(temporary.CreateDirectory("compile-cache"));
        var stored = cache.Store(key, sourceHash, compiler, sdk, package, Convert.FromBase64String(miss.CompiledAssemblyBase64!));
        Assert.True(stored.Hit); Assert.Equal(miss.CompiledAssemblyHash, stored.ArtifactHash);
        var hitInput = ExecutionWorkerInput(source); hitInput.CompilationCacheKey = key; hitInput.CachedAssemblyBase64 = Convert.ToBase64String(stored.Assembly!);
        var hit = WorkerExecutor.Execute(hitInput);

        Assert.True(hit.Ok, Diagnostic(hit)); Assert.True(hit.CompilationCacheHit); Assert.Null(hit.CompiledAssemblyBase64);
        Assert.Equal(miss.CompiledAssemblyHash, hit.CompiledAssemblyHash);
        Assert.Equal(miss.ExecutionIdentityHash, hit.ExecutionIdentityHash);
    }

    [Fact]
    public void CompilationCacheKeyRotatesAndArtifactTamperFailsClosed()
    {
        using var temporary = new TemporaryDirectory(); var root = temporary.CreateDirectory("compile-cache");
        var source = DynamicWire.Sha256("source"); var compiler = DynamicWire.Sha256("compiler");
        var sdk = DynamicWire.Sha256("sdk"); var package = DynamicWire.Sha256("package");
        var key = CompilationCache.Key(source, compiler, sdk, package);
        Assert.NotEqual(key, CompilationCache.Key(DynamicWire.Sha256("changed-source"), compiler, sdk, package));
        Assert.NotEqual(key, CompilationCache.Key(source, DynamicWire.Sha256("changed-compiler"), sdk, package));
        Assert.NotEqual(key, CompilationCache.Key(source, compiler, DynamicWire.Sha256("changed-sdk"), package));
        Assert.NotEqual(key, CompilationCache.Key(source, compiler, sdk, DynamicWire.Sha256("changed-package")));

        var cache = new CompilationCache(root); cache.Store(key, source, compiler, sdk, package, new byte[] { 1, 2, 3, 4 });
        var artifact = Path.Combine(root, key.Substring(7) + ".dll");
        File.SetAttributes(artifact, File.GetAttributes(artifact) & ~FileAttributes.ReadOnly);
        File.WriteAllBytes(artifact, new byte[] { 1, 2, 3, 5 });
        Assert.Throws<InvalidOperationException>(() => cache.TryRead(key, source, compiler, sdk, package));
    }

    [Fact]
    public void CompilationCacheRefusesToClaimAnUnmarkedNonEmptyDirectory()
    {
        using var temporary = new TemporaryDirectory(); var root = temporary.CreateDirectory("foreign-directory");
        File.WriteAllText(Path.Combine(root, "user-data.txt"), "must-not-touch");
        Assert.Throws<InvalidOperationException>(() => new CompilationCache(root));
        Assert.Equal("must-not-touch", File.ReadAllText(Path.Combine(root, "user-data.txt")));
    }

    [Fact]
    public void CompilationCacheConcurrentWritersConvergeOnOneExactImmutableEntry()
    {
        using var temporary = new TemporaryDirectory(); var root = temporary.CreateDirectory("concurrent-cache");
        var source = DynamicWire.Sha256("source"); var compiler = DynamicWire.Sha256("compiler");
        var sdk = DynamicWire.Sha256("sdk"); var package = DynamicWire.Sha256("package");
        var key = CompilationCache.Key(source, compiler, sdk, package); var assembly = Enumerable.Range(0, 4096).Select(value => (byte)(value % 251)).ToArray();
        var cache = new CompilationCache(root);

        Parallel.For(0, 16, _ => cache.Store(key, source, compiler, sdk, package, assembly));

        var lookup = cache.TryRead(key, source, compiler, sdk, package);
        Assert.True(lookup.Hit); Assert.Equal(assembly, lookup.Assembly);
        Assert.Single(Directory.GetFiles(root, "*.dll")); Assert.Single(Directory.GetFiles(root, "*.json"));
        Assert.True((File.GetAttributes(Directory.GetFiles(root, "*.dll").Single()) & FileAttributes.ReadOnly) != 0);
        Assert.True((File.GetAttributes(Directory.GetFiles(root, "*.json").Single()) & FileAttributes.ReadOnly) != 0);
    }

    [Fact]
    public void SanitizedWorkerEvidenceCannotLeakCompiledAssemblyBytes()
    {
        using var document = JsonDocument.Parse("""{"ok":true,"compiledAssemblyHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","compiledAssemblyBase64":"c2VjcmV0","compilationCacheHit":false}""");
        var sanitized = Program.SanitizeWorkerOutput(document.RootElement);
        Assert.False(sanitized.TryGetProperty("compiledAssemblyBase64", out _));
        Assert.Equal("sha256:" + new string('a', 64), sanitized.GetProperty("compiledAssemblyHash").GetString());
    }

    [Fact]
    public void WorkerReturnsBoundedNonAuthorizingNeedFactsInsteadOfGuessing()
    {
        const string source = """
using RevitOperator.DynamicRevitSdk;
public sealed class Generated : IDynamicResultReferenceRevitProgramV1 {
  public DynamicResultReferenceProgramResultV1 Execute(DynamicResultReferenceProgramContextV1 c) {
    c.TraceStep("inspect-connectors", "Inspect exact connector facts before planning.");
    return c.NeedFacts("mechanical-connectors", "Need exact bounded equipment connector facts.",
      new DynamicBuildingSystemsSelectorV1 { Kinds=new[] { "equipment" }, PageSize=32 });
  }
}
""";
        var output = WorkerExecutor.Execute(ExecutionWorkerInput(source));

        Assert.True(output.Ok, Diagnostic(output));
        Assert.Equal("needs_facts", output.ExecutionStatus);
        Assert.True(output.DeterministicReplayVerified);
        var result = Assert.IsType<DynamicResultReferenceProgramResultV1>(output.ResultReferenceProgramResult);
        Assert.Empty(result.Graph.Nodes);
        Assert.NotNull(result.FactRequest);
        Assert.False(result.FactRequest!.AuthorizationGranted);
        Assert.False(result.ExecutionTrace.AuthorizationGranted);
    }

    [Fact]
    public void WorkerReportsExactAssertionRepairCoordinates()
    {
        const string source = """
using RevitOperator.DynamicRevitSdk;
public sealed class Generated : IDynamicResultReferenceRevitProgramV1 {
  public DynamicResultReferenceProgramResultV1 Execute(DynamicResultReferenceProgramContextV1 c) {
    c.TraceStep("select-endpoints", "Select two compatible endpoints.");
    c.Require("two-endpoints", "select-endpoints", false, "Expected exactly two compatible endpoints.", "cardinality");
    return c.Complete();
  }
}
""";
        var output = WorkerExecutor.Execute(ExecutionWorkerInput(source));

        Assert.False(output.Ok);
        var diagnostic = Assert.Single(output.Diagnostics);
        Assert.Equal("PROGRAM_ASSERTION_FAILED", diagnostic.Code);
        Assert.Equal("select-endpoints", diagnostic.StepId);
        Assert.Equal("two-endpoints", diagnostic.AssertionId);
        Assert.True(diagnostic.Retryable);
        Assert.Equal("execute", diagnostic.Phase);
        Assert.Equal("revise_plan_or_request_facts", diagnostic.RepairAction);
        Assert.Matches("^sha256:[0-9a-f]{64}$", output.DiagnosticBundleHash);
    }

    [Fact]
    public void WorkerCompilerDiagnosticsExposeExactRangesStableIdentityAndRepairAction()
    {
        const string source = """
using RevitOperator.DynamicRevitSdk;
public sealed class Generated : IDynamicRevitProgram {
  public DynamicProgramResult Execute(DynamicRevitContext c) {
    var broken = ;
    return c.Complete();
  }
}
""";
        var first = WorkerExecutor.Execute(new WorkerInput { Source = source, Input = new DynamicTaskInput { OperationBudget = 1 } });
        var second = WorkerExecutor.Execute(new WorkerInput { Source = source, Input = new DynamicTaskInput { OperationBudget = 1 } });

        Assert.False(first.Ok);
        var diagnostic = Assert.Single(first.Diagnostics);
        Assert.StartsWith("CS", diagnostic.Code);
        Assert.Equal("compile", diagnostic.Phase);
        Assert.Equal("error", diagnostic.Severity);
        Assert.Equal("edit_source", diagnostic.RepairAction);
        Assert.True(diagnostic.Retryable);
        Assert.NotNull(diagnostic.Line);
        Assert.NotNull(diagnostic.Column);
        Assert.NotNull(diagnostic.EndLine);
        Assert.NotNull(diagnostic.EndColumn);
        Assert.Matches("^sha256:[0-9a-f]{64}$", first.DiagnosticBundleHash);
        Assert.Equal(first.DiagnosticBundleHash, second.DiagnosticBundleHash);
    }

    [Fact]
    public void WorkerRejectsNondeterministicGeneratedOutputBeforePreview()
    {
        const string source = """
using System;
using RevitOperator.DynamicRevitSdk;
public sealed class Generated : IDynamicResultReferenceRevitProgramV1 {
  public DynamicResultReferenceProgramResultV1 Execute(DynamicResultReferenceProgramContextV1 c) {
    c.Report("nonce", Guid.NewGuid().ToString("N"));
    return c.NeedFacts("more-facts", "Request deterministic facts while returning a nondeterministic report.",
      new DynamicBuildingSystemsSelectorV1 { Kinds=new[] { "equipment" }, PageSize=8 });
  }
}
""";
        var output = WorkerExecutor.Execute(ExecutionWorkerInput(source));

        Assert.False(output.Ok);
        var diagnostic = Assert.Single(output.Diagnostics);
        Assert.True(diagnostic.Code == "NONDETERMINISTIC_PROGRAM", Diagnostic(output));
        Assert.Equal("deterministic_replay", diagnostic.Phase);
        Assert.Equal("remove_nondeterminism", diagnostic.RepairAction);
        Assert.Null(output.ResultReferenceProgramResult);
    }

    [Fact]
    public void DeterministicReplayUsesIndependentInputSnapshots()
    {
        const string source = """
using RevitOperator.DynamicRevitSdk;
public sealed class Generated : IDynamicResultReferenceRevitProgramV1 {
  public DynamicResultReferenceProgramResultV1 Execute(DynamicResultReferenceProgramContextV1 c) {
    var observed = c.Input.Document.Title;
    c.Input.Document.Title = "generated-code-mutation";
    c.Report("observed_title", observed);
    return c.NeedFacts("more", "Need one bounded follow-up scope.",
      new DynamicBuildingSystemsSelectorV1 { Kinds=new[] { "equipment" }, PageSize=8 });
  }
}
""";
        var input = ExecutionWorkerInput(source);
        input.Input.Document.Title = "immutable-fixture";

        var output = WorkerExecutor.Execute(input);

        Assert.True(output.Ok, Diagnostic(output));
        Assert.True(output.DeterministicReplayVerified);
        Assert.Equal("immutable-fixture", output.Report["observed_title"]);
        Assert.Equal("immutable-fixture", input.Input.Document.Title);
    }

    [Fact]
    public void RuntimeImageHashesTheExactPackagedDependencySet()
    {
        using var temporary = new TemporaryDirectory();
        var source = temporary.CreateDirectory("source");
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.exe"), "worker");
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.dll"), "managed-worker");
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.deps.json"), "{}");
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.runtimeconfig.json"), "{}");
        File.WriteAllText(Path.Combine(source, "DynamicRevitSdk.dll"), "sdk");
        File.WriteAllText(Path.Combine(source, "debug.pdb"), "symbols");
        var locale = Directory.CreateDirectory(Path.Combine(source, "fr")).FullName;
        File.WriteAllText(Path.Combine(locale, "Microsoft.CodeAnalysis.resources.dll"), "satellite");
        var task = temporary.CreateDirectory("task");

        var image = RuntimeImage.Stage(source, task);

        Assert.Equal(7, image.Files.Count);
        Assert.Contains(image.Files, file => file.RelativePath.EndsWith(".pdb", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(DynamicRuntimePackageDirectoryIdentity.Compute(source), image.Identity);
        Assert.Equal(image.Identity, image.VerifyBeforeLaunch());
        Assert.NotEqual(image.Identity, image.WorkerExecutableHash);
        Assert.NotEqual(image.Identity, image.CompilerRuntimeHash);
        Assert.NotEqual(image.Identity, image.SdkArtifactHash);
        Assert.Equal(image.Files.Single(file => file.RelativePath == "DynamicRevitWorker.exe").Sha256, image.WorkerExecutableHash);
        Assert.Equal(image.Files.Single(file => file.RelativePath == "DynamicRevitSdk.dll").Sha256, image.SdkArtifactHash);
        Assert.All(image.Files, file => Assert.True((File.GetAttributes(Path.Combine(image.Directory, file.RelativePath)) & FileAttributes.ReadOnly) != 0));
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(task, "runtime-image.manifest.json")));
        Assert.Equal("dynamic-revit-runtime-image/v1", manifest.RootElement.GetProperty("schema").GetString());
        Assert.Equal(image.Identity, manifest.RootElement.GetProperty("identity").GetString());
    }

    [Fact]
    public void RuntimeImageRejectsMutationAndAddedDependencyBeforeLaunch()
    {
        using var temporary = new TemporaryDirectory();
        var source = temporary.CreateDirectory("source");
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.exe"), "worker");
        File.WriteAllText(Path.Combine(source, "DynamicRevitSdk.dll"), "sdk");
        File.WriteAllText(Path.Combine(source, "dependency.dll"), "dependency");
        var image = RuntimeImage.Stage(source, temporary.CreateDirectory("task"));
        var dependency = Path.Combine(image.Directory, "dependency.dll");
        File.SetAttributes(dependency, FileAttributes.Normal);
        File.WriteAllText(dependency, "tampered");

        Assert.Throws<InvalidOperationException>(() => image.VerifyBeforeLaunch());

        File.WriteAllText(Path.Combine(image.Directory, "injected.dll"), "injected");
        Assert.Throws<InvalidOperationException>(() => image.VerifyBeforeLaunch());
    }

    [Fact]
    public void RuntimeImageRejectsReparsePointDependenciesWhenSupportedByHost()
    {
        using var temporary = new TemporaryDirectory();
        var source = temporary.CreateDirectory("source");
        var worker = Path.Combine(source, "DynamicRevitWorker.exe");
        File.WriteAllText(worker, "worker");
        File.WriteAllText(Path.Combine(source, "DynamicRevitSdk.dll"), "sdk");
        try
        {
            File.CreateSymbolicLink(Path.Combine(source, "linked.dll"), worker);
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
        {
            return;
        }

        Assert.Throws<InvalidOperationException>(() => RuntimeImage.Stage(source, temporary.CreateDirectory("task")));
    }

    [Fact]
    public void RuntimeImageRejectsAnUnboundedDependencySet()
    {
        using var temporary = new TemporaryDirectory();
        var source = temporary.CreateDirectory("source");
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.exe"), "worker");
        File.WriteAllText(Path.Combine(source, "DynamicRevitSdk.dll"), "sdk");
        for (var index = 0; index < 255; index++) File.WriteAllText(Path.Combine(source, $"dependency-{index:D3}.dll"), "x");

        Assert.Throws<InvalidOperationException>(() => RuntimeImage.Stage(source, temporary.CreateDirectory("task")));
    }

    [Fact]
    public void PreviewModeDoesNotRequireMutationGrantButApplyDoes()
    {
        using var temporary = new TemporaryDirectory();
        var tokenFile = Path.Combine(temporary.CreateDirectory("auth"), "operator_token.txt");
        File.WriteAllText(tokenFile, new string('a', 32));

        Assert.Equal("", Program.ReadWriteGrantForMode(tokenFile, apply: false));
        Assert.Throws<InvalidOperationException>(() => Program.ReadWriteGrantForMode(tokenFile, apply: true));
    }

    [Fact]
    public void ResultReferenceObservationAndNeedsFactsDoNotRequirePrematureMutationAuthority()
    {
        Assert.False(Program.RequiresInitialWriteGrant(new LiveTaskConfig { ResultReference = true, Apply = true }));
        Assert.False(Program.RequiresInitialWriteGrant(new LiveTaskConfig { ResultReference = true, Apply = false }));
        Assert.True(Program.RequiresInitialWriteGrant(new LiveTaskConfig { ResultReference = false, Apply = true }));
    }

    [Fact]
    public void CommittedCheckpointRequiresExactCurrentDocumentSessionAndEchoesNonAuthorizingBinding()
    {
        var hash = "sha256:" + new string('a', 64);
        var config = new LiveTaskConfig
        {
            CheckpointTaskSessionId = "task-" + new string('b', 32), CheckpointIndex = 7, CheckpointHash = hash,
            CheckpointDocumentFingerprint = hash, CheckpointDocumentSessionId = "session-exact", CheckpointApplyReceiptHash = hash
        };
        var input = new DynamicTaskInput { Document = new DynamicDocumentDto { ProjectFingerprint = hash, SessionId = "session-exact" } };

        Program.ValidateCheckpointBinding(config, input);
        var evidence = Program.CheckpointBindingForEvidence(config);
        Assert.NotNull(evidence); Assert.Equal(7, evidence!.CheckpointIndex); Assert.False(evidence.AuthorizationGranted);
        input.Document.SessionId = "session-substituted";
        Assert.Throws<InvalidOperationException>(() => Program.ValidateCheckpointBinding(config, input));
        Assert.Throws<InvalidOperationException>(() => Program.ValidateCheckpointBinding(new LiveTaskConfig { CheckpointIndex = 1 }, input));
    }

    [Fact]
    public void ApplyGraphConvertsCamelWorkerWireToExactSnakeWire()
    {
        using var document = JsonDocument.Parse("""
            {"schema":"dynamic-revit-operation-graph/v0","inputHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operations":[{"operationId":"op","kind":"set_parameter","targetUniqueId":"target","vectorFeet":null,"parameter":"Comments","value":"marker"}],"graphHash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
            """);

        var graph = Program.GraphForApply(document.RootElement);
        var snake = JsonSerializer.Serialize(new { graph }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower });
        using var wire = JsonDocument.Parse(snake);
        var graphWire = wire.RootElement.GetProperty("graph");

        Assert.Equal(graph.GraphHash, graphWire.GetProperty("graph_hash").GetString());
        Assert.Equal("op", graphWire.GetProperty("operations")[0].GetProperty("operation_id").GetString());
        Assert.False(graphWire.TryGetProperty("graphHash", out _));
    }

    [Fact]
    public void RetentionKeepsOnlyNewestBoundedTaskDirectoriesAndDeletesReadOnlyTrees()
    {
        using var temporary = new TemporaryDirectory();
        var lane = temporary.CreateDirectory("tasks");
        var first = CreateTask(lane, '1', DateTime.UtcNow.AddMinutes(-3));
        var second = CreateTask(lane, '2', DateTime.UtcNow.AddMinutes(-2));
        var third = CreateTask(lane, '3', DateTime.UtcNow.AddMinutes(-1));
        Directory.CreateDirectory(Path.Combine(lane, "not-a-task"));

        TaskRetention.Prune(lane, TimeSpan.FromHours(1), 1, DateTimeOffset.UtcNow);

        Assert.False(Directory.Exists(first));
        Assert.False(Directory.Exists(second));
        Assert.True(Directory.Exists(third));
        Assert.True(Directory.Exists(Path.Combine(lane, "not-a-task")));
    }

    [Fact]
    public void RetentionDoesNotDeleteAWorkspaceWithAnActiveLease()
    {
        using var temporary = new TemporaryDirectory();
        var lane = temporary.CreateDirectory("tasks");
        var task = CreateTask(lane, 'a', DateTime.UtcNow.AddDays(-2));
        var marker = Path.Combine(task, ".active");
        using (new FileStream(marker, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
        {
            TaskRetention.Prune(lane, TimeSpan.FromHours(1), 0, DateTimeOffset.UtcNow);
            Assert.True(Directory.Exists(task));
        }

        TaskRetention.Prune(lane, TimeSpan.FromHours(1), 0, DateTimeOffset.UtcNow);
        Assert.False(Directory.Exists(task));
    }

    private static string CreateTask(string lane, char name, DateTime createdUtc)
    {
        var path = Directory.CreateDirectory(Path.Combine(lane, new string(name, 32))).FullName;
        var child = Path.Combine(path, "runtime-image", "worker.dll");
        Directory.CreateDirectory(Path.GetDirectoryName(child)!);
        File.WriteAllText(child, "runtime");
        File.SetAttributes(child, FileAttributes.ReadOnly);
        Directory.SetCreationTimeUtc(path, createdUtc);
        return path;
    }

    private static WorkerInput ExecutionWorkerInput(string source) => new()
    {
        Source = source,
        DeadlineMs = 10_000,
        Input = new DynamicTaskInput
        {
            Document = new DynamicDocumentDto { ProjectFingerprint = DynamicWire.Sha256("execution-worker-document"), SessionId = "execution-worker-session" },
            OperationBudget = 16
        },
        ResultReferenceDocumentRevision = 1
    };

    private static string Diagnostic(RevitOperator.DynamicRevitWorker.WorkerOutput output) =>
        string.Join("; ", output.Diagnostics.Select(value => value.Code + ":" + value.Message));

    private static DynamicStableReferenceV1 Reference(string kind, string uniqueId, long elementId) => new()
    {
        Kind = kind, StableId = "revit-element:" + uniqueId, UniqueId = uniqueId, ElementId = elementId
    };

    private static DynamicContextRuleRecordV1 RuleRecord(string project, long viewId, long issued) => new()
    {
        RecordId = "rule-office-annotation-1", CompanyId = "company-a", ProjectFingerprint = project, UserId = "user-a", ActiveViewElementId = viewId,
        TargetCategoryStableIds = new[] { "category:builtin:OST_ElectricalFixtures" },
        Conditions = new[] { new DynamicContextRuleConditionV1 { ParameterName = "Mark", ParameterIdentity = "parameter:builtin:-1001203", ParameterScope = "instance", Operator = "equals", ValueKind = "string", RawValue = "MATCH" } },
        Action = new DynamicContextRuleActionV1 { ParameterName = "Comments", ParameterIdentity = "parameter:builtin:-1001205", ParameterScope = "instance", ValueKind = "string", RawValue = "APPROVED" },
        IssuedUnixSeconds = issued, ExpiresUnixSeconds = issued + 3600
    };

    private sealed class TemporaryDirectory : IDisposable
    {
        private readonly string _path = Path.Combine(Path.GetTempPath(), "DynamicRevitSandboxSupervisor.Tests", Guid.NewGuid().ToString("N"));
        public TemporaryDirectory() => Directory.CreateDirectory(_path);
        public string CreateDirectory(string name) => Directory.CreateDirectory(Path.Combine(_path, name)).FullName;
        public void Dispose()
        {
            if (Directory.Exists(_path)) TaskRetention.SafeDeleteTree(_path);
        }
    }
}
