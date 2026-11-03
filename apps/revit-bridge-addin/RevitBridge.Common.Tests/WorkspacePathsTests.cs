using System;
using System.IO;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    [CollectionDefinition("Workspace configuration", DisableParallelization = true)]
    public sealed class WorkspaceConfigurationCollection { }

    [Collection("Workspace configuration")]
    public sealed class WorkspacePathsTests
    {
        [Fact]
        public void Native_workspace_honors_the_same_explicit_root_as_sidecar_and_mcp()
        {
            using var f = new WorkspaceFixture();
            Assert.Equal(f.Root, WorkspacePaths.GetWorkspaceRoot());
            Assert.Equal(Path.Combine(f.Root, "artifacts", "exports"), WorkspacePaths.EnsureDir("artifacts", "exports"));
            Assert.True(Directory.Exists(Path.Combine(f.Root, "artifacts", "exports")));
        }

        [Fact]
        public void Configured_root_keeps_traversal_and_sibling_prefixes_outside_the_workspace()
        {
            using var f = new WorkspaceFixture();
            Assert.Equal(Path.Combine(f.Root, "evidence.json"), WorkspacePaths.ResolveFileUnderWorkspace("evidence.json"));
            Assert.Throws<UnauthorizedAccessException>(() => WorkspacePaths.ResolveFileUnderWorkspace("..\\outside.json"));
            Assert.Throws<UnauthorizedAccessException>(() => WorkspacePaths.ResolveFileUnderWorkspace(f.Root + "-other\\outside.json"));
        }

        [Fact]
        public void Native_grant_reader_and_renewer_share_the_configured_file_without_changing_authority()
        {
            using var f = new WorkspaceFixture();
            var grantFile = Path.Combine(f.Root, "write_grant.json");
            var writer = new OperatorWriteGrantStore(grantFile, "workspace-fixture-only");
            var grant = writer.Issue(OperatorWriteGrantMode.Session, TimeSpan.FromMinutes(15));
            var native = new OperatorWriteGrantStore(Path.Combine(WorkspacePaths.GetWorkspaceRoot(), "write_grant.json"), "workspace-fixture-only");
            Assert.True(native.ValidateAndConsumeIfNeeded(grant.Token, out var error), error);
            Assert.Equal(grant.Token, native.RenewSession(TimeSpan.FromMinutes(15)).Token);
            Assert.True(writer.ValidateAndConsumeIfNeeded(grant.Token, out error), error);
            Assert.False(native.ValidateAndConsumeIfNeeded("foreign-token", out _));
        }

        [Theory]
        [InlineData("relative-workspace")]
        [InlineData("C:drive-relative")]
        [InlineData("\\root-relative")]
        public void Ambiguous_relative_configuration_fails_instead_of_splitting_workspaces(string root)
        {
            using var f = new WorkspaceFixture();
            Environment.SetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT", root);
            Assert.Throws<InvalidOperationException>(() => WorkspacePaths.GetWorkspaceRoot());
        }

        [Fact]
        public void Default_workspace_remains_the_existing_per_user_location()
        {
            using var f = new WorkspaceFixture();
            Environment.SetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT", null);
            Assert.Equal(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitOperator", "Workspace"), WorkspacePaths.GetWorkspaceRoot());
        }

        private sealed class WorkspaceFixture : IDisposable
        {
            private readonly string? previous = Environment.GetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT");
            public string Root { get; } = Path.Combine(Path.GetTempPath(), "operator-workspace-paths-" + Guid.NewGuid().ToString("N"));
            public WorkspaceFixture()
            {
                Directory.CreateDirectory(Root);
                Environment.SetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT", Root);
            }
            public void Dispose()
            {
                Environment.SetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT", previous);
                var exact = Path.GetFullPath(Root);
                var temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
                if (!string.Equals(Path.GetDirectoryName(exact), temp, StringComparison.OrdinalIgnoreCase)
                    || !Path.GetFileName(exact).StartsWith("operator-workspace-paths-", StringComparison.Ordinal))
                    throw new InvalidOperationException("Refusing unexpected test cleanup target.");
                Directory.Delete(exact, true);
            }
        }
    }
}
