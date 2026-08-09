using System.Text.Json;
using RevitOperator.DynamicRevitSandboxSupervisor;
using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSandboxSupervisor.Tests;

public sealed class RuntimeWorkspaceTests
{
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

    private static DynamicStableReferenceV1 Reference(string kind, string uniqueId, long elementId) => new()
    {
        Kind = kind, StableId = "revit-element:" + uniqueId, UniqueId = uniqueId, ElementId = elementId
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
