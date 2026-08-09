using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class LauncherPackageIdentityTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "dynamic-launcher-identity-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void Identity_changes_when_any_executable_dependency_or_manifest_changes()
    {
        var dependencies = new Dictionary<string, string>
        {
            ["DynamicRevitSandboxSupervisor.exe"] = "native-apphost",
            ["DynamicRevitSandboxSupervisor.dll"] = "supervisor",
            ["DynamicRevitSandboxSupervisor.deps.json"] = "deps",
            ["DynamicRevitSandboxSupervisor.runtimeconfig.json"] = "runtime",
            ["DynamicRevitSdk.dll"] = "sdk",
            ["DynamicRevit.RuntimePackaging.dll"] = "packaging",
            ["System.IO.Pipes.AccessControl.dll"] = "pipe-access",
            ["manifests/revit-host-capabilities.v1.json"] = "capabilities",
            ["manifests/sandbox-policy.v1.json"] = "policy",
            ["manifests/dynamic-revit-observations-core.v1.json"] = "observations",
            ["manifests/dynamic-revit-building-systems-observations.v1.json"] = "building-systems-observations",
            ["manifests/dynamic-revit-operations-core.v1.json"] = "operations",
            ["manifests/dynamic-revit-result-reference-graph.v1.json"] = "result-reference",
            ["manifests/dynamic-revit-annotation-operations.v1.json"] = "annotation-operations"
        };
        WritePackage(dependencies);
        var baseline = DynamicRuntimePackageDirectoryIdentity.Compute(_root);
        Assert.Matches("^sha256:[0-9a-f]{64}$", baseline);

        foreach (var dependency in dependencies.Keys)
        {
            var path = Path.Combine(_root, dependency.Replace('/', Path.DirectorySeparatorChar));
            var original = File.ReadAllText(path);
            File.WriteAllText(path, original + "-tampered");
            Assert.NotEqual(baseline, DynamicRuntimePackageDirectoryIdentity.Compute(_root));
            File.WriteAllText(path, original);
            Assert.Equal(baseline, DynamicRuntimePackageDirectoryIdentity.Compute(_root));
        }
    }

    [Fact]
    public void Identity_is_deterministic_and_includes_unanticipated_regular_files()
    {
        WritePackage(new Dictionary<string, string> { ["z.dll"] = "z", ["nested/a.json"] = "a" });
        var first = DynamicRuntimePackageDirectoryIdentity.Compute(_root);
        var second = DynamicRuntimePackageDirectoryIdentity.Compute(_root);
        File.WriteAllText(Path.Combine(_root, "injected.bin"), "injected");

        Assert.Equal(first, second);
        Assert.NotEqual(first, DynamicRuntimePackageDirectoryIdentity.Compute(_root));
    }

    [Fact]
    public void Identity_rejects_reparse_point_entries_when_supported_by_host()
    {
        WritePackage(new Dictionary<string, string> { ["supervisor.exe"] = "launcher" });
        var target = Path.Combine(_root, "supervisor.exe");
        var link = Path.Combine(_root, "linked.dll");
        try { File.CreateSymbolicLink(link, target); }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException or PlatformNotSupportedException) { return; }

        Assert.Throws<InvalidDataException>(() => DynamicRuntimePackageDirectoryIdentity.Compute(_root));
    }

    [Fact]
    public void Identity_rejects_unbounded_file_sets()
    {
        Directory.CreateDirectory(_root);
        for (var index = 0; index <= DynamicRuntimePackageDirectoryIdentity.MaximumFileCount; index++) File.WriteAllText(Path.Combine(_root, $"dependency-{index:D3}.dll"), "x");

        Assert.Throws<InvalidDataException>(() => DynamicRuntimePackageDirectoryIdentity.Compute(_root));
    }

    private void WritePackage(IReadOnlyDictionary<string, string> files)
    {
        Directory.CreateDirectory(_root);
        foreach (var file in files)
        {
            var path = Path.Combine(_root, file.Key.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, file.Value);
        }
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }
}
